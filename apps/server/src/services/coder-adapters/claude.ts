import { CODER_PERMISSION_MCP } from '@openbots/computer';
import type { CoderEvent } from '@openbots/shared';
import { classifyCommandLine, classifyPathAccess } from './classify.js';
import {
  gitIdentityEnv,
  ignoredId,
  isObject,
  num,
  oneLine,
  preamble,
  str,
  stripAnsi,
  type Json,
} from './common.js';
import {
  isVendorSessionId,
  type CoderAdapter,
  type CoderLaunchPlan,
  type CoderLoginParse,
  type CoderOutputParser,
  type CoderSessionSpec,
  type CoderSignInCheck,
} from './types.js';

// Claude Code (docs/TECHNICAL_PLAN.md 22.2; I10, I11). The session runs
// `claude -p` headless with `--output-format stream-json`, one JSON object
// per line: a `system` init with the session id, `assistant` messages whose
// content blocks are text and tool calls, `user` messages carrying the tool
// results, and one `result` with the summary, the cost and the usage. Print
// mode refuses stream-json without `--verbose`, so the launch passes both.
// Edits inside the worktree are accepted by `--permission-mode acceptEdits`;
// every other prompt, every Bash command among them, reaches OpenBots through
// `--permission-prompt-tool`, the small stdio MCP server in the image that
// relays each prompt over the session socket. `git push` is refused outright,
// since OpenBots pushes after the owner approves, and so are WebFetch and
// WebSearch, which could carry what the agent read off the computer.
//
// Nothing is pre-allowed through `--allowedTools`. Edits inside the worktree
// are accepted by `acceptEdits`, and reads inside the working directory are
// Claude Code's own default; an unscoped Edit or Write rule would match a
// path outside the worktree before that check, and pre-allowing the read
// tools unscoped would let a read of the sign-in files under
// /var/lib/openbots skip the prompt. Every Bash command is classified by
// OpenBots through the permission tool, since a prefix rule such as
// `git diff*` also matches `git diff --no-index` on the sign-in files or
// `--output=` to any path. `classify` classes git's read and commit commands
// and the test runners inside the worktree as `other`, so with the default
// policy they still run without a prompt.
//
// The vendor facts (flags, the stream, the sign-in) are in
// docs/CODING_AGENT_VENDORS.md. The stream fixtures under
// services/__fixtures__/coders/ are hand made from the documented
// stream-json format; refresh them from the CLI version pinned in
// docker/coders/package.json whenever the pin moves.

/** The MCP server name in `--mcp-config` and the tool `--permission-prompt-tool` names. */
const MCP_SERVER = 'openbots';
const PERMISSION_TOOL = `mcp__${MCP_SERVER}__permission_prompt`;

/**
 * Never run by the agent: OpenBots pushes after the owner approves.
 * `git push*` covers the command with arguments; the bare `git push` is
 * listed too, so the plain command is refused even where the wildcard rule
 * wants something after it.
 */
const PUSH_TOOLS = ['Bash(git push*)', 'Bash(git push)'];

/** Never used: a fetch or a search could send what the agent read off the computer. */
const WEB_TOOLS = ['WebFetch', 'WebSearch'];

/** Never read: the computer's private state, the sign-in files among it. */
const STATE_READS = [
  'Read(/var/lib/openbots/**)',
  'Grep(/var/lib/openbots/**)',
  'Glob(/var/lib/openbots/**)',
];

/** What plan mode may not do at all; ExitPlanMode would hand it back the edit tools. */
const PLAN_DENIED = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'ExitPlanMode'];

function launch(spec: CoderSessionSpec): CoderLaunchPlan {
  // The permission server's socket is in the session's own directory, which
  // the computer agent fills in for `{{session_dir}}`.
  const mcpConfig = JSON.stringify({
    mcpServers: {
      [MCP_SERVER]: {
        command: 'node',
        args: [CODER_PERMISSION_MCP],
        env: { OPENBOTS_CODER_SOCKET: '{{session_dir}}/permission.sock' },
      },
    },
  });
  const disallowed = [
    ...PUSH_TOOLS,
    ...WEB_TOOLS,
    ...STATE_READS,
    ...(spec.mode === 'plan' ? PLAN_DENIED : []),
  ];
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(spec.maxTurns),
    '--permission-mode',
    spec.mode === 'plan' ? 'plan' : spec.acceptEdits === false ? 'default' : 'acceptEdits',
    '--disallowedTools',
    ...disallowed,
    // The publishing tool gates itself in the runner; avoid a second tool-use approval.
    ...(spec.mode === 'plan' ? [] : ['--allowedTools', 'mcp__openbots__publish_pull_request']),
    '--permission-prompt-tool',
    PERMISSION_TOOL,
    '--mcp-config',
    mcpConfig,
    ...(spec.resumeId && isVendorSessionId(spec.resumeId) ? ['--resume', spec.resumeId] : []),
    ...(spec.model ? ['--model', spec.model] : []),
    // The prompt is positional; `--` ends the variadic tool lists and keeps a
    // prompt that starts with a dash from reading as an option.
    '--',
    `${preamble(spec)}\n\n${spec.prompt}`,
  ];
  const env: Record<string, string> = {
    // The CLI is pinned in the image and root owned; it must not try to update itself.
    DISABLE_AUTOUPDATER: '1',
    ...gitIdentityEnv(spec),
  };
  return { command: 'claude', args, env };
}

// Parsing stream-json

/** `Exit code 2` at the start of a failed Bash result, as Claude Code words it. */
const EXIT_CODE = /^(?:Error: )?Exit code (\d+)/;

/** The line a tool call shows in the feed. */
function toolSummary(name: string, input: Json): string {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = str(input[key]);
      if (value) return value;
    }
    return undefined;
  };
  const named = pick(
    'file_path',
    'notebook_path',
    'pattern',
    'url',
    'path',
    'description',
    'query',
  );
  if (named) return oneLine(named, 200);
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} items`;
  return oneLine(JSON.stringify(input), 200);
}

/** One parser per process: it keeps the session id, the cwd and the open Bash calls. */
export function claudeParser(): CoderOutputParser {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  /** How the CLI is signed in, from the init line: `none` is a plan login (OAuth). */
  let apiKeySource: string | undefined;
  /** Bash calls by tool use id, so a failed result can name its command. */
  const commands = new Map<string, string>();

  const relative = (path: string) =>
    cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;

  function assistant(message: Json): CoderEvent[] {
    const events: CoderEvent[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === 'text') {
        const text = str(block.text)?.trim();
        if (text) events.push({ type: 'text', text });
        continue;
      }
      if (block.type !== 'tool_use') continue;
      const name = str(block.name) ?? 'tool';
      const input = isObject(block.input) ? block.input : {};
      const id = str(block.id);
      if (name === 'Bash') {
        const command = str(input.command) ?? '';
        if (id) commands.set(id, command);
        events.push({ type: 'command', command });
      } else if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
        const path = str(input.file_path) ?? str(input.notebook_path) ?? '';
        events.push({ type: 'file_change', path: relative(path), kind: 'edit' });
      } else if (name === 'Write') {
        // Write makes or overwrites a whole file; the call does not say which.
        events.push({
          type: 'file_change',
          path: relative(str(input.file_path) ?? ''),
          kind: 'create',
        });
      } else {
        events.push({ type: 'tool_use', name, summary: toolSummary(name, input) });
      }
    }
    return events;
  }

  function toolResults(message: Json): CoderEvent[] {
    const events: CoderEvent[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id);
      const command = id ? commands.get(id) : undefined;
      if (id) commands.delete(id);
      // A command that worked needs no second line; a failed one says how.
      if (command === undefined || block.is_error !== true) continue;
      const text = resultText(block.content);
      const code = EXIT_CODE.exec(text);
      const rest = text.replace(EXIT_CODE, '').trim();
      events.push({
        type: 'command',
        command,
        ...(code ? { exit_code: Number(code[1]) } : {}),
        ...(rest ? { summary: oneLine(rest.split('\n')[0] ?? rest, 200) } : {}),
      });
    }
    return events;
  }

  function result(line: Json): CoderEvent[] {
    const usage = isObject(line.usage) ? line.usage : {};
    const cost = typeof line.total_cost_usd === 'number' ? line.total_cost_usd : undefined;
    // A heuristic: Claude Code reports `total_cost_usd` on every result, as an
    // estimate even on a plan. The init line's `apiKeySource` is the better
    // sign (`none` means a plan login), so it wins when the stream has one;
    // otherwise a zero or absent cost reads as a plan.
    const billed =
      apiKeySource !== undefined
        ? apiKeySource === 'none'
          ? 'subscription'
          : 'api'
        : !cost
          ? 'subscription'
          : 'api';
    const ok = line.subtype === 'success' && line.is_error !== true;
    const text = str(line.result)?.trim() ?? '';
    const reported = str(line.session_id);
    const forged = reported !== undefined && !isVendorSessionId(reported);
    const vendor = (forged ? undefined : reported) ?? sessionId;
    const failure =
      line.subtype === 'error_max_turns'
        ? `Stopped after ${num(line.num_turns) || 'the maximum'} turns`
        : line.subtype === 'error_during_execution'
          ? 'Claude Code stopped with an error'
          : text || 'Claude Code did not finish';
    return [
      ...(forged ? [ignoredId()] : []),
      {
        type: 'usage',
        input_tokens:
          num(usage.input_tokens) +
          num(usage.cache_creation_input_tokens) +
          num(usage.cache_read_input_tokens),
        output_tokens: num(usage.output_tokens),
        ...(cost !== undefined && cost >= 0 ? { cost_usd: cost } : {}),
        billed,
      },
      {
        type: 'result',
        ok,
        summary: text || (ok ? '' : failure),
        ...(vendor ? { vendor_session_id: vendor } : {}),
        ...(ok ? {} : { error: failure }),
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
        case 'system': {
          if (line.subtype !== 'init') return [];
          cwd = str(line.cwd) ?? cwd;
          apiKeySource = str(line.apiKeySource) ?? apiKeySource;
          const reported = str(line.session_id);
          if (reported === undefined) return [];
          if (!isVendorSessionId(reported)) return [ignoredId()];
          sessionId = reported;
          return [];
        }
        case 'assistant':
          return isObject(line.message) ? assistant(line.message) : [];
        case 'user':
          return isObject(line.message) ? toolResults(line.message) : [];
        case 'result':
          return result(line);
        default:
          return [];
      }
    },
    end: () => [],
  };
}

/** A tool result's content as text: a string, or text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isObject(block) && block.type === 'text' ? (str(block.text) ?? '') : ''))
    .join('\n');
}

// Signing in
//
// `claude auth login --claudeai` in a PTY, with BROWSER=/bin/true so it never
// tries a browser on the computer. It prints "If the browser didn't open,
// visit:" with the link (an OSC 8 link around the same text), then "Paste
// code here if prompted > " and waits. The owner pastes the `code#state` the
// page shows; one without the `#` is refused with "Invalid code..." and the
// prompt waits again. "Login successful." ends it with exit 0, "Login
// failed: ..." on stderr with exit 1. The credentials land in
// `$CLAUDE_CONFIG_DIR/.credentials.json`; nothing secret is printed, so
// nothing leaves the computer. Closing stdin does not end the process, so
// the driver kills it at its timeout.

const LOGIN_URL = /https:\/\/claude\.com\/cai\/oauth\/authorize[^\s"'<>]+/;
const PASTE_PROMPT = /paste code here/i;
const SIGNED_IN = /login successful/i;
const LOGIN_ERROR = /(?:^|\n)\s*(?:login failed|oauth error|error)[:\s]+([^\n]+)/i;
const INVALID_CODE = /invalid code\.[^\n]*/i;

function parseLogin(chunk: string, state: CoderLoginParse): CoderLoginParse {
  const text = stripAnsi(chunk);
  const next = { ...state };
  if (!next.url) {
    const url = LOGIN_URL.exec(text)?.[0].replace(/[).,;]+$/, '');
    if (url) next.url = url;
  }
  if (!next.signedIn && PASTE_PROMPT.test(text)) next.awaitingCode = true;
  const invalid = INVALID_CODE.exec(text)?.[0];
  if (invalid && !next.signedIn) next.notice = oneLine(invalid, 300);
  if (SIGNED_IN.test(text)) {
    next.signedIn = true;
    next.awaitingCode = false;
    delete next.notice;
  }
  const error = LOGIN_ERROR.exec(text)?.[1]?.trim();
  if (error && !next.signedIn) next.error = oneLine(error, 300);
  return next;
}

/**
 * `claude auth status` prints JSON (exit 1 when signed out): `loggedIn`, and
 * `authMethod` `claude.ai` for a plan sign-in or `oauth_token` for a token
 * in the environment. It checks the local credentials only; a lapsed one
 * still shows in a session's own output (`needsLogin`).
 */
export function claudeStatus(stdout: string): CoderSignInCheck | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isObject(parsed) || typeof parsed.loggedIn !== 'boolean') return null;
  if (!parsed.loggedIn) return { signedIn: false };
  const method = str(parsed.authMethod);
  if (method === 'claude.ai') {
    const email = str(parsed.email)?.trim();
    return {
      signedIn: true,
      authKind: 'subscription',
      label: email && !/[\s<>]/.test(email) ? email.slice(0, 200) : 'Claude account',
    };
  }
  return {
    signedIn: true,
    authKind: 'api_key',
    label: method === 'oauth_token' ? 'Token from the environment' : 'API key through Claude Code',
  };
}

// Classifying permission prompts (classify.ts reads commands and paths)

/** The tools whose `file_path` (or `notebook_path`, `path`) is where they read or write. */
const PATH_TOOLS = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Read',
  'Grep',
  'Glob',
  'LS',
]);

function classify(
  toolName: string,
  input: unknown,
  context?: { worktreePath: string },
): ReturnType<CoderAdapter['classify']> {
  const args = isObject(input) ? input : {};
  const root = context?.worktreePath;
  if (toolName === 'Bash') return classifyCommandLine(str(args.command) ?? '', root);
  const path = str(args.file_path) ?? str(args.notebook_path) ?? str(args.path);
  if (path && PATH_TOOLS.has(toolName)) {
    const verb = toolName === 'Write' ? 'Write' : toolName === 'Read' ? 'Read' : 'Edit';
    const verdict = classifyPathAccess(verb, path, root);
    if (verdict) return verdict;
  }
  // Disallowed at launch; one that arrives anyway asks, since it reaches off the computer.
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    const target = str(args.url) ?? str(args.query);
    const verb = toolName === 'WebFetch' ? 'Fetch' : 'Search the web';
    return {
      action: 'outside_worktree',
      title: target ? `${verb}: ${oneLine(target, 200)}` : `Use ${toolName}`,
    };
  }
  if (path) return { action: 'other', title: `${toolName}: ${path}` };
  return { action: 'other', title: `Use ${toolName}` };
}

/**
 * What Claude Code says when it is not signed in ("Not logged in · Please
 * run /login" from `-p`), or its sign-in lapsed or was refused ("Failed to
 * authenticate. API Error: 401").
 */
const NOT_SIGNED_IN =
  /not logged in|invalid api key|invalid bearer token|please run \/login|oauth token has expired|failed to authenticate|\b401\b|authentication_error/i;

/** A 429 from the API, or the plan's usage limit ("Claude AI usage limit reached|<reset>"). */
const RATE_LIMITED = /\b429\b|rate[ _-]?limit|usage limit reached/i;

export const claudeAdapter: CoderAdapter = {
  agent: 'claude',
  command: 'claude',
  versionArgs: ['--version'],
  signIn: {
    kind: 'pty',
    instructions: 'Open the link, sign in to Claude, copy the code it shows and paste it here.',
    hosts: [
      'claude.com',
      'claude.ai',
      'platform.claude.com',
      'console.anthropic.com',
      'anthropic.com',
    ],
    // Whether a session on this sign-in bills the plan is still to be seen
    // with a real Pro or Max account (docs/CODING_AGENT_VENDORS.md).
    login: () => ({
      command: 'claude',
      args: ['auth', 'login', '--claudeai'],
      env: { BROWSER: '/bin/true' },
      timeoutMs: 10 * 60_000,
    }),
    parseLogin,
  },
  launch,
  parser: claudeParser,
  // Only a UUID reaches the terminal's preset.
  resumeCommand: (vendorSessionId) =>
    isVendorSessionId(vendorSessionId) ? `claude --resume ${vendorSessionId}` : 'claude',
  classify,
  needsLogin: (text) => NOT_SIGNED_IN.test(text),
  rateLimited: (text) => RATE_LIMITED.test(text),
  checkSignIn: async (ctx) => {
    const done = await ctx.run(['auth', 'status']);
    return done ? claudeStatus(done.stdout) : null;
  },
};
