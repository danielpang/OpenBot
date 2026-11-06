import type {
  BrowserActionInput,
  BrowserActionName,
  BrowserResult,
  CoderClientMessageInput,
  CoderServerMessage,
  CoderStartInput,
  CookieSyncResult,
  ExecEvent,
  ExecRequest,
  FsEntry,
  FsListing,
  InputAction as AgentInputAction,
  McpStdioServerMessage,
  McpStdioStart,
  ScreenInfo,
} from '@openbots/computer-agent/protocol';
import { WebSocket, type RawData } from 'ws';
import type { InputAction } from './actions.js';
import { COMPUTER_HOME } from './types.js';

// The HTTP client for the control agent inside the computer (plan 9.3), whose
// wire format is `@openbots/computer-agent/protocol`. Every request carries
// `Authorization: Bearer <agent token>`; errors are problem documents, thrown
// here as `AgentError` with their `detail` and `code`.
//
// Paths: the agent's `/fs` is relative to its home; this client takes
// absolute paths under /home/bot (as the tools and the file browser use them)
// and refuses others. Screens are addressed by number `n` (display `:10+n`).

export type { CookieSyncResult, ExecRequest, ScreenInfo };

export interface ExecResult {
  /** -1 when the command was killed by a signal. */
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ExecChunk = { type: 'stdout' | 'stderr'; data: string };

export interface DirEntry {
  name: string;
  /** Absolute, under /home/bot. */
  path: string;
  type: FsEntry['type'];
  size: number;
  /** ISO timestamp. */
  mtime: string;
}

export interface DirListing {
  /** Absolute, under /home/bot. */
  path: string;
  entries: DirEntry[];
}

/** What `mcpStdio` starts: a connector's stdio MCP server, in the computer. */
export type McpStdioLaunch = Omit<McpStdioStart, 'type'>;

/** How a stdio MCP server in the computer ended. */
export interface McpStdioExit {
  exitCode: number | null;
  signal: string | null;
  /** Set when it never ran or the connection to the agent dropped. */
  error?: string;
}

export interface McpStdioHandlers {
  stdout(data: string): void;
  stderr(data: string): void;
  /** Called once, when the process ends or the connection to it drops. */
  exit(info: McpStdioExit): void;
}

/** A running stdio MCP server in the computer. */
export interface McpStdioProcess {
  pid: number;
  /** Writes to its stdin; throws once it ended. */
  write(data: string): void;
  /** Closes the connection, which stops the process; resolves once closed. */
  close(): Promise<void>;
}

/**
 * What `coder` starts (I3): a coding agent, or its login, as the `coder`
 * user in the computer. The defaults (`user: 'coder'`, no args, no env, no
 * pty, the credential helper on) are the agent's.
 */
export type CoderLaunch = Omit<CoderStartInput, 'type'>;

type CoderFrame<T extends CoderServerMessage['type']> = Omit<
  Extract<CoderServerMessage, { type: T }>,
  'type'
>;

/** git asks for a credential through the helper; answer with `CoderProcess.credential`. */
export type CoderCredentialRequest = CoderFrame<'credential_request'>;
/** The permission MCP server relays an agent's prompt; answer with `CoderProcess.answer`. */
export type CoderPermissionRequest = CoderFrame<'permission_request'>;
export type CoderCredentialAnswer = Omit<
  Extract<CoderClientMessageInput, { type: 'credential' }>,
  'type'
>;
export type CoderPermissionAnswer = Omit<
  Extract<CoderClientMessageInput, { type: 'answer' }>,
  'type'
>;
export type CoderSignal = Extract<CoderClientMessageInput, { type: 'signal' }>['signal'];

/** How a coding session's process ended. */
export interface CoderExit {
  code: number | null;
  signal: string | null;
  /** Set when it never ran or the connection to the agent dropped. */
  error?: string;
}

export interface CoderHandlers {
  stdout(data: string): void;
  stderr(data: string): void;
  credentialRequest(request: CoderCredentialRequest): void;
  permissionRequest(request: CoderPermissionRequest): void;
  /** Called once, when the process ends, fails to start, or the connection to it drops. */
  exit(info: CoderExit): void;
  /** The agent's own `error` frame, before the `exit` that follows it. */
  error?(message: string): void;
}

/** A coding session's process in the computer, over `WS /coder`. */
export interface CoderProcess {
  /** Resolves once the agent says the process runs; rejects with an `AgentError` if it never does. */
  started: Promise<{ pid: number; sessionDir: string }>;
  /**
   * Writes to its stdin (or its terminal, with `pty`); with `end`, closes
   * stdin after it. Throws once it ended.
   */
  write(data: string, options?: { end?: boolean }): void;
  /**
   * Closes its stdin: `claude -p` and `codex exec` read a piped stdin to its
   * end before they start, so a one-shot run calls this once it wrote all.
   */
  end(): void;
  credential(answer: CoderCredentialAnswer): void;
  answer(decision: CoderPermissionAnswer): void;
  signal(signal: CoderSignal): void;
  resize(cols: number, rows: number): void;
  /** Closes the connection, which stops the process group; resolves once closed. */
  close(): Promise<void>;
}

export type PageInfo = BrowserResult;
export type PageSnapshot = BrowserResult & { snapshot: string };

export type BrowserAction = {
  // `snapshot` takes no fields (its input is `Record<string, never>`).
  [A in BrowserActionName]: string extends keyof BrowserActionInput<A>
    ? { action: A }
    : { action: A } & BrowserActionInput<A>;
}[BrowserActionName];

export interface ComputerAgentClient {
  readonly url: string;
  health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string }>;
  exec(
    request: ExecRequest,
    options?: { signal?: AbortSignal; onChunk?(chunk: ExecChunk): void },
  ): Promise<ExecResult>;
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** A streaming read for downloads. */
  openFile(path: string, signal?: AbortSignal): Promise<Response>;
  writeFile(
    path: string,
    body: Uint8Array | string,
    signal?: AbortSignal,
  ): Promise<{ size: number }>;
  deleteFile(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void>;
  list(path: string, signal?: AbortSignal): Promise<DirListing>;
  startScreen(
    /** `fresh`: start from an empty Chromium profile, restarting the screen if it runs. */
    screen: { n: number; width?: number; height?: number; fresh?: boolean },
    signal?: AbortSignal,
  ): Promise<ScreenInfo>;
  stopScreen(n: number, signal?: AbortSignal): Promise<void>;
  screenshot(n: number, signal?: AbortSignal): Promise<Uint8Array>;
  input(n: number, action: InputAction, signal?: AbortSignal): Promise<void>;
  browser<T extends BrowserResult = BrowserResult>(
    n: number,
    action: BrowserAction,
    signal?: AbortSignal,
  ): Promise<T>;
  setWallpaper(hour?: number, signal?: AbortSignal): Promise<void>;
  /**
   * Exports screen `screen`'s cookies, or every running screen's, into the
   * computer's shared store now and spreads them to the other screens (K1).
   */
  syncCookies(screen?: number, signal?: AbortSignal): Promise<CookieSyncResult>;
  /**
   * Starts a stdio MCP server in the computer over `WS /mcp/stdio` and
   * resolves once it runs; `handlers` get its output and its end.
   */
  mcpStdio(
    launch: McpStdioLaunch,
    handlers: McpStdioHandlers,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<McpStdioProcess>;
  /**
   * Starts a coding session's process over `WS /coder` (I3) and resolves
   * once the socket is open and `start` sent; `started` says when it runs.
   * Rejects when the agent refuses the socket or cannot be reached.
   */
  coder(
    start: CoderLaunch,
    handlers: CoderHandlers,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<CoderProcess>;
  /** The WebSocket URL and headers the server's proxies dial (`/pty`, `/vnc/:n`, `/coder`). */
  socket(path: `/pty${string}` | `/vnc/${number}` | `/coder${string}`): {
    url: string;
    headers: Record<string, string>;
  };
}

export class AgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export interface AgentClientOptions {
  url: string;
  token: string;
  /** Per-request timeout for everything but `exec`, which has its own. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Slack on top of an exec's own timeout before the client gives up on the agent. */
const EXEC_GRACE_MS = 10_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

export function createAgentClient({
  url,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetch: doFetch = fetch,
}: AgentClientOptions): ComputerAgentClient {
  const base = url.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${token}` };

  async function request(
    method: string,
    path: string,
    init: {
      body?: RequestInit['body'];
      json?: unknown;
      signal?: AbortSignal | undefined;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const signals = [AbortSignal.timeout(init.timeoutMs ?? timeoutMs)];
    if (init.signal) signals.push(init.signal);
    const headers: Record<string, string> = { ...auth };
    let body = init.body;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (body !== undefined) {
      headers['content-type'] = 'application/octet-stream';
    }
    const response = await doFetch(`${base}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) throw await agentError(response);
    return response;
  }

  const json = async <T>(response: Response) => (await response.json()) as T;
  // `GET /fs/*` answers a directory with its JSON listing and a file with its bytes.
  const isListing = (response: Response) =>
    (response.headers.get('content-type') ?? '').includes('application/json');

  async function file(path: string, signal?: AbortSignal) {
    const response = await request('GET', fsPath(path), { signal });
    if (isListing(response)) {
      await response.body?.cancel();
      throw new AgentError(409, `${path} is a directory`, 'IS_A_DIRECTORY');
    }
    return response;
  }

  return {
    url: base,
    async health(signal) {
      const body = await json<{ status?: string; version?: string }>(
        await request('GET', '/healthz', { signal, timeoutMs: 5_000 }),
      );
      return { ok: body.status === 'ok', ...(body.version ? { version: body.version } : {}) };
    },
    async exec(req, { signal, onChunk } = {}) {
      const response = await request('POST', '/exec', {
        json: req,
        signal,
        timeoutMs: (req.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS) + EXEC_GRACE_MS,
      });
      return readExecStream(response, onChunk);
    },
    readFile: async (path, signal) =>
      new Uint8Array(await (await file(path, signal)).arrayBuffer()),
    openFile: (path, signal) => file(path, signal),
    async writeFile(path, body, signal) {
      const data = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      const response = await request('PUT', fsPath(path), {
        body: data as RequestInit['body'],
        signal,
      });
      const written = await json<Partial<FsEntry>>(response);
      return { size: written.size ?? data.byteLength };
    },
    async deleteFile(path, { recursive, signal } = {}) {
      await request('DELETE', `${fsPath(path)}${recursive ? '?recursive=1' : ''}`, { signal });
    },
    async list(path, signal) {
      const response = await request('GET', fsPath(path), { signal });
      if (!isListing(response)) {
        await response.body?.cancel();
        throw new AgentError(409, `${path} is not a directory`, 'NOT_A_DIRECTORY');
      }
      const listing = await json<FsListing>(response);
      return {
        path: absolute(listing.path),
        entries: listing.entries.map((e) => ({
          name: e.name,
          path: absolute(e.path),
          type: e.type,
          size: e.size,
          mtime: e.modifiedAt,
        })),
      };
    },
    startScreen: async (screen, signal) =>
      json<ScreenInfo>(
        await request('POST', '/screens', { json: screen, signal, timeoutMs: 60_000 }),
      ),
    async stopScreen(n, signal) {
      await request('DELETE', `/screens/${n}`, { signal });
    },
    screenshot: async (n, signal) =>
      new Uint8Array(
        await (await request('GET', `/screens/${n}/screenshot`, { signal })).arrayBuffer(),
      ),
    async input(n, action, signal) {
      await request('POST', `/screens/${n}/input`, { json: toAgentInput(action), signal });
    },
    async browser<T extends BrowserResult>(
      n: number,
      { action, ...body }: BrowserAction,
      signal?: AbortSignal,
    ) {
      return json<T>(
        await request('POST', `/screens/${n}/browser/${action}`, {
          json: body,
          signal,
          timeoutMs: 130_000,
        }),
      );
    },
    async setWallpaper(hour, signal) {
      await request('POST', '/wallpaper', { json: hour === undefined ? {} : { hour }, signal });
    },
    syncCookies: async (screen, signal) =>
      json<CookieSyncResult>(
        await request('POST', '/cookies/sync', {
          json: screen === undefined ? {} : { screen },
          signal,
        }),
      ),
    mcpStdio: (launch, handlers, options) =>
      openMcpStdio(`${base.replace(/^http/, 'ws')}/mcp/stdio`, auth, launch, handlers, options),
    coder: (start, handlers, options) =>
      openCoder(`${base.replace(/^http/, 'ws')}/coder`, auth, start, handlers, options),
    socket: (path) => ({ url: `${base.replace(/^http/, 'ws')}${path}`, headers: { ...auth } }),
  };
}

/** How long `mcpStdio` waits for the agent to say the process runs. */
const MCP_STDIO_START_MS = 30_000;

function openMcpStdio(
  url: string,
  headers: Record<string, string>,
  launch: McpStdioLaunch,
  handlers: McpStdioHandlers,
  { signal, timeoutMs = MCP_STDIO_START_MS }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<McpStdioProcess> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    let started = false;
    let ended = false;
    /** The agent's own reason, from an `error` frame, for the close that follows. */
    let reason: string | undefined;
    const closed = new Promise<void>((done) => ws.once('close', () => done()));
    const fail = (error: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
      ws.terminate();
    };
    const end = (info: McpStdioExit) => {
      if (!started || ended) return;
      ended = true;
      handlers.exit(info);
    };
    const timer = setTimeout(
      () =>
        fail(
          new AgentError(504, 'The computer did not start the server in time', 'MCP_STDIO_TIMEOUT'),
        ),
      timeoutMs,
    );
    const abort = () => fail(new AgentError(499, 'Cancelled', 'ABORTED'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });

    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', ...launch })));
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      fail(
        new AgentError(
          res.statusCode ?? 502,
          `The computer refused the server (${res.statusCode ?? 'no status'})`,
          'MCP_STDIO_REFUSED',
        ),
      );
    });
    ws.on('message', (raw: RawData) => {
      let msg: McpStdioServerMessage;
      try {
        msg = JSON.parse(raw.toString()) as McpStdioServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'started':
          if (started) return;
          started = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve({
            pid: msg.pid,
            write(data) {
              if (ended || ws.readyState !== ws.OPEN) throw new Error('The server is not running');
              ws.send(JSON.stringify({ type: 'stdin', data }));
            },
            async close() {
              if (ws.readyState === ws.CLOSED) return;
              ws.close(1000);
              const late = setTimeout(() => ws.terminate(), 5_000);
              await closed;
              clearTimeout(late);
            },
          });
          return;
        case 'stdout':
          if (started) handlers.stdout(msg.data);
          return;
        case 'stderr':
          if (started) handlers.stderr(msg.data);
          return;
        case 'exit':
          return end({ exitCode: msg.exitCode, signal: msg.signal });
        case 'error':
          reason = msg.message;
          if (!started) fail(new AgentError(502, msg.message, 'MCP_STDIO_FAILED'));
          else end({ exitCode: null, signal: null, error: msg.message });
          return;
      }
    });
    ws.on('error', (error) => {
      if (!started)
        fail(
          new AgentError(
            502,
            `The computer is unreachable: ${error.message}`,
            'MCP_STDIO_UNREACHABLE',
          ),
        );
      else end({ exitCode: null, signal: null, error: error.message });
    });
    ws.on('close', () => {
      if (!started) {
        fail(
          new AgentError(502, reason ?? 'The computer closed the connection', 'MCP_STDIO_CLOSED'),
        );
      } else end({ exitCode: null, signal: null, error: 'The connection to the computer closed' });
    });
  });
}

/** How long a coding session's process has to start once the socket is open. */
const CODER_START_MS = 30_000;

function openCoder(
  url: string,
  headers: Record<string, string>,
  launch: CoderLaunch,
  handlers: CoderHandlers,
  { signal, timeoutMs = CODER_START_MS }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CoderProcess> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    let opened = false;
    let refused = false;
    let started = false;
    let ended = false;
    /** The agent's own reason, from an `error` frame, for the close that follows. */
    let reason: string | undefined;
    let markStarted!: (info: { pid: number; sessionDir: string }) => void;
    let failStart!: (error: Error) => void;
    const startedPromise = new Promise<{ pid: number; sessionDir: string }>((ok, no) => {
      markStarted = ok;
      failStart = no;
    });
    // Callers that only watch `exit` need not await `started`.
    startedPromise.catch(() => {});
    const closed = new Promise<void>((done) => ws.once('close', () => done()));
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** Before the socket opened: the call itself fails. */
    const refuse = (error: Error) => {
      if (opened || refused) return;
      refused = true;
      signal?.removeEventListener('abort', abort);
      failStart(error);
      reject(error);
      ws.terminate();
    };
    /** After it opened: the session ends, once. */
    const end = (info: CoderExit) => {
      if (ended || refused) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!started)
        failStart(new AgentError(502, info.error ?? 'The process did not start', 'CODER_FAILED'));
      handlers.exit(info);
    };
    const abort = () => {
      if (!opened) refuse(new AgentError(499, 'Cancelled', 'ABORTED'));
      else {
        end({ code: null, signal: null, error: 'Cancelled' });
        ws.close(1000);
      }
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });

    const send = (frame: CoderClientMessageInput) => {
      if (ended || ws.readyState !== ws.OPEN) throw new Error('The session is not running');
      ws.send(JSON.stringify(frame));
    };

    ws.on('open', () => {
      if (opened || refused) return;
      opened = true;
      ws.send(JSON.stringify({ type: 'start', ...launch } satisfies CoderClientMessageInput));
      timer = setTimeout(() => {
        if (started) return;
        end({ code: null, signal: null, error: 'The computer did not start the process in time' });
        ws.terminate();
      }, timeoutMs);
      resolve({
        started: startedPromise,
        write: (data, options) =>
          send({ type: 'stdin', data, ...(options?.end ? { end: true } : {}) }),
        end: () => send({ type: 'stdin', data: '', end: true }),
        credential: (answer) => send({ type: 'credential', ...answer }),
        answer: (decision) => send({ type: 'answer', ...decision }),
        signal: (sig) => send({ type: 'signal', signal: sig }),
        resize: (cols, rows) => send({ type: 'resize', cols, rows }),
        async close() {
          if (ws.readyState === ws.CLOSED) return;
          ws.close(1000);
          const late = setTimeout(() => ws.terminate(), 5_000);
          await closed;
          clearTimeout(late);
        },
      });
    });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      refuse(
        new AgentError(
          res.statusCode ?? 502,
          `The computer refused the session (${res.statusCode ?? 'no status'})`,
          'CODER_REFUSED',
        ),
      );
    });
    ws.on('message', (raw: RawData) => {
      let msg: CoderServerMessage;
      try {
        msg = JSON.parse(raw.toString()) as CoderServerMessage;
      } catch {
        return;
      }
      if (ended) return;
      switch (msg.type) {
        case 'started':
          if (started) return;
          started = true;
          clearTimeout(timer);
          markStarted({ pid: msg.pid, sessionDir: msg.session_dir });
          return;
        case 'stdout':
          return handlers.stdout(msg.data);
        case 'stderr':
          return handlers.stderr(msg.data);
        case 'credential_request': {
          const { type: _, ...request } = msg;
          return handlers.credentialRequest(request);
        }
        case 'permission_request': {
          const { type: _, ...request } = msg;
          return handlers.permissionRequest(request);
        }
        case 'exit':
          return end({ code: msg.code, signal: msg.signal });
        case 'error':
          reason = msg.message;
          handlers.error?.(msg.message);
          if (!started) end({ code: null, signal: null, error: msg.message });
          return;
      }
    });
    ws.on('error', (error) => {
      if (!opened)
        refuse(
          new AgentError(502, `The computer is unreachable: ${error.message}`, 'CODER_UNREACHABLE'),
        );
      else end({ code: null, signal: null, error: error.message });
    });
    ws.on('close', () => {
      if (!opened)
        refuse(new AgentError(502, 'The computer closed the connection', 'CODER_CLOSED'));
      else
        end({
          code: null,
          signal: null,
          error: reason ?? 'The connection to the computer closed',
        });
    });
  });
}

/** The agent's xdotool input for one of the plan's pixel actions. */
export function toAgentInput(action: InputAction): AgentInputAction {
  switch (action.action) {
    case 'click': {
      const [x, y] = action.coordinate;
      return {
        action: 'click',
        x,
        y,
        ...(action.button ? { button: action.button } : {}),
        ...(action.count ? { count: action.count } : {}),
      };
    }
    case 'double_click':
      return { action: 'double_click', x: action.coordinate[0], y: action.coordinate[1] };
    case 'type':
      return { action: 'type', text: action.text };
    case 'key':
      return { action: 'key', keys: action.text };
    case 'scroll':
      return {
        action: 'scroll',
        x: action.coordinate[0],
        y: action.coordinate[1],
        direction: action.direction,
        ...(action.amount ? { amount: action.amount } : {}),
      };
    case 'move':
      return { action: 'move', x: action.coordinate[0], y: action.coordinate[1] };
    case 'drag':
      return {
        action: 'drag',
        from: { x: action.from[0], y: action.from[1] },
        to: { x: action.to[0], y: action.to[1] },
      };
  }
}

/** `/fs/` plus the path relative to the home, each segment escaped. */
function fsPath(path: string) {
  if (path !== COMPUTER_HOME && !path.startsWith(`${COMPUTER_HOME}/`)) {
    throw new AgentError(
      403,
      `Only files under ${COMPUTER_HOME} are reachable`,
      'PATH_OUTSIDE_HOME',
    );
  }
  const rel = path.slice(COMPUTER_HOME.length).replace(/^\/+/, '');
  return `/fs/${rel
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

function absolute(rel: string) {
  return rel ? `${COMPUTER_HOME}/${rel}` : COMPUTER_HOME;
}

async function agentError(response: Response) {
  let message = `${response.status} ${response.statusText}`.trim();
  let code: string | undefined;
  try {
    const body = (await response.json()) as { detail?: unknown; code?: unknown };
    if (typeof body.detail === 'string') message = body.detail;
    if (typeof body.code === 'string') code = body.code;
  } catch {
    // Not JSON; keep the status line.
  }
  return new AgentError(response.status, message, code);
}

async function readExecStream(
  response: Response,
  onChunk?: (chunk: ExecChunk) => void,
): Promise<ExecResult> {
  const result: ExecResult = { exitCode: -1, stdout: '', stderr: '', timedOut: false };
  const decoder = new TextDecoder();
  let buffered = '';
  let failure: string | null = null;
  const line = (text: string) => {
    if (!text.trim()) return;
    const event = JSON.parse(text) as ExecEvent;
    if (event.type === 'stdout' || event.type === 'stderr') {
      result[event.type] += event.data;
      onChunk?.(event);
    } else if (event.type === 'exit') {
      result.exitCode = event.exitCode ?? -1;
      result.timedOut = event.timedOut;
    } else if (event.type === 'error') {
      failure = event.message;
    }
  };
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = buffered.indexOf('\n')) >= 0) {
        line(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
      }
    }
  }
  line(buffered + decoder.decode());
  if (failure !== null) throw new AgentError(500, failure, 'EXEC_FAILED');
  return result;
}
