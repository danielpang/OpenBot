import type {
  CoderCredentialAnswer,
  CoderHandlers,
  CoderLaunch,
  CoderPermissionAnswer,
  CoderProcess,
  CoderSignal,
  ComputerProvider,
} from '@openbots/computer';
import type { CodingSessionState } from '@openbots/widgets';
import { and, eq } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { schema } from '../../../db/client.js';
import { useTestComputer, type TestComputer } from '../../../test-computer.js';
import { createTestApp, type TestApp } from '../../../test-app.js';
import { setComputerProvider } from '../../computer.js';
import { RUNNER_GIT_CONFIG } from '../../repos-checkout.js';
import { storeMessage } from '../../messages.js';

// The coding session tests' world: one owner with a Bot, a running computer
// whose agent's `/coder` is scripted here (the fake agent's own `/coder`
// lands with the computer agent work), a remembered repository, and a
// session posted the way `code_task` posts one: a `coding_session` widget
// in the Bot's chat, its `widget_states` row with the run waiting on it, and
// the `coding_sessions` row.

export const REPO_PATH = '/home/bot/repos/acme/relay';

/** One `/coder` process the runner started, and what it was told. */
export interface CoderCall {
  launch: CoderLaunch;
  handlers: CoderHandlers;
  answers: CoderPermissionAnswer[];
  credentials: CoderCredentialAnswer[];
  signals: CoderSignal[];
  writes: string[];
  /** The runner closed the process's stdin (`end`). */
  stdinEnded: boolean;
  ended: boolean;
}

/** What a scripted process can do: print, ask, and end. */
export interface CoderIo {
  call: CoderCall;
  stdout(data: string): void;
  stderr(data: string): void;
  /** A permission prompt; resolves with the runner's answer. */
  permission(requestId: string, toolName: string, input: unknown): Promise<CoderPermissionAnswer>;
  /** A credential request; resolves with the runner's answer. */
  credential(request: {
    host: string;
    path?: string;
    username?: string;
  }): Promise<CoderCredentialAnswer>;
  exit(code: number | null, signal?: string | null): void;
  /** Resolves when the runner signals the process. */
  signalled(): Promise<CoderSignal>;
}

export type GitAnswer = {
  code: number;
  stdout?: string;
  stderr?: string;
  /** git asks for a credential first, as a clone or fetch over https does. */
  credential?: { host: string; path?: string; username?: string };
};
export type Script = (io: CoderIo) => void | Promise<void>;

/** What git answers by default: an existing checkout, a new branch, one commit. */
export function defaultGit(args: string[]): GitAnswer {
  const has = (...words: string[]) => words.every((w) => args.includes(w));
  if (has('--is-inside-work-tree')) return { code: 128, stderr: 'fatal: not a git repository' };
  if (has('--verify')) return { code: 1 };
  if (has('rev-parse', '--git-dir')) return { code: 0, stdout: '.git\n' };
  // The checkout is where it was asked for: git's top level is the -C path.
  if (has('rev-parse', '--show-toplevel')) {
    return { code: 0, stdout: `${args[args.indexOf('-C') + 1] ?? ''}\n` };
  }
  if (has('rev-parse', 'HEAD')) return { code: 0, stdout: 'abc1234\n' };
  if (has('rev-list')) return { code: 0, stdout: '0\t2\n' };
  if (has('symbolic-ref')) return { code: 0, stdout: 'refs/remotes/origin/main\n' };
  // A session's worktree is clean (nothing for the runner to commit); the
  // checkout's own status lists the worktrees, which is not dirt.
  if (has('status', '--porcelain')) {
    const at = args[args.indexOf('-C') + 1] ?? '';
    return { code: 0, stdout: at.includes('/.worktrees/') ? '' : '?? .worktrees/\n' };
  }
  if (has('diff', '--numstat')) return { code: 0, stdout: '3\t1\tsrc/link.ts\n' };
  if (has('diff', '--name-status')) return { code: 0, stdout: 'M\tsrc/link.ts\n' };
  if (has('log')) return { code: 0, stdout: 'f00dfeed\tBack off between relay reconnects\n' };
  return { code: 0 };
}

/**
 * What the runner's own file commands answer by default (null leaves the
 * command to `agent`): every chmod works, and every file `stat` is asked
 * about is the runner's (uid 1801) at 0644, as `lockDown` leaves them.
 */
export function defaultSystem(command: string, args: string[]): GitAnswer | null {
  if (command === 'chmod') return { code: 0 };
  if (command === 'stat') {
    const files = args.slice(args.indexOf('--') + 1);
    return { code: 0, stdout: files.map((f) => `1801 644 ${f}\n`).join('') };
  }
  return null;
}

/**
 * A git command's own arguments: without the hardening config every runner
 * git command starts with (`RUNNER_GIT_CONFIG`), which tests assert apart.
 */
export function gitArgs(args: string[] = []): string[] {
  const n = RUNNER_GIT_CONFIG.length;
  return RUNNER_GIT_CONFIG.every((a, i) => args[i] === a) ? args.slice(n) : args;
}

/** A scripted `ComputerAgentClient.coder`: git answers from `git`, the agent's CLI from `agent`. */
export function scriptedCoder() {
  const calls: CoderCall[] = [];
  const control = {
    calls,
    coder: undefined as unknown as (
      launch: CoderLaunch,
      handlers: CoderHandlers,
    ) => Promise<CoderProcess>,
    git: defaultGit as (args: string[]) => GitAnswer,
    system: defaultSystem as (command: string, args: string[]) => GitAnswer | null,
    agent: ((io) => io.exit(0)) as Script,
    /** The CLI's process calls (not the runner's git, chmod or stat). */
    agentCalls: () => calls.filter((c) => c.launch.user !== 'runner'),
    gitCalls: () =>
      calls.filter((c) => c.launch.command === 'git').map((c) => gitArgs(c.launch.args)),
  };
  control.coder = vi.fn(
    async (launch: CoderLaunch, handlers: CoderHandlers): Promise<CoderProcess> => {
      const call: CoderCall = {
        launch,
        handlers,
        answers: [],
        credentials: [],
        signals: [],
        writes: [],
        stdinEnded: false,
        ended: false,
      };
      calls.push(call);
      const answers = new Map<string, (a: CoderPermissionAnswer) => void>();
      const credentials = new Map<string, (a: CoderCredentialAnswer) => void>();
      const signalWaiters: ((s: CoderSignal) => void)[] = [];
      let credentialSeq = 0;
      const io: CoderIo = {
        call,
        stdout: (data) => !call.ended && handlers.stdout(data),
        stderr: (data) => !call.ended && handlers.stderr(data),
        permission: (requestId, toolName, input) =>
          new Promise((resolve) => {
            answers.set(requestId, resolve);
            handlers.permissionRequest({ request_id: requestId, tool_name: toolName, input });
          }),
        credential: (request) =>
          new Promise((resolve) => {
            const requestId = `cred-${++credentialSeq}`;
            credentials.set(requestId, resolve);
            handlers.credentialRequest({ request_id: requestId, protocol: 'https', ...request });
          }),
        exit: (code, signal = null) => {
          if (call.ended) return;
          call.ended = true;
          handlers.exit({ code, signal });
        },
        signalled: () => new Promise((resolve) => signalWaiters.push(resolve)),
      };
      const proc: CoderProcess = {
        started: Promise.resolve({ pid: 4242, sessionDir: '/var/lib/openbots/coders/sessions/x' }),
        write: (data, options) => {
          if (call.ended) throw new Error('The session is not running');
          call.writes.push(data);
          if (options?.end) call.stdinEnded = true;
        },
        end: () => {
          if (call.ended) throw new Error('The session is not running');
          call.stdinEnded = true;
        },
        credential: (answer) => {
          call.credentials.push(answer);
          credentials.get(answer.request_id)?.(answer);
        },
        answer: (answer) => {
          call.answers.push(answer);
          answers.get(answer.request_id)?.(answer);
        },
        signal: (signal) => {
          call.signals.push(signal);
          for (const waiter of signalWaiters.splice(0)) waiter(signal);
        },
        resize: () => {},
        close: async () => io.exit(null, 'SIGTERM'),
      };
      setTimeout(() => {
        const system =
          launch.command === 'git' ? null : control.system(launch.command, launch.args ?? []);
        if (system) {
          if (system.stdout) handlers.stdout(system.stdout);
          if (system.stderr) handlers.stderr(system.stderr);
          io.exit(system.code);
          return;
        }
        if (launch.command === 'git') {
          const answer = control.git(gitArgs(launch.args));
          if (answer.credential) {
            void io.credential(answer.credential).then(() => {
              if (answer.stdout) handlers.stdout(answer.stdout);
              if (answer.stderr) handlers.stderr(answer.stderr);
              io.exit(answer.code);
            });
            return;
          }
          if (answer.stdout) handlers.stdout(answer.stdout);
          if (answer.stderr) handlers.stderr(answer.stderr);
          io.exit(answer.code);
          return;
        }
        void Promise.resolve(control.agent(io)).catch((error: unknown) => {
          handlers.stderr(String(error));
          io.exit(1);
        });
      }, 0);
      return proc;
    },
  );
  return control;
}

export interface CoderWorld {
  t: TestApp;
  computer: TestComputer;
  coder: ReturnType<typeof scriptedCoder>;
  cookie: string;
  ownerId: string;
  workspaceId: string;
  bot: { id: string; chatId: string; handle: string; name: string };
  repoId: string;
  call(method: string, path: string, body?: unknown): Promise<Response>;
  /** A session posted as `code_task` posts one, with its run waiting on the widget. */
  newSession(over?: Partial<typeof schema.codingSessions.$inferInsert>): Promise<{
    sessionId: string;
    runId: string;
    messageId: string;
  }>;
  session(id: string): Promise<typeof schema.codingSessions.$inferSelect>;
  widget(id: string): Promise<CodingSessionState>;
  run(id: string): Promise<typeof schema.runs.$inferSelect>;
  until<T>(fn: () => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
}

/**
 * `fakeAgent` leaves the computer's own `/coder` in place: the fake agent's
 * (`computer.agent.coderScript`) over a real socket, not `scriptedCoder`.
 */
export async function coderWorld(
  email = 'coder-owner@example.com',
  { fakeAgent = false }: { fakeAgent?: boolean } = {},
): Promise<CoderWorld> {
  const t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
  const computer = await useTestComputer(t.ownerDeps);
  const coder = scriptedCoder();
  const inner = computer.provider;
  if (!fakeAgent) {
    const provider: ComputerProvider = {
      ...inner,
      agent: (ref) => ({ ...inner.agent(ref), coder: coder.coder }),
    };
    setComputerProvider(t.ownerDeps, provider);
  }
  const cookie = (await t.signUp(email)).cookie!;
  const ownerId = await t.userId(email);
  const workspaceId = await t.defaultOrganization();
  const call = async (method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const res = await call('POST', '/bots', {
    name: 'Relay Bot',
    modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
  });
  expect(res.status).toBe(201);
  const bot = (await res.json()) as CoderWorld['bot'];
  expect((await call('POST', '/computer/start')).status).toBe(200);
  const [repo] = await t.db
    .insert(schema.repos)
    .values({
      workspaceId,
      ownerId,
      fullName: 'acme/relay',
      remoteUrl: 'https://github.com/acme/relay.git',
      defaultBranch: 'main',
    })
    .returning();
  const [chat] = await t.db.select().from(schema.chats).where(eq(schema.chats.id, bot.chatId));

  const newSession: CoderWorld['newSession'] = async (over = {}) => {
    const message = await storeMessage(t.db, chat!, {
      authorType: 'bot',
      authorId: bot.id,
      parts: [
        {
          type: 'widget',
          kind: 'coding_session',
          props: {
            session_id: '00000000-0000-4000-8000-000000000000',
            agent: 'claude',
            repo: 'acme/relay',
            branch: 'bot/fix-reconnect',
            base: 'main',
            mode: 'edit',
            prompt_excerpt: 'Fix the reconnect loop',
          },
          state: { status: 'queued', feed: [], approvals: [] },
        },
      ],
    });
    const [run] = await t.db
      .insert(schema.runs)
      .values({
        workspaceId,
        botId: bot.id,
        chatId: bot.chatId,
        trigger: 'message',
        status: 'waiting',
        state: {
          version: 1,
          messages: [],
          pending: { reason: 'widget', toolCallId: 'call-1', toolName: 'code_task', args: {} },
        },
      })
      .returning();
    await t.db.insert(schema.widgetStates).values({
      workspaceId,
      messageId: message.id,
      partIndex: 0,
      state: { status: 'queued', feed: [], approvals: [] },
      pendingRunId: run!.id,
    });
    const [session] = await t.db
      .insert(schema.codingSessions)
      .values({
        workspaceId,
        ownerId,
        botId: bot.id,
        runId: run!.id,
        chatId: bot.chatId,
        messageId: message.id,
        partIndex: 0,
        agent: 'claude',
        repoId: repo!.id,
        repoFullName: 'acme/relay',
        remoteUrl: repo!.remoteUrl,
        branch: 'bot/fix-reconnect',
        base: 'main',
        mode: 'edit',
        prompt: 'Fix the reconnect loop',
        ...over,
      })
      .returning();
    return { sessionId: session!.id, runId: run!.id, messageId: message.id };
  };

  const world: CoderWorld = {
    t,
    computer,
    coder,
    cookie,
    ownerId,
    workspaceId,
    bot,
    repoId: repo!.id,
    call,
    newSession,
    session: async (id) =>
      (await t.db.select().from(schema.codingSessions).where(eq(schema.codingSessions.id, id)))[0]!,
    widget: async (id) => {
      const [session] = await t.db
        .select()
        .from(schema.codingSessions)
        .where(eq(schema.codingSessions.id, id));
      const [row] = await t.db
        .select()
        .from(schema.widgetStates)
        .where(
          and(
            eq(schema.widgetStates.messageId, session!.messageId!),
            eq(schema.widgetStates.partIndex, session!.partIndex!),
          ),
        );
      return row!.state as CodingSessionState;
    },
    run: async (id) => (await t.db.select().from(schema.runs).where(eq(schema.runs.id, id)))[0]!,
    until: (fn) => vi.waitFor(fn, { timeout: 5_000, interval: 10 }),
    close: async () => {
      await computer.close();
      await t.close();
    },
  };
  return world;
}

/** Stream-json lines as one stdout chunk. */
export const jsonl = (...lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;

/** The vendor session id the scripted CLI reports: a UUID, as Claude Code's are. */
export const VENDOR_ID = '5a0c9e3e-1b2d-4f6a-8c7e-9d0f1a2b3c4d';

export const initLine = (
  sessionId = VENDOR_ID,
  cwd = `${REPO_PATH}/.worktrees/bot-fix-reconnect`,
) => ({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  cwd,
  apiKeySource: 'none',
});

export const resultLine = (text: string, over: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  session_id: VENDOR_ID,
  total_cost_usd: 0.05,
  usage: { input_tokens: 100, output_tokens: 20 },
  ...over,
});
