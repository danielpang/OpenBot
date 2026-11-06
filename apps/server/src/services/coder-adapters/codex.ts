import { CODER_FEED_LINE_MAX, type CoderActionClass, type CoderEvent } from '@openbots/shared';
import { claudeAdapter, parseShell, stripAnsi } from './claude.js';
import {
  IGNORED_SESSION_ID,
  isVendorSessionId,
  type CoderAdapter,
  type CoderLaunchPlan,
  type CoderLoginParse,
  type CoderOutputParser,
  type CoderSessionSpec,
} from './types.js';

// The Codex CLI (design doc, "The three agents"; I10). The session runs
// `codex exec --json`, one JSON object per line: `thread.started` with the
// thread id (the vendor session id), `item.completed` for each message,
// reasoning summary, command, file change and tool call, then
// `turn.completed` with the usage or `turn.failed` with the reason. The facts
// below were checked against the pinned 0.166.0 in VENDOR-FACTS.md.
//
// `exec` has no channel to ask anyone: with `approval_policy="never"` a
// command the sandbox blocks fails back to the model. So a Codex session gets
// Codex's own sandbox (`workspace-write`, or `read-only` to plan) and never an
// OpenBots approval; `classify` is here for the interface, should a later
// version route prompts through `codex app-server`. The sandbox keeps the
// network off, so package installs fail inside the session.
//
// `-a` is not an `exec` flag, and `exec resume` takes neither `-s` nor `-C`,
// so the approval policy and a resumed sandbox go through `-c` (TOML values),
// and a resumed session's directory is the process cwd the runner sets.

type Sandbox = 'read-only' | 'workspace-write';

const sandboxFor = (spec: CoderSessionSpec): Sandbox =>
  spec.mode === 'plan' ? 'read-only' : 'workspace-write';

/** `-c` values are TOML: a string is quoted. */
const APPROVAL_NEVER = 'approval_policy="never"';
/** `workspace-write` keeps the network off by default; this says so explicitly. */
const NETWORK_OFF = 'sandbox_workspace_write.network_access=false';
/** More directories `workspace-write` may write, as `--add-dir` adds them. */
const WRITABLE_ROOTS = 'sandbox_workspace_write.writable_roots';

export function preamble(spec: CoderSessionSpec): string {
  const lines = [
    `You are working for OpenBots in the git worktree ${spec.worktreePath}, on the branch ${spec.branch}, made from ${spec.base} of ${spec.repoFullName}.`,
    'Commit as you go, with clear messages.',
    'Do not push: OpenBots pushes the branch after the owner approves.',
    "Run the repository's tests when it has them.",
    'The sandbox has no network, so installing packages fails: if a missing dependency blocks you, say so and ask the owner to install dependencies.',
    'Finish with a short summary of what changed and what the owner should verify.',
  ];
  if (spec.coAuthor) {
    lines.push(
      `End every commit message with this trailer line: Co-Authored-By: ${spec.coAuthor.name} <${spec.coAuthor.email}>`,
    );
  }
  if (spec.mode === 'plan') {
    lines.push(
      'This session only plans: change nothing, edit no files and make no commits. Read the code and write a plan.',
    );
  }
  return lines.join(' ');
}

function launch(spec: CoderSessionSpec): CoderLaunchPlan {
  const sandbox = sandboxFor(spec);
  const model = spec.model ? ['-m', spec.model] : [];
  const prompt = `${preamble(spec)}\n\n${spec.prompt}`;
  // A resume id that is not a UUID is dropped, as Claude Code's is: it would
  // reach argv. The session then starts afresh.
  const resume = spec.resumeId && isVendorSessionId(spec.resumeId) ? spec.resumeId : undefined;
  // The worktree's git dir is under `<repo>/.git`, outside the sandbox's
  // workspace, so a commit needs it writable. `exec` takes `--add-dir`;
  // `exec resume` does not, so a resumed session names it in the sandbox's
  // own config (a TOML array; a JSON string is a TOML basic string).
  const gitDir =
    sandbox === 'workspace-write' && spec.repoPath
      ? `${spec.repoPath.replace(/\/+$/, '')}/.git`
      : undefined;
  // Every session: no user config.toml (the sign-in still comes from
  // CODEX_HOME), and the sandbox's network off, said rather than assumed.
  const hardening = ['--ignore-user-config', '-c', NETWORK_OFF];
  const args = resume
    ? [
        'exec',
        'resume',
        resume,
        '--json',
        '--skip-git-repo-check',
        ...hardening,
        '-c',
        APPROVAL_NEVER,
        '-c',
        `sandbox_mode="${sandbox}"`,
        ...(gitDir ? ['-c', `${WRITABLE_ROOTS}=[${JSON.stringify(gitDir)}]`] : []),
        ...model,
        '--',
        prompt,
      ]
    : [
        'exec',
        '--json',
        '-s',
        sandbox,
        '-C',
        spec.worktreePath,
        ...(gitDir ? ['--add-dir', gitDir] : []),
        '--skip-git-repo-check',
        ...hardening,
        '-c',
        APPROVAL_NEVER,
        ...model,
        // The prompt is positional; `--` keeps one that starts with a dash from reading as an option.
        '--',
        prompt,
      ];
  // CODEX_HOME (the sign-in) is set by the computer agent.
  const env: Record<string, string> = {};
  if (spec.gitIdentity) {
    env.GIT_AUTHOR_NAME = spec.gitIdentity.name;
    env.GIT_AUTHOR_EMAIL = spec.gitIdentity.email;
    env.GIT_COMMITTER_NAME = spec.gitIdentity.name;
    env.GIT_COMMITTER_EMAIL = spec.gitIdentity.email;
  }
  return { command: 'codex', args, env };
}

// Parsing `exec --json`

type Json = Record<string, unknown>;
type Billed = Extract<CoderEvent, { type: 'usage' }>['billed'];

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

const oneLine = (text: string, max = CODER_FEED_LINE_MAX) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

/** `/bin/bash -lc 'npm test'`, as Codex wraps every command, shown as `npm test`. */
export function unwrapShell(command: string): string {
  const parsed = parseShell(command);
  const words = parsed.commands[0]?.words;
  if (parsed.unbalanced || parsed.commands.length !== 1 || words?.length !== 3) return command;
  const shell = words[0]!.text.split('/').pop() ?? '';
  if (!SHELLS.has(shell) || !/^-[a-z]*c$/.test(words[1]!.text)) return command;
  return words[2]!.text;
}

/** Codex's change kinds in OpenBots's terms. */
const CHANGE_KIND: Record<string, 'create' | 'edit' | 'delete'> = {
  add: 'create',
  update: 'edit',
  delete: 'delete',
};

/** A retry Codex recovers from on its own, or a transport notice: not a failure. */
const TRANSIENT = /^(?:Reconnecting\b|Falling back from WebSockets)/;

/**
 * How a Codex login is billed, from `codex login status`: a ChatGPT login
 * counts against the plan, any other sign-in against API credits.
 */
export function codexBilling(status: string): Billed {
  const text = stripAnsi(status);
  if (/not logged in/i.test(text)) return 'unknown';
  if (/Logged in using ChatGPT/i.test(text)) return 'subscription';
  if (/Logged in/i.test(text)) return 'api';
  return 'unknown';
}

export interface CodexParserOptions {
  /**
   * How the tokens are billed. The stream does not say: it follows from the
   * login kind (`codexBilling`), which the caller knows and the parser cannot.
   */
  billing?: Billed;
  /** The session's worktree, so file changes read as paths inside it. */
  worktreePath?: string;
}

/** A feed line saying a session id was dropped (`isVendorSessionId`). */
const ignoredId = (): CoderEvent => ({ type: 'text', text: IGNORED_SESSION_ID });

/** One parser per process: it keeps the thread id, the last message and how the turn ended. */
export function codexParser(options: CodexParserOptions = {}): CoderOutputParser {
  const billed = options.billing ?? 'unknown';
  let threadId: string | undefined;
  let seen = false;
  let completed = false;
  let failure: string | undefined;
  let lastMessage = '';
  let lastError: string | undefined;
  let ended = false;

  /** Inside the worktree, a path reads relative to it. Worktrees live under `<repo>/.worktrees/<slug>`. */
  const relative = (path: string) => {
    const root = options.worktreePath?.replace(/\/+$/, '');
    if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
    const at = /\/\.worktrees\/[^/]+\//.exec(path);
    return at ? path.slice(at.index + at[0].length) : path;
  };

  const error = (message: string): CoderEvent[] => {
    const text = oneLine(message, 300);
    if (!text || text === lastError) return [];
    lastError = text;
    return [{ type: 'error', message: text }];
  };

  function item(entry: Json): CoderEvent[] {
    switch (entry.type) {
      case 'agent_message': {
        const text = str(entry.text)?.trim();
        if (!text) return [];
        lastMessage = text;
        return [{ type: 'text', text }];
      }
      case 'reasoning': {
        const text = oneLine((str(entry.text) ?? '').replace(/\*\*/g, ''));
        return text ? [{ type: 'text', text: oneLine(`Thinking: ${text}`) }] : [];
      }
      case 'command_execution': {
        const command = unwrapShell(str(entry.command) ?? '');
        const code = entry.exit_code;
        const exitCode = typeof code === 'number' && Number.isInteger(code) ? code : undefined;
        let summary: string | undefined;
        if (entry.status === 'declined') summary = 'Declined';
        else if (exitCode !== undefined && exitCode !== 0) {
          const last = (str(entry.aggregated_output) ?? '').trim().split('\n').pop()?.trim();
          if (last) summary = oneLine(last, 200);
        }
        return [
          {
            type: 'command',
            command,
            ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
            ...(summary ? { summary } : {}),
          },
        ];
      }
      case 'file_change': {
        if (entry.status !== undefined && entry.status !== 'completed') return [];
        const changes = Array.isArray(entry.changes) ? entry.changes : [];
        return changes.flatMap((change): CoderEvent[] => {
          if (!isObject(change)) return [];
          const path = str(change.path);
          if (!path) return [];
          const kind = CHANGE_KIND[str(change.kind) ?? ''] ?? 'edit';
          return [{ type: 'file_change', path: relative(path), kind }];
        });
      }
      case 'mcp_tool_call': {
        const server = str(entry.server) ?? 'mcp';
        const tool = str(entry.tool) ?? 'tool';
        const failed = str(entry.error) ?? (isObject(entry.error) ? str(entry.error.message) : '');
        const args = entry.arguments === undefined ? '' : JSON.stringify(entry.arguments);
        const summary = failed ? `Failed: ${failed}` : args;
        return [{ type: 'tool_use', name: `${server}.${tool}`, summary: oneLine(summary, 200) }];
      }
      case 'web_search':
        return [
          { type: 'tool_use', name: 'web_search', summary: oneLine(str(entry.query) ?? '', 200) },
        ];
      case 'collab_tool_call':
        return [{ type: 'tool_use', name: str(entry.tool) ?? 'collab', summary: '' }];
      case 'error': {
        const message = str(entry.message) ?? '';
        return TRANSIENT.test(message) ? [] : error(message);
      }
      default:
        // `todo_list` and anything newer.
        return [];
    }
  }

  return {
    line(text) {
      const trimmed = text.trim();
      if (!trimmed.startsWith('{')) return [];
      let line: unknown;
      try {
        line = JSON.parse(trimmed);
      } catch {
        return [];
      }
      if (!isObject(line)) return [];
      switch (line.type) {
        case 'thread.started': {
          seen = true;
          const reported = str(line.thread_id);
          if (reported === undefined) return [];
          if (!isVendorSessionId(reported)) return [ignoredId()];
          threadId = reported;
          return [];
        }
        case 'turn.started':
          seen = true;
          return [];
        case 'item.completed':
          seen = true;
          return isObject(line.item) ? item(line.item) : [];
        case 'turn.completed': {
          seen = true;
          completed = true;
          failure = undefined;
          const usage = isObject(line.usage) ? line.usage : {};
          return [
            {
              type: 'usage',
              // OpenAI counts cached input inside `input_tokens`.
              input_tokens: num(usage.input_tokens),
              output_tokens: num(usage.output_tokens),
              billed,
            },
          ];
        }
        case 'turn.failed':
        case 'thread.failed': {
          seen = true;
          completed = false;
          const reason = isObject(line.error) ? str(line.error.message) : str(line.message);
          failure = oneLine(reason || 'Codex stopped with an error', 300);
          return error(failure);
        }
        case 'error': {
          const message = str(line.message) ?? '';
          return TRANSIENT.test(message) ? [] : error(message);
        }
        default:
          // `item.started`, `item.updated`: the completed item says it all.
          return [];
      }
    },
    end() {
      if (ended || !seen) return [];
      ended = true;
      const vendor = threadId ? { vendor_session_id: threadId } : {};
      if (completed && !failure) {
        return [{ type: 'result', ok: true, summary: lastMessage, ...vendor }];
      }
      const reason = failure ?? 'Codex did not finish';
      return [{ type: 'result', ok: false, summary: reason, ...vendor, error: reason }];
    },
  };
}

// Signing in

const LOGIN_URL = /https:\/\/[^\s"'<>]+/;
/** `1PVB-90DS9`: four and five capitals or digits. */
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;
const SIGNED_IN = /(?<!not )logged in|login successful|\bsuccess/i;
const LOGIN_ERROR = /^.*\b(?:denied|expired)\b.*$/im;

function parseLogin(chunk: string, state: CoderLoginParse): CoderLoginParse {
  const text = stripAnsi(chunk);
  const next: CoderLoginParse = { ...state, awaitingCode: false };
  if (!next.url) {
    const url = LOGIN_URL.exec(text)?.[0].replace(/[).,;]+$/, '');
    if (url) next.url = url;
  }
  if (!next.deviceCode) {
    const code = DEVICE_CODE.exec(text)?.[0];
    if (code) next.deviceCode = code;
  }
  if (SIGNED_IN.test(text)) {
    next.signedIn = true;
    if (/Logged in using ChatGPT/i.test(text)) next.accountLabel = 'ChatGPT';
  }
  const error = LOGIN_ERROR.exec(text)?.[0];
  if (error && !next.signedIn) next.error = oneLine(error, 300);
  return next;
}

// Classifying permission prompts
//
// `exec` raises none. Should one arrive (a later `codex app-server` route),
// it is read with Claude Code's classifier: a command as Bash, a file change
// as an Edit of each path, the strictest winning.

const RANK: Record<CoderActionClass, number> = {
  destructive: 5,
  push: 4,
  pr: 3,
  install: 2,
  outside_worktree: 1,
  other: 0,
};

const COMMAND_TOOLS = new Set(['command_execution', 'commandExecution', 'exec_command', 'shell']);
const FILE_TOOLS = new Set(['file_change', 'fileChange', 'apply_patch']);

function classify(
  toolName: string,
  input: unknown,
  context?: { worktreePath: string },
): ReturnType<CoderAdapter['classify']> {
  const args = isObject(input) ? input : {};
  if (COMMAND_TOOLS.has(toolName)) {
    const raw = Array.isArray(args.command)
      ? args.command.filter((w): w is string => typeof w === 'string').join(' ')
      : (str(args.command) ?? '');
    return claudeAdapter.classify('Bash', { command: unwrapShell(raw) }, context);
  }
  if (FILE_TOOLS.has(toolName)) {
    const changes = Array.isArray(args.changes) ? args.changes : [];
    const paths = [
      str(args.path),
      ...changes.map((c) => (isObject(c) ? str(c.path) : undefined)),
    ].filter((p): p is string => !!p);
    let verdict: ReturnType<CoderAdapter['classify']> = {
      action: 'other',
      title: paths.length ? `Edit ${paths.join(', ')}` : 'Change files',
    };
    for (const path of paths) {
      const one = claudeAdapter.classify('Edit', { file_path: path }, context);
      if (RANK[one.action] > RANK[verdict.action]) verdict = one;
    }
    return verdict;
  }
  return { action: 'other', title: `Use ${toolName}` };
}

// What Codex says when it is not signed in, or its sign-in lapsed.
const NOT_SIGNED_IN =
  /not logged in|\b401\b|unauthorized|codex login|please (?:log|sign) ?in|login (?:required|expired)/i;

export const codexAdapter: CoderAdapter = {
  agent: 'codex',
  versionArgs: ['--version'],
  loginHosts: ['auth.openai.com', 'chatgpt.com', 'openai.com', 'platform.openai.com'],
  launch,
  parser: (options) => codexParser(options),
  // Only a UUID reaches the terminal's preset.
  resumeCommand: (vendorSessionId) =>
    isVendorSessionId(vendorSessionId) ? `codex resume ${vendorSessionId}` : 'codex',
  // Device code sign-in: a link and a code to enter there; nothing is pasted back.
  login: () => ({ command: 'codex', args: ['login', '--device-auth'], timeoutMs: 15 * 60_000 }),
  parseLogin,
  classify,
  needsLogin: (text) => NOT_SIGNED_IN.test(text),
};
