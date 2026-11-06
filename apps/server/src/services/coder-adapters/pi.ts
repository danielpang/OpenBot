import { CODER_PI_EXTENSION } from '@openbots/computer';
import { CODER_FEED_LINE_MAX, type CoderEvent } from '@openbots/shared';
import { DomainError } from '../../errors.js';
import { TERMINAL_LOGIN_INSTRUCTIONS } from '../coder-login.js';
import { claudeAdapter, preamble } from './claude.js';
import {
  IGNORED_SESSION_ID,
  isVendorSessionId,
  type CoderAdapter,
  type CoderLaunchPlan,
  type CoderOutputParser,
  type CoderParserOptions,
  type CoderSessionSpec,
} from './types.js';

// pi (design doc, "The three agents"; I10, I11), checked against the pinned
// 1.5.0 (VENDOR-FACTS.md). The session runs `pi -p --mode json`, one JSON
// event per line: a `session` header with the session id, then agent, turn,
// message and tool execution events. A finished assistant message arrives
// whole in `message_end`; its `stopReason` says how the run ended, and pi
// exits 0 even when the provider refused it, so the outcome is read from the
// stream, never from the exit code.
//
// pi has no sandbox and no approval mode. Its one gate is an extension's
// `tool_call` hook: the launch loads only the OpenBots extension
// (`--no-extensions -e CODER_PI_EXTENSION`), which relays every tool call over
// the session socket the way the Claude Code permission MCP server does, and
// `classify` below turns each into an action class. `--no-mcp` and the
// `--tools` allowlist keep the tools to pi's own, so nothing reaches past the
// hook; `--no-approve` ignores the repository's own `.pi/` settings.
//
// Sessions: `--session-id <id>` opens the worktree's session with that id or
// creates it, so the first run and a continued one pass the same flag and the
// same id (`--session-id` cannot be combined with `--session` or
// `--continue`). The session file lives under the coder's PI_CODING_AGENT_DIR
// on the state volume, which outlives the session directory. The id is the
// OpenBots session id, a UUID, so it passes `isVendorSessionId` like the
// other agents' ids. The owner takes over with `pi --session <id>`, which
// opens it in its own working directory.

/** pi's built in tools: the only ones a session may use. */
const EDIT_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
/** What a plan session may use; the extension also blocks the rest in plan mode. */
const PLAN_TOOLS = ['read', 'grep', 'find', 'ls'];

/** The variable the extension reads the mode from (coder-pi-extension.ts). */
export const CODER_MODE_ENV = 'OPENBOTS_CODER_MODE';

/**
 * pi's provider ids for the provider kinds whose key it reads from the
 * environment (`coderProviderEnv`), as `pi --list-models` lists them.
 */
export const PI_PROVIDERS: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  xai: 'xai',
};

/**
 * `--model`, and for an `api_key` account `--provider` too, so the model is
 * looked up at the provider whose key the session has. pi refuses
 * `--provider` without `--model`, so with no override neither is passed and
 * pi picks a model it has a credential for: the one key in the environment.
 * A bare model name gets the provider's prefix (`anthropic/claude-sonnet-4-5`).
 */
function modelArgs(spec: CoderSessionSpec): string[] {
  if (!spec.model) return [];
  const provider = spec.apiKeyProvider ? PI_PROVIDERS[spec.apiKeyProvider] : undefined;
  if (!provider) return ['--model', spec.model];
  const model = spec.model.startsWith(`${provider}/`) ? spec.model : `${provider}/${spec.model}`;
  return ['--provider', provider, '--model', model];
}

function launch(spec: CoderSessionSpec): CoderLaunchPlan {
  const sessionId =
    spec.resumeId && isVendorSessionId(spec.resumeId) ? spec.resumeId : spec.sessionId;
  const args = [
    '-p',
    '--mode',
    'json',
    '--session-id',
    sessionId,
    '--no-extensions',
    '-e',
    CODER_PI_EXTENSION,
    '--no-mcp',
    '--no-approve',
    '--tools',
    (spec.mode === 'plan' ? PLAN_TOOLS : EDIT_TOOLS).join(','),
    ...modelArgs(spec),
    // The prompt is positional; `--` keeps a prompt that starts with a dash
    // from reading as an option.
    '--',
    `${preamble(spec)}\n\n${spec.prompt}`,
  ];
  const env: Record<string, string> = {
    [CODER_MODE_ENV]: spec.mode,
    // The CLI is pinned in the image; it must not ask pi.dev for a newer one.
    PI_SKIP_VERSION_CHECK: '1',
  };
  if (spec.gitIdentity) {
    env.GIT_AUTHOR_NAME = spec.gitIdentity.name;
    env.GIT_AUTHOR_EMAIL = spec.gitIdentity.email;
    env.GIT_COMMITTER_NAME = spec.gitIdentity.name;
    env.GIT_COMMITTER_EMAIL = spec.gitIdentity.email;
  }
  return { command: 'pi', args, env };
}

// Parsing `--mode json`

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

const oneLine = (text: string, max = CODER_FEED_LINE_MAX) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** How pi's bash tool words a command that failed. */
const EXIT_CODE = /(?:exit(?:ed with)? code|exit status)[:\s]+(\d+)/i;

/** The lines a unified diff adds and removes. */
function diffCounts(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/** A tool result's text blocks, joined. */
function resultText(result: unknown): string {
  const content = isObject(result) ? result.content : undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isObject(block) && block.type === 'text' ? (str(block.text) ?? '') : ''))
    .join('\n');
}

/** The line a tool call shows in the feed. */
function toolSummary(input: Json): string {
  for (const key of ['path', 'pattern', 'query', 'url']) {
    const value = str(input[key]);
    if (value) return oneLine(value, 200);
  }
  return oneLine(JSON.stringify(input), 200);
}

/** Why a run that did not stop cleanly ended, from the last assistant message. */
function failure(stopReason: string | undefined, errorMessage: string | undefined): string {
  if (stopReason === 'error')
    return errorMessage ? oneLine(errorMessage, 300) : 'pi stopped with an error';
  if (stopReason === 'aborted') return 'pi was stopped before it finished';
  if (stopReason === 'length') return "The reply reached the model's output limit";
  return 'pi did not finish';
}

/** One parser per process: it keeps the session id, the usage and the open tool calls. */
export function piParser(options: CoderParserOptions = {}): CoderOutputParser {
  // pi reports cost, but not whether a plan or API credits paid for it: the
  // account's `auth_kind` says, which the runner passes in.
  const billed = options.billing ?? 'unknown';
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let started = false;
  let finished = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost: number | undefined;
  /** The last assistant message's outcome and text. */
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let lastText = '';
  /** Tool calls by id, so a result can name its command or file. */
  const calls = new Map<string, { name: string; args: Json }>();

  const relative = (path: string) =>
    cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;

  function assistant(message: Json): CoderEvent[] {
    const events: CoderEvent[] = [];
    const usage = isObject(message.usage) ? message.usage : {};
    inputTokens += num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
    outputTokens += num(usage.output);
    const total = isObject(usage.cost) ? usage.cost.total : undefined;
    if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
      cost = (cost ?? 0) + total;
    }
    stopReason = str(message.stopReason);
    errorMessage = str(message.errorMessage);
    const texts: string[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isObject(block)) continue;
      // `thinking` blocks are the model's raw reasoning: not shown.
      if (block.type === 'text') {
        const text = str(block.text)?.trim();
        if (text) {
          texts.push(text);
          events.push({ type: 'text', text });
        }
        continue;
      }
      if (block.type !== 'toolCall') continue;
      const name = str(block.name) ?? 'tool';
      const args = isObject(block.arguments) ? block.arguments : {};
      const id = str(block.id);
      if (id) calls.set(id, { name, args });
      if (name === 'bash') {
        events.push({ type: 'command', command: str(args.command) ?? '' });
      } else if (name !== 'edit' && name !== 'write') {
        // Edits and writes show once they ran (`tool_execution_end`), with their counts.
        events.push({ type: 'tool_use', name, summary: toolSummary(args) });
      }
    }
    lastText = texts.join('\n\n');
    return events;
  }

  function toolEnd(line: Json): CoderEvent[] {
    const id = str(line.toolCallId);
    const call = id ? calls.get(id) : undefined;
    if (id) calls.delete(id);
    const name = str(line.toolName) ?? call?.name;
    const args = call?.args ?? {};
    const failed = line.isError === true;
    if (name === 'bash') {
      // A command that worked needs no second line; a failed one says how.
      if (!failed) return [];
      const text = resultText(line.result).trim();
      const code = EXIT_CODE.exec(text);
      const first = text.split('\n').find((l) => l.trim() && !EXIT_CODE.test(l));
      return [
        {
          type: 'command',
          command: str(args.command) ?? '',
          ...(code ? { exit_code: Number(code[1]) } : {}),
          ...(first ? { summary: oneLine(first, 200) } : {}),
        },
      ];
    }
    if ((name === 'edit' || name === 'write') && !failed) {
      const path = relative(str(args.path) ?? '');
      if (name === 'write') return [{ type: 'file_change', path, kind: 'create' }];
      const details = isObject(line.result) ? line.result.details : undefined;
      const patch = isObject(details) ? str(details.patch) : undefined;
      return [{ type: 'file_change', path, kind: 'edit', ...(patch ? diffCounts(patch) : {}) }];
    }
    return [];
  }

  function result(): CoderEvent[] {
    finished = true;
    const ok = stopReason === 'stop';
    const why = failure(stopReason, errorMessage);
    return [
      {
        type: 'usage',
        input_tokens: Math.round(inputTokens),
        output_tokens: Math.round(outputTokens),
        ...(cost !== undefined ? { cost_usd: cost } : {}),
        billed,
      },
      {
        type: 'result',
        ok,
        summary: lastText || (ok ? '' : why),
        ...(sessionId ? { vendor_session_id: sessionId } : {}),
        ...(ok ? {} : { error: why }),
      },
    ];
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
        case 'session': {
          cwd = str(line.cwd) ?? cwd;
          const reported = str(line.id);
          if (reported === undefined) return [];
          if (!isVendorSessionId(reported)) return [{ type: 'text', text: IGNORED_SESSION_ID }];
          sessionId = reported;
          return [];
        }
        case 'agent_start':
          started = true;
          return [];
        case 'message_end': {
          const message = isObject(line.message) ? line.message : undefined;
          return message?.role === 'assistant' ? assistant(message) : [];
        }
        case 'tool_execution_end':
          return toolEnd(line);
        case 'agent_end':
          return finished ? [] : result();
        default:
          return [];
      }
    },
    // A run that started but never ended (killed, or crashed) still reports;
    // one that never started (no credential: the reason is on stderr) leaves
    // the outcome to the exit code.
    end: () => (started && !finished ? result() : []),
  };
}

// Classifying tool calls
//
// Every tool call reaches OpenBots through the extension, in pi's terms. The
// classes are Claude Code's (claude.ts reads commands the way the shell
// would and resolves paths against the worktree); pi's tools are mapped onto
// the Claude Code tool that does the same thing.

/** pi's file tools and the Claude Code tool each one is classed as. */
const PATH_TOOLS: Record<string, 'Read' | 'Edit' | 'Write'> = {
  read: 'Read',
  grep: 'Read',
  find: 'Read',
  ls: 'Read',
  edit: 'Edit',
  write: 'Write',
};

function classify(
  toolName: string,
  input: unknown,
  context?: { worktreePath: string },
): ReturnType<CoderAdapter['classify']> {
  const args = isObject(input) ? input : {};
  if (toolName === 'bash') {
    return claudeAdapter.classify('Bash', { command: str(args.command) ?? '' }, context);
  }
  const as = Object.hasOwn(PATH_TOOLS, toolName) ? PATH_TOOLS[toolName] : undefined;
  if (as) {
    // grep, find and ls default to the working directory, the worktree.
    const path = str(args.path);
    const verdict = claudeAdapter.classify(as, path ? { file_path: path } : {}, context);
    if (verdict.action !== 'other') return verdict;
    const target = path ?? str(args.pattern);
    return {
      action: 'other',
      title: target ? `${toolName}: ${oneLine(target, 200)}` : `Use ${toolName}`,
    };
  }
  return { action: 'other', title: `Use ${toolName}` };
}

// Signing in
//
// pi has no headless login: `/login` runs in its own terminal UI, so the
// owner signs in from the computer's terminal and the Settings card checks
// with `pi auth check`.

/**
 * What the owner is told: the same words as the sign-in card's
 * (`TERMINAL_LOGIN_INSTRUCTIONS`). A getter, since coder-login.ts imports
 * the adapters and is not evaluated yet when this module is, in that order.
 */
export const piLoginInTerminal = (): string => TERMINAL_LOGIN_INSTRUCTIONS.pi!;

/**
 * What pi says when it has no credential (`No API key found for ...`, then a
 * `/login` hint on stderr) or the provider refused the one it has (a 401 in
 * the assistant message's `errorMessage`).
 */
const NOT_SIGNED_IN =
  /no api key found|use \/login|not signed in|not logged in|credentials_not_configured|\b401\b|authentication_error|invalid (?:x-)?api[ -]key|unauthorized/i;

export const piAdapter: CoderAdapter = {
  agent: 'pi',
  // The whole argv: `coderVersion` runs it as is, since there is no login command to borrow.
  versionArgs: ['pi', '--version'],
  loginHosts: [],
  launch,
  parser: (options) => piParser(options),
  // Only a UUID reaches the terminal's preset.
  resumeCommand: (vendorSessionId) =>
    isVendorSessionId(vendorSessionId) ? `pi --session ${vendorSessionId}` : 'pi',
  login: () => {
    throw new DomainError(409, 'CODER_LOGIN_IN_TERMINAL', piLoginInTerminal());
  },
  parseLogin: (_chunk, state) => state,
  classify,
  needsLogin: (text) => NOT_SIGNED_IN.test(text),
};
