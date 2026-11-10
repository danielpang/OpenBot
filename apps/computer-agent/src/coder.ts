import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, chown, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import type { RawData, WebSocket } from 'ws';
import { SUBSCRIPTION_BRIDGE, SUBSCRIPTION_CANCEL_GRACE_MS } from '@openbots/shared';
import {
  coderConfigEnv,
  CODER_AGENT_DIRS,
  CODER_CONFIG_ENV,
  coderPaths,
  CODER_CREDENTIAL_SOCKET_ENV,
  CODER_SESSION_DIR_ENV,
  CODER_SESSION_ENV,
  CODER_SOCKET_ENV,
  CREDENTIAL_SOCKET,
  GIT_CREDENTIAL_HELPER,
  gitConfigEnv,
  isSafeDirectory,
  PERMISSION_SOCKET,
  sessionSafeDirectories,
  type CoderPaths,
  type CredentialRelayReply,
  type PermissionRelayReply,
  type PermissionRelayRequest,
} from './coder-paths.js';
import { childEnv } from './config.js';
import { resolveCwd } from './paths.js';
import {
  CoderClientMessageSchema,
  GitCredentialRequestSchema,
  type CoderServerMessage,
  type CoderStart,
} from './protocol.js';
import { loadPty, type NodePty } from './pty.js';
import {
  BOT_CODERS,
  CODER,
  CODERS_GID,
  RUNNER,
  UNPRIVILEGED,
  type Identity,
  type Users,
} from './users.js';

// `WS /coder` (protocol.ts, I3): a coding agent, its login, or the owner's
// own command in a session's worktree, or the server's own git operation,
// shaped like WS /mcp/stdio (mcp-stdio.ts). The first frame is `start`; the
// process runs as the coder user (or the bot user with the coders group, for
// `user: 'bot'`, or the runner user, for `user: 'runner'`), in its own
// process group, in a worktree under the home, with a directory of its own
// under `<runtimeDir>/coders/<session_id>`. That directory also holds the
// permission relay's socket (I11): the permission MCP server
// (coder-permission-mcp.ts), which Claude Code starts inside the session,
// asks there and the request goes to the server as `permission_request`.
// Beside it is the credential relay's socket (I5): git's credential helper
// (git-credential-helper.ts) writes git's question there with the session's
// secret, and the agent turns it into a `credential_request` on this socket.
//
// The secret: at `start` the agent mints 32 random bytes for the process and
// puts them in its `OPENBOTS_CODER_SESSION`; the relay answers only a request
// that carries them. It is not the server's session id, which the Bot's own
// shell can learn (widget props, tool results) and which only names the
// directory. The sockets are the coders group's, 0660, so the bot user's
// processes reach them too; the secret is what they lack. What it does not
// close: processes of the same uid can read each other's environment
// (/proc/<pid>/environ), so a process of one coder session can take the
// secret of another session running at the same time as the same user.
// Per-session uids would close that (TECHNICAL_PLAN
// 22.13).
//
// The server's own git operations (clone, fetch, scan, reconcile, rescue
// pushes) carry credentials for any of the owner's repositories, so they run
// as the runner user (`user: 'runner'`, users.ts), never as coder: no coding
// session can read their environment. Their directory is made like any other
// (2770, the coders group), so the credential helper, running as the runner,
// reaches its socket; a coder session, in the same group, could too, but the
// directory's name is unguessable (the sessions directory is 1730: nobody
// may list it) and the secret the relay asks for is in an environment only
// the runner uid can read. The runner gets no agent config directories.
//
// The start's `args` and `env` carry prompts, tokens and the vendor's keys:
// they go to `spawn` and nowhere else. Nothing here logs them, or the secret.
// Closing the socket, from either side, or the process's exit, sends SIGTERM
// to the whole group, then SIGKILL, so what it left running in the background
// goes too, and removes the session's directory.

/** What a session id may look like: it names a directory, so no `/` and no `..`. */
export const CODER_SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** How long git's helper waits on the server for a credential before it is refused. */
export const CREDENTIAL_TIMEOUT_MS = 30_000;

/** The longest unix socket path Linux takes (`sun_path`, 108 with its NUL). */
const MAX_SOCKET_PATH = 107;

interface LiveSession {
  stop(): void;
}

/** The running sessions by id, so one id runs once, and for shutdown. */
export class CoderSessions {
  private readonly live = new Map<string, LiveSession>();

  get size(): number {
    return this.live.size;
  }

  has(id: string): boolean {
    return this.live.has(id);
  }

  /** Claims `id` for `session`; false when another session holds it. */
  add(id: string, session: LiveSession): boolean {
    if (this.live.has(id)) return false;
    this.live.set(id, session);
    return true;
  }

  delete(id: string, session: LiveSession): void {
    if (this.live.get(id) === session) this.live.delete(id);
  }

  stopAll(): void {
    for (const session of [...this.live.values()]) session.stop();
  }
}

/** The agent's sessions; ws.ts and app.ts share it unless given their own. */
export const coderSessions = new CoderSessions();

export interface CoderDeps {
  home: string;
  /** Scratch space; the sessions' directories go in `<runtimeDir>/coders`. */
  runtimeDir?: string;
  /** The state volume; the agents' config directories are in `<stateDir>/coders`. */
  stateDir?: string;
  users?: Users;
  sessions?: CoderSessions;
  /** How long a credential request waits on the server (CREDENTIAL_TIMEOUT_MS). */
  credentialTimeoutMs?: number;
  loadPty?: () => Promise<NodePty | undefined>;
  /** Structured log lines; given the command's name, the user and the pid only. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** How long the socket may stay open without a `start`. */
  startTimeoutMs?: number;
  /** From SIGTERM to SIGKILL once the socket closes. */
  graceMs?: number;
}

/** What a session's process takes, whether it runs on pipes or a pty. */
interface Running {
  pid: number;
  write(data: string): void;
  end(): void;
  resize(cols: number, rows: number): void;
}

class StartError extends Error {
  constructor(
    message: string,
    readonly code = 1011,
  ) {
    super(message);
  }
}

const signalName = (n: number | undefined): string | null => {
  if (!n) return null;
  const found = Object.entries(osConstants.signals).find(([, v]) => v === n);
  return found ? found[0] : `SIG${n}`;
};

/**
 * Who a session's process runs as, its HOME, and the agents' config
 * directory variables: set for the coder user and the bot user, cleared for
 * the runner, whatever the start's `env` says.
 */
export function sessionUser(
  user: CoderStart['user'],
  paths: CoderPaths,
  home: string,
): { identity: Identity; home: string; configEnv: Record<string, string | undefined> } {
  switch (user) {
    case 'coder':
      // The coder user's own home on the state volume, which it may write.
      return { identity: CODER, home: paths.homeDir, configEnv: coderConfigEnv(paths) };
    case 'runner':
      return {
        identity: RUNNER,
        home: paths.runnerHomeDir,
        configEnv: Object.fromEntries(
          CODER_AGENT_DIRS.map((a) => [CODER_CONFIG_ENV[a], undefined]),
        ),
      };
    case 'bot':
      return { identity: BOT_CODERS, home, configEnv: coderConfigEnv(paths) };
  }
}

/** One process per socket: `start` runs it, the socket's close stops it. */
export function coderSession(ws: WebSocket, deps: CoderDeps): void {
  const users = deps.users ?? UNPRIVILEGED;
  const sessions = deps.sessions ?? coderSessions;
  const paths = coderPaths(
    deps.runtimeDir ?? '/tmp/openbots',
    deps.stateDir ?? '/var/lib/openbots',
  );
  // In the image the session's directory and socket are the coders group's,
  // which the agent keeps (privileges.ts `dropToBot`); elsewhere the agent's own.
  const group = users.privileged ? CODERS_GID : undefined;
  let grace = deps.graceMs ?? 2000;

  const send = (msg: CoderServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (message: string, code = 1011) => {
    send({ type: 'error', message });
    ws.close(code, message.slice(0, 120));
  };

  let running: Running | undefined;
  let started = false;
  /** Input that came before the process ran. */
  const pending: { data: string; end: boolean }[] = [];
  let exited = false;
  let stopping = false;
  let sessionId: string | undefined;
  let sessionDir: string | undefined;
  let permissions: Server | undefined;
  let credentialRelay: Server | undefined;
  /** Permission prompts waiting on the server's `answer`, by request id. */
  const prompts = new Map<string, Socket>();
  /** Credential requests waiting on the server's `credential`, by request id. */
  const credentials = new Map<string, (answer: CredentialRelayReply) => void>();
  /** What git's helper must send (CODER_SESSION_ENV): this process's alone, never logged. */
  const secret = Buffer.from(randomBytes(32).toString('base64url'));
  const credentialTimeout = deps.credentialTimeoutMs ?? CREDENTIAL_TIMEOUT_MS;

  const live: LiveSession = {
    stop: () => {
      ws.close(1001, 'The computer is shutting down');
      stop();
    },
  };

  /**
   * Signals the process group, whether or not its leader is still there:
   * what it started in the background (`npm run dev &`) is in the group too.
   */
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!running) return;
    try {
      process.kill(-running.pid, signal);
    } catch (err) {
      // ESRCH: nobody is left in the group.
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        deps.log?.('coder session not signalled', { signal, error: String(err) });
      }
    }
  };

  const reply = (conn: Socket, answer: PermissionRelayReply) => {
    conn.end(`${JSON.stringify(answer)}\n`);
  };

  /** Ends the relays and gives the session id back; the directory goes once the process has. */
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    permissions?.close();
    credentialRelay?.close();
    for (const conn of prompts.values())
      reply(conn, { decision: 'deny', message: 'The session ended' });
    prompts.clear();
    for (const settle of [...credentials.values()]) settle({ denied: 'The session ended' });
    if (sessionId) sessions.delete(sessionId, live);
  };
  let removed = false;
  const removeDir = () => {
    if (removed || !sessionDir) return;
    removed = true;
    void rm(sessionDir, { recursive: true, force: true }).catch((err: unknown) =>
      deps.log?.('coder session directory not removed', { error: String(err) }),
    );
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(startTimer);
    release();
    if (!running) return removeDir();
    // Even after the leader exited: its background processes are still in the group.
    signalGroup('SIGTERM');
    setTimeout(() => {
      signalGroup('SIGKILL');
      // Whatever it left behind; the process group is gone by now.
      setTimeout(removeDir, 100).unref();
    }, grace).unref();
  };

  const startTimer = setTimeout(
    () => fail('No start message', 1008),
    deps.startTimeoutMs ?? 10_000,
  );
  startTimer.unref();

  /** A relay's unix socket, which the session's user may reach. */
  const listen = (file: string, onConnection: (conn: Socket) => void) =>
    new Promise<Server>((resolve, reject) => {
      const server = createServer(onConnection);
      server.once('error', reject);
      server.listen(file, () => {
        server.off('error', reject);
        void (async () => {
          // The session's user must reach it: the coders group in the image.
          if (group !== undefined) await chown(file, process.geteuid?.() ?? -1, group);
          await chmod(file, group !== undefined ? 0o660 : 0o600);
        })().then(
          () => resolve(server),
          (err: unknown) => {
            server.close();
            reject(err as Error);
          },
        );
      });
    });

  /** The permission relay (I11): one JSON line in, one JSON line back, per connection. */
  const listenForPrompts = (file: string) =>
    listen(file, (conn) => {
      conn.setEncoding('utf8');
      let buffer = '';
      let id: string | undefined;
      conn.on('data', (chunk: string) => {
        if (id) return;
        buffer += chunk;
        if (buffer.length > 1_000_000) return void conn.destroy();
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        let request: PermissionRelayRequest;
        try {
          request = JSON.parse(buffer.slice(0, nl)) as PermissionRelayRequest;
        } catch {
          return reply(conn, { decision: 'deny', message: 'Not a permission request' });
        }
        if (typeof request?.tool_name !== 'string' || request.tool_name === '') {
          return reply(conn, { decision: 'deny', message: 'Not a permission request' });
        }
        if (released) return reply(conn, { decision: 'deny', message: 'The session ended' });
        id = randomUUID();
        prompts.set(id, conn);
        send({
          type: 'permission_request',
          request_id: id,
          tool_name: request.tool_name.slice(0, 200),
          input: request.input ?? {},
        });
      });
      conn.on('close', () => {
        if (id) prompts.delete(id);
      });
      conn.on('error', () => {
        // The MCP server went away; `close` follows.
      });
    });

  const secretMatches = (given: string) => {
    const bytes = Buffer.from(given);
    return bytes.length === secret.length && timingSafeEqual(bytes, secret);
  };

  /**
   * The credential relay (I5): git's helper writes one JSON line, git's
   * question and the session's secret; the server's answer goes back as one
   * JSON line, a username and password or why not, and the connection closes.
   */
  const listenForCredentials = (file: string) =>
    listen(file, (conn) => {
      conn.setEncoding('utf8');
      let buffer = '';
      let id: string | undefined;
      const answer = (out: CredentialRelayReply) => conn.end(`${JSON.stringify(out)}\n`);
      conn.on('data', (chunk: string) => {
        if (id !== undefined) return;
        buffer += chunk;
        if (buffer.length > 16_000) return void conn.destroy();
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        id = '';
        let parsed;
        try {
          parsed = GitCredentialRequestSchema.safeParse(JSON.parse(buffer.slice(0, nl)));
        } catch {
          return answer({ denied: 'Not a credential request' });
        }
        if (!parsed.success) return answer({ denied: 'Not a credential request' });
        const request = parsed.data;
        if (!secretMatches(request.secret)) return answer({ denied: 'Not this session' });
        if (released || exited) return answer({ denied: 'The session ended' });
        id = randomUUID();
        const requestId = id;
        const timer = setTimeout(() => {
          // A stuck relay shows here: the request went out and nothing came back.
          deps.log?.('coder credential request timed out', {
            session_id: sessionId,
            request_id: requestId,
            host: request.host,
            timeout_ms: credentialTimeout,
          });
          settle({ denied: 'The server did not answer in time' });
        }, credentialTimeout);
        timer.unref();
        function settle(out: CredentialRelayReply) {
          clearTimeout(timer);
          credentials.delete(requestId);
          answer(out);
        }
        credentials.set(requestId, settle);
        send({
          type: 'credential_request',
          request_id: requestId,
          protocol: request.protocol,
          host: request.host,
          ...(request.path !== undefined ? { path: request.path } : {}),
          ...(request.username !== undefined ? { username: request.username } : {}),
        });
      });
      conn.on('close', () => {
        if (id) credentials.delete(id);
      });
      conn.on('error', () => {
        // git gave up; `close` follows.
      });
    });

  const finish = (code: number | null, signal: string | null, command: string, pid: number) => {
    if (exited) return;
    exited = true;
    deps.log?.('coder session exited', { command, pid, code, signal });
    send({ type: 'exit', code, signal });
    release();
    removeDir();
    if (ws.readyState === ws.OPEN) ws.close(1000);
  };

  const start = async (msg: CoderStart) => {
    if (msg.command === 'node' && msg.args[0] === SUBSCRIPTION_BRIDGE)
      grace = Math.max(grace, SUBSCRIPTION_CANCEL_GRACE_MS);
    clearTimeout(startTimer);
    if (!CODER_SESSION_ID.test(msg.session_id)) {
      throw new StartError('Not a valid session id', 1008);
    }
    if (!sessions.add(msg.session_id, live)) {
      throw new StartError('That session is already running', 1008);
    }
    sessionId = msg.session_id;
    const id = msg.session_id;
    const cwd = await resolveCwd(deps.home, msg.cwd);
    if (msg.safe_directories?.some((dir) => !isSafeDirectory(deps.home, dir))) {
      throw new StartError('A safe directory must be an absolute path under the home', 1008);
    }
    const safe = msg.safe_directories ?? sessionSafeDirectories(deps.home, cwd);
    const dir = path.join(paths.sessionsDir, id);
    const socket = path.join(dir, PERMISSION_SOCKET);
    const credentialSocket = path.join(dir, CREDENTIAL_SOCKET);
    if (
      Math.max(Buffer.byteLength(socket), Buffer.byteLength(credentialSocket)) > MAX_SOCKET_PATH
    ) {
      throw new StartError('The session directory path is too long for its socket');
    }
    // In the image layOut made it; on a dev machine it may be missing.
    await mkdir(paths.sessionsDir, { recursive: true, mode: 0o700 });
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { mode: 0o700 });
    sessionDir = dir;
    if (group !== undefined) {
      await chown(dir, process.geteuid?.() ?? -1, group);
      await chmod(dir, 0o2770);
    }
    permissions = await listenForPrompts(socket);
    if (stopping) return release();
    if (msg.git_credentials) {
      credentialRelay = await listenForCredentials(credentialSocket);
      if (stopping) return release();
    }

    const fill = (value: string) =>
      value
        .replaceAll('{{session_dir}}', dir)
        .replaceAll('{{session_id}}', id)
        .replaceAll('{{home}}', deps.home);
    // Not after `--`: the server puts the prompt there, which is the owner's text.
    const literal = msg.args.indexOf('--');
    const args = msg.args.map((a, i) => (literal >= 0 && i >= literal ? a : fill(a)));
    const extra = Object.fromEntries(Object.entries(msg.env).map(([k, v]) => [k, fill(v)]));
    const who = sessionUser(msg.user, paths, deps.home);
    const env = childEnv({ HOME: deps.home }, extra, {
      HOME: who.home,
      // The secret, never the server's session id (see the top of this file).
      [CODER_SESSION_ENV]: msg.git_credentials ? secret.toString() : undefined,
      [CODER_CREDENTIAL_SOCKET_ENV]: msg.git_credentials ? credentialSocket : undefined,
      [CODER_SESSION_DIR_ENV]: dir,
      [CODER_SOCKET_ENV]: socket,
      ...who.configEnv,
      ...gitConfigEnv(
        childEnv(extra),
        msg.git_credentials ? GIT_CREDENTIAL_HELPER : undefined,
        safe,
      ),
    });
    // umask 002, for every user (the runner's clones too): what one user
    // writes in a worktree, the others may change, through the coders group
    // the repositories directory gives every file.
    const program = users.command(who.identity, '/bin/sh', [
      '-c',
      'umask 002 && exec "$0" "$@"',
      msg.command,
      ...args,
    ]);
    const name = path.basename(msg.command);

    if (msg.pty) {
      const nodePty = await (deps.loadPty ?? loadPty)();
      if (!nodePty) throw new StartError('This computer has no terminals (node-pty is missing)');
      if (stopping) return;
      const term = nodePty.spawn(program.command, program.args, {
        name: 'xterm-256color',
        cols: msg.cols ?? 80,
        rows: msg.rows ?? 24,
        cwd,
        env: Object.fromEntries(
          Object.entries({ ...env, TERM: 'xterm-256color' }).filter(
            (e): e is [string, string] => e[1] !== undefined,
          ),
        ),
      });
      const pid = term.pid ?? 0;
      running = {
        pid,
        write: (data) => term.write(data),
        // A terminal's end of input: ^D at the start of a line.
        end: () => term.write('\x04'),
        resize: (cols, rows) => term.resize(cols, rows),
      };
      term.onData((data) => send({ type: 'stdout', data }));
      term.onExit(({ exitCode, signal }) =>
        finish(signal ? null : exitCode, signalName(signal), name, pid),
      );
      deps.log?.('coder session started', { command: name, user: msg.user, pid, pty: true });
      started = true;
      send({ type: 'started', pid, session_dir: dir });
    } else {
      const child = spawn(program.command, program.args, {
        cwd,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.on('error', () => {
        // It exited without reading what was left; `exit` reports it.
      });
      child.stdout.setEncoding('utf8').on('data', (data: string) => send({ type: 'stdout', data }));
      child.stderr.setEncoding('utf8').on('data', (data: string) => send({ type: 'stderr', data }));
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', (err) => {
          if (!started) reject(new StartError(`Could not start ${name}: ${err.message}`));
        });
      });
      const pid = child.pid!;
      running = {
        pid,
        write: (data) => child.stdin.write(data),
        end: () => child.stdin.end(),
        resize: () => {},
      };
      // `close` comes once the output is drained; a child that still holds
      // the pipes would hold it back, so after `exit` report it anyway.
      child.once('close', (code, signal) => finish(code, signal, name, pid));
      child.once('exit', (code, signal) => {
        setTimeout(() => finish(code, signal, name, pid), 250).unref();
      });
      deps.log?.('coder session started', { command: name, user: msg.user, pid });
      started = true;
      send({ type: 'started', pid, session_dir: dir });
      // The socket closed while it started: nobody is left to read it.
      if (stopping) return signalGroup('SIGKILL');
    }
    for (const input of pending.splice(0)) {
      running.write(input.data);
      if (input.end) running.end();
    }
  };

  let startRequested = false;
  ws.on('message', (raw: RawData) => {
    let parsed;
    try {
      parsed = CoderClientMessageSchema.safeParse(JSON.parse(raw.toString()));
    } catch {
      return fail('Frames must be JSON', 1007);
    }
    if (!parsed.success) return fail('Not a valid coder message', 1007);
    const msg = parsed.data;
    if (!startRequested && msg.type !== 'start') return fail('The first frame must be start', 1008);
    switch (msg.type) {
      case 'start':
        if (startRequested) return fail('Already started', 1008);
        startRequested = true;
        start(msg).catch((err: unknown) => {
          const code = err instanceof StartError ? err.code : 1011;
          fail(err instanceof Error ? err.message : 'Could not start the session', code);
        });
        return;
      case 'stdin':
        if (!running) pending.push({ data: msg.data, end: msg.end === true });
        else if (!exited) {
          running.write(msg.data);
          if (msg.end) running.end();
        }
        return;
      case 'signal':
        return signalGroup(msg.signal);
      case 'resize':
        return running?.resize(msg.cols, msg.rows);
      case 'answer': {
        const conn = prompts.get(msg.request_id);
        if (!conn) return;
        prompts.delete(msg.request_id);
        return reply(conn, {
          decision: msg.decision,
          ...(msg.message !== undefined ? { message: msg.message } : {}),
        });
      }
      case 'credential': {
        const settle = credentials.get(msg.request_id);
        if (!settle) return;
        if (msg.denied !== undefined || msg.username === undefined || msg.password === undefined) {
          return settle({ denied: msg.denied ?? 'No credential' });
        }
        return settle({ username: msg.username, password: msg.password });
      }
    }
  });
  ws.on('close', stop);
  ws.on('error', stop);
}
