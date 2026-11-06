import { posix } from 'node:path';
import { CODER_PERMISSION_MCP } from '@openbots/computer';
import { CODER_FEED_LINE_MAX, type CoderActionClass, type CoderEvent } from '@openbots/shared';
import {
  IGNORED_SESSION_ID,
  isVendorSessionId,
  type CoderAdapter,
  type CoderLaunchPlan,
  type CoderLoginParse,
  type CoderOutputParser,
  type CoderSessionSpec,
} from './types.js';

// Claude Code (design doc, "The three agents"; I10, I11). The session runs
// `claude -p` headless with `--output-format stream-json`, one JSON object
// per line: a `system` init with the session id, `assistant` messages whose
// content blocks are text and tool calls, `user` messages carrying the tool
// results, and one `result` with the summary, the cost and the usage. Edits
// inside the worktree are accepted by `--permission-mode acceptEdits`;
// every other prompt, every Bash command among them, reaches OpenBots through
// `--permission-prompt-tool`, the small stdio MCP server in the image that
// relays each prompt over the session socket. `git push` is refused outright,
// since OpenBots pushes after the owner approves, and so are WebFetch and
// WebSearch, which could carry what the agent read off the computer.
//
// The read tools (Read, Grep, Glob, LS) are not pre-allowed: Claude Code
// lets them read inside its working directory on its own and prompts for a
// read outside it, which then meets `classify` and the `outside_worktree`
// class. Pre-allowing them unscoped would let a read of the sign-in files
// under /var/lib/openbots skip the prompt.
//
// The fixtures under services/__fixtures__/coders/ are hand made from the
// stream-json format as documented; refresh them from the CLI version pinned
// in docker/coders/package.json whenever the pin moves.

/** The MCP server name in `--mcp-config` and the tool `--permission-prompt-tool` names. */
const MCP_SERVER = 'openbots';
const PERMISSION_TOOL = `mcp__${MCP_SERVER}__permission_prompt`;

/**
 * Nothing is pre-allowed through `--allowedTools`. Edits inside the worktree
 * are accepted by `--permission-mode acceptEdits`, and reads inside the
 * working directory are Claude Code's own default; an unscoped Edit or Write
 * rule would match a path outside the worktree before that check. Every Bash
 * command is classified by OpenBots through the permission tool, since a
 * prefix rule such as `git diff*` also matches `git diff --no-index` on the
 * sign-in files or `--output=` to any path. `classify` classes git's read and
 * commit commands and the test runners inside the worktree as `other`, so
 * with the default policy they still run without a prompt.
 */

/** Never run by the agent: OpenBots pushes after the owner approves. */
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

export function preamble(spec: CoderSessionSpec): string {
  const lines = [
    `You are working for OpenBots in the git worktree ${spec.worktreePath}, on the branch ${spec.branch}, made from ${spec.base} of ${spec.repoFullName}.`,
    'Commit as you go, with clear messages.',
    'Do not push: OpenBots pushes the branch after the owner approves.',
    "Run the repository's tests when it has them.",
    'Finish with a short summary of what changed and what the owner should verify.',
  ];
  if (spec.coAuthor) {
    lines.push(
      `End every commit message with this trailer line: Co-Authored-By: ${spec.coAuthor.name} <${spec.coAuthor.email}>`,
    );
  }
  if (spec.mode === 'plan') {
    lines.push('This session only plans: do not edit files. Read the code and write a plan.');
  }
  return lines.join(' ');
}

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
    spec.mode === 'plan' ? 'plan' : 'acceptEdits',
    '--disallowedTools',
    ...disallowed,
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
  };
  if (spec.gitIdentity) {
    env.GIT_AUTHOR_NAME = spec.gitIdentity.name;
    env.GIT_AUTHOR_EMAIL = spec.gitIdentity.email;
    env.GIT_COMMITTER_NAME = spec.gitIdentity.name;
    env.GIT_COMMITTER_EMAIL = spec.gitIdentity.email;
  }
  return { command: 'claude', args, env };
}

// Parsing stream-json

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

const oneLine = (text: string, max = CODER_FEED_LINE_MAX) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

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

/** A feed line saying a session id was dropped (`isVendorSessionId`). */
const ignoredId = (): CoderEvent => ({ type: 'text', text: IGNORED_SESSION_ID });

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

/** CSI and OSC escapes a terminal login prints around its text. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export const stripAnsi = (text: string) => text.replace(ANSI, '');

const LOGIN_URL = /https:\/\/[^\s"'<>]+/;
const PASTE_PROMPT =
  /paste (?:the |your )?code|enter (?:the |your )?code|authorization code|code here/i;
const SIGNED_IN =
  /login successful|logged in|successfully signed in|sk-ant-oat\w*-|long-lived authentication token/i;
const LOGIN_ERROR = /(?:^|\n)\s*(?:error|login failed|oauth error)[:\s]+([^\n]+)/i;

function parseLogin(chunk: string, state: CoderLoginParse): CoderLoginParse {
  const text = stripAnsi(chunk);
  const next = { ...state };
  if (!next.url) {
    const url = LOGIN_URL.exec(text)?.[0].replace(/[).,;]+$/, '');
    if (url) next.url = url;
  }
  if (!next.signedIn && PASTE_PROMPT.test(text)) next.awaitingCode = true;
  // `setup-token` ends by printing the token itself: it marks success and is
  // never copied anywhere.
  if (SIGNED_IN.test(text)) {
    next.signedIn = true;
    next.awaitingCode = false;
  }
  const error = LOGIN_ERROR.exec(text)?.[1]?.trim();
  if (error && !next.signedIn) next.error = oneLine(error, 300);
  return next;
}

// Classifying permission prompts
//
// The class decides whether the owner is asked (`coderActionDecision`), so a
// command is read the way the shell would run it, not matched as a string:
// it is split into words (quotes and escapes honoured), compound commands
// are split on `;`, `&&`, `||`, `|`, `&` and newlines, `$(…)`, backticks and
// `sh -c` bodies are read as commands of their own, and each simple command
// is classed by its argv. The strictest class wins. A path the classifier
// cannot resolve without running the shell (`~`, `$VAR`, `..`, a
// substitution) counts as outside the worktree, which asks.
//
// This is a convenience layer, not the boundary. `other` stays `auto` for
// owner-started runs (design decision 4), and a command the classifier
// misreads still meets the hard controls that do not depend on it: the
// process runs as the `coder` uid, whose filesystem permissions keep it out
// of /home/bot outside the repositories and out of the state volume's other
// directories; the credential helper serves a push credential only for a
// session the owner approved a push for; and the computer's sandbox
// firewall (and egress proxy, when set) is the same as for every Bot.

/** Strictest first, as `strictest` compares them. */
const CLASS_RANK: Record<CoderActionClass, number> = {
  destructive: 5,
  push: 4,
  pr: 3,
  install: 2,
  outside_worktree: 1,
  other: 0,
};

const strictest = (a: CoderActionClass, b: CoderActionClass): CoderActionClass =>
  CLASS_RANK[b] > CLASS_RANK[a] ? b : a;

/** A word of a simple command, and whether its text depends on the shell (`$`, backticks). */
interface Word {
  text: string;
  dynamic: boolean;
}

/** One simple command: its words, and what joined it to the previous one. */
interface SimpleCommand {
  words: Word[];
  /** Piped into from the previous command. */
  piped: boolean;
}

interface Parsed {
  commands: SimpleCommand[];
  /** The bodies of `$(…)` and backticks, read as commands of their own. */
  nested: string[];
  /** Quotes left open: the shell would refuse it, and the rest cannot be read. */
  unbalanced: boolean;
}

/** The shell's control operators, longest first. */
const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n', '(', ')'];

/** Reads a command line into simple commands, as POSIX sh splits words. */
export function parseShell(source: string): Parsed {
  const commands: SimpleCommand[] = [];
  const nested: string[] = [];
  let words: Word[] = [];
  let piped = false;
  let nextPiped = false;
  let text = '';
  let dynamic = false;
  let inWord = false;
  let unbalanced = false;

  const endWord = () => {
    if (inWord) words.push({ text, dynamic });
    text = '';
    dynamic = false;
    inWord = false;
  };
  const endCommand = (pipe: boolean) => {
    endWord();
    if (words.length) commands.push({ words, piped });
    words = [];
    piped = pipe || nextPiped;
    nextPiped = false;
  };
  /** The index just past the `)` that closes the `$(` opened before `start`. */
  const closeParen = (start: number) => {
    let depth = 1;
    let quote: string | null = null;
    for (let j = start; j < source.length; j++) {
      const c = source[j]!;
      if (quote) {
        if (c === '\\' && quote === '"') j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '\\') j++;
      else if (c === "'" || c === '"') quote = c;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j;
    }
    return -1;
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    // Substitutions, in or out of double quotes: their body runs too.
    if (c === '$' && source[i + 1] === '(') {
      const end = closeParen(i + 2);
      if (end < 0) {
        unbalanced = true;
        nested.push(source.slice(i + 2));
        break;
      }
      nested.push(source.slice(i + 2, end));
      text += source.slice(i, end + 1);
      dynamic = inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '`') {
      const end = source.indexOf('`', i + 1);
      if (end < 0) {
        unbalanced = true;
        nested.push(source.slice(i + 1));
        break;
      }
      nested.push(source.slice(i + 1, end));
      text += source.slice(i, end + 1);
      dynamic = inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '\\') {
      // A line continuation joins lines; any other escaped character is literal.
      if (source[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < source.length) {
        text += source[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) {
        unbalanced = true;
        text += source.slice(i + 1);
        inWord = true;
        break;
      }
      const quoted = source.slice(i + 1, end);
      text += quoted;
      // Literal to the shell, but a `$` here still reads as unresolved to us.
      if (/[$`]/.test(quoted)) dynamic = true;
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      inWord = true;
      while (j < source.length) {
        const d = source[j]!;
        if (d === '\\' && '"\\$`\n'.includes(source[j + 1] ?? '')) {
          if (source[j + 1] !== '\n') text += source[j + 1];
          j += 2;
          continue;
        }
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === '$' && source[j + 1] === '(') {
          const end = closeParen(j + 2);
          if (end < 0) break;
          nested.push(source.slice(j + 2, end));
          text += source.slice(j, end + 1);
          dynamic = true;
          j = end + 1;
          continue;
        }
        if (d === '`') {
          const end = source.indexOf('`', j + 1);
          if (end < 0) break;
          nested.push(source.slice(j + 1, end));
          text += source.slice(j, end + 1);
          dynamic = true;
          j = end + 1;
          continue;
        }
        if (d === '$') dynamic = true;
        text += d;
        j++;
      }
      if (!closed) {
        unbalanced = true;
        break;
      }
      i = j + 1;
      continue;
    }
    const operator = OPERATORS.find((op) => source.startsWith(op, i));
    if (operator) {
      endCommand(operator === '|' || operator === '|&');
      i += operator.length;
      continue;
    }
    // Redirections are words of their own, so the path after one is checked.
    if (c === '>' || c === '<') {
      endWord();
      const op = /^(?:>>|>&|<<<|<<|<>|>\||>|<)/.exec(source.slice(i))![0];
      words.push({ text: op, dynamic: false });
      i += op.length;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    if (c === '$') dynamic = true;
    text += c;
    inWord = true;
    i++;
  }
  endCommand(false);
  return { commands, nested, unbalanced };
}

/** Paths that name no file the command could harm. */
const HARMLESS_PATHS = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/stdin',
  '/dev/tty',
]);

/** The state volume, where the agents' sign-ins live: any mention of it is destructive. */
const STATE_PATH = /^\/var\/lib\/openbots(?:\/|$)/;
const ETC_PATH = /^\/etc(?:\/|$)/;

/** `path` normalized is `root` or under it; `/repos/x-other` is not under `/repos/x`. */
function inside(path: string, root: string) {
  const normal = posix.normalize(path).replace(/\/+$/, '') || '/';
  const base = posix.normalize(root).replace(/\/+$/, '') || '/';
  return normal === base || normal.startsWith(`${base}/`);
}

/** Has a `..` segment: `..`, `../x`, `x/../y`, `x/..`. */
const PARENT_SEGMENT = /(?:^|\/)\.\.(?:\/|$)/;

type PathVerdict = { kind: 'inside' } | { kind: 'outside'; path: string } | { kind: 'state' };

/**
 * Where a word points, if it is a path. `~`, `$`, backticks and `..` cannot
 * be resolved without the shell, so they read as outside; an absolute path
 * must be under the worktree; a relative one resolves against `cwd`.
 */
function pathVerdict(word: Word, cwd: string | undefined, root: string | undefined): PathVerdict {
  // `--output=/tmp/x` and `NAME=/tmp/x` name a path after the `=`.
  const text = /^(?:--?[\w-]+|[A-Za-z_]\w*)=(.*)$/s.exec(word.text)?.[1] ?? word.text;
  if (word.dynamic || /[$`]/.test(text)) return { kind: 'outside', path: text };
  if (text.startsWith('~')) return { kind: 'outside', path: text };
  if (PARENT_SEGMENT.test(text)) return { kind: 'outside', path: text };
  if (text.startsWith('/')) {
    if (STATE_PATH.test(posix.normalize(text))) return { kind: 'state' };
    if (HARMLESS_PATHS.has(text) || !root) return { kind: 'inside' };
    return inside(text, root) ? { kind: 'inside' } : { kind: 'outside', path: text };
  }
  if (!root || !cwd) return { kind: 'inside' };
  return inside(posix.resolve(cwd, text), root)
    ? { kind: 'inside' }
    : { kind: 'outside', path: text };
}

const base = (command: string) => command.split('/').pop() ?? command;

/** Commands that run as another user or change ownership, modes or disks. */
const DESTRUCTIVE_COMMANDS = new Set([
  'sudo',
  'su',
  'doas',
  'chmod',
  'chown',
  'chgrp',
  'dd',
  'pkill',
  'killall',
  'crontab',
  'shutdown',
  'reboot',
  'mount',
  'umount',
  'shred',
]);

/** Commands that write the paths they name. */
const WRITERS = new Set([
  'tee',
  'cp',
  'mv',
  'ln',
  'install',
  'rsync',
  'touch',
  'mkdir',
  'rm',
  'rmdir',
  'truncate',
  'sed',
  'perl',
]);

/** Package managers and their install verbs. */
const INSTALL_VERBS: Record<string, Set<string>> = {
  npm: new Set(['i', 'install', 'add', 'ci', 'isntall', 'in']),
  pnpm: new Set(['i', 'install', 'add']),
  yarn: new Set(['add', 'install']),
  bun: new Set(['i', 'install', 'add']),
  pip: new Set(['install']),
  pip3: new Set(['install']),
  pipx: new Set(['install']),
  uv: new Set(['add', 'pip']),
  cargo: new Set(['install']),
  go: new Set(['install', 'get']),
  gem: new Set(['install']),
};
const ALWAYS_INSTALL = new Set([
  'apt',
  'apt-get',
  'brew',
  'dnf',
  'yum',
  'apk',
  'npx',
  'pnpx',
  'bunx',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const FETCHERS = new Set(['curl', 'wget']);

/** Prefixes that run the rest of the argv as a command: skipped, with their own options. */
const WRAPPERS = new Set([
  'env',
  'nohup',
  'time',
  'nice',
  'ionice',
  'command',
  'builtin',
  'exec',
  'stdbuf',
  'timeout',
  'xargs',
]);

/** git's options before the subcommand that take a value as the next word. */
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
  '--list-cmds',
]);

/** git config keys that can send git's credentials or commands somewhere else. */
const REDIRECTING_KEY =
  /^(?:remote\.|credential\.|core\.sshcommand$|core\.gitproxy$|core\.hookspath$|core\.fsmonitor$|http\.|alias\.|url\..*\.(?:push)?insteadof$|include\.|includeif\.)/i;

/** What one simple command does, and the paths it names. */
interface Verdict {
  action: CoderActionClass;
  paths: string[];
}

function gitClass(args: Word[]): { action: CoderActionClass; dirs: Word[] } {
  let action: CoderActionClass = 'other';
  const dirs: Word[] = [];
  let i = 0;
  // Global options, `-C /x -c a=b --git-dir=.git`, before the subcommand.
  while (i < args.length && args[i]!.text.startsWith('-')) {
    const option = args[i]!.text;
    const [name, inline] = option.includes('=')
      ? [option.slice(0, option.indexOf('=')), option.slice(option.indexOf('=') + 1)]
      : [option, undefined];
    if (GIT_VALUE_OPTIONS.has(name)) {
      const value = inline ?? args[i + 1]?.text ?? '';
      const valueWord =
        inline !== undefined ? { text: inline, dynamic: args[i]!.dynamic } : args[i + 1];
      if (name === '-c' && REDIRECTING_KEY.test(value.split('=')[0] ?? '')) action = 'destructive';
      if (name === '--config-env') action = 'destructive';
      if ((name === '-C' || name === '--git-dir' || name === '--work-tree') && valueWord)
        dirs.push(valueWord);
      i += inline !== undefined ? 1 : 2;
      continue;
    }
    i++;
  }
  const sub = args[i]?.text;
  const rest = args.slice(i + 1).map((w) => w.text);
  const has = (...flags: string[]) => rest.some((a) => flags.includes(a));
  switch (sub) {
    case 'push':
      return { action: strictest(action, 'push'), dirs };
    case 'send-pack':
      return { action: strictest(action, 'push'), dirs };
    case 'remote':
      if (rest[0] === 'set-url' || rest[0] === 'add' || rest[0] === 'rename')
        action = 'destructive';
      break;
    case 'config':
      if (has('-e', '--edit') || rest.some((a) => REDIRECTING_KEY.test(a))) action = 'destructive';
      break;
    case 'reset':
      if (has('--hard', '--merge', '--keep')) action = 'destructive';
      break;
    case 'clean':
    case 'filter-branch':
    case 'filter-repo':
    case 'update-ref':
      action = 'destructive';
      break;
    case 'branch':
      if (has('-D') || (has('-d', '--delete') && has('-f', '--force'))) action = 'destructive';
      break;
    case 'reflog':
      if (rest[0] === 'expire' || rest[0] === 'delete') action = 'destructive';
      break;
    case 'gc':
      if (rest.some((a) => a.startsWith('--prune'))) action = 'destructive';
      break;
    case 'credential':
    case 'credential-store':
    case 'credential-cache':
      action = 'destructive';
      break;
  }
  return { action, dirs };
}

/** gh subcommand verbs that only read. */
const GH_READS = new Set(['view', 'list', 'status', 'diff', 'checks', 'search', 'browse']);

function ghClass(args: Word[]): CoderActionClass {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.text;
    if (a === '-R' || a === '--repo' || a === '--hostname') {
      i++;
      continue;
    }
    if (a.startsWith('--repo=') || a.startsWith('--hostname=') || /^-R.+/.test(a)) continue;
    rest.push(a);
  }
  const [group, verb] = rest;
  if (!group) return 'other';
  if (['auth', 'secret', 'ssh-key', 'gpg-key', 'variable', 'extension', 'alias'].includes(group)) {
    return 'destructive';
  }
  if (group === 'repo' && verb && ['delete', 'rename', 'archive', 'edit'].includes(verb)) {
    return 'destructive';
  }
  if (group === 'api') {
    const writes = rest.some(
      (a, i) =>
        ['-f', '-F', '--field', '--raw-field', '--input'].includes(a) ||
        /^--(?:raw-)?field=/.test(a) ||
        ((a === '-X' || a === '--method') && rest[i + 1]?.toUpperCase() !== 'GET') ||
        /^(?:-X|--method=)(?!GET$)/i.test(a),
    );
    if (writes || rest.some((a) => /\bpulls\b/.test(a))) return 'pr';
    return 'other';
  }
  if (verb && GH_READS.has(verb)) return 'other';
  return 'pr';
}

/** `rm` with both recursive and force, in any spelling. */
function recursiveForce(args: string[]) {
  let recursive = false;
  let force = false;
  for (const a of args) {
    if (a === '--') break;
    if (a === '--recursive') recursive = true;
    else if (a === '--force') force = true;
    else if (/^-[^-]/.test(a)) {
      if (/[rR]/.test(a)) recursive = true;
      if (a.includes('f')) force = true;
    }
  }
  return recursive && force;
}

/** A simple command's argv, past `NAME=value` assignments and wrappers like `env` and `timeout`. */
function unwrap(words: Word[]): { argv: Word[]; assignments: Word[] } {
  const assignments: Word[] = [];
  let i = 0;
  for (;;) {
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i]!.text)) assignments.push(words[i++]!);
    const name = words[i] ? base(words[i]!.text) : undefined;
    if (!name || !WRAPPERS.has(name)) break;
    i++;
    // The wrapper's own options (and `timeout`'s duration, `nice -n 5`).
    while (i < words.length) {
      const a = words[i]!.text;
      if (a === '--') {
        i++;
        break;
      }
      if (/^-/.test(a)) {
        i += /^-(?:n|s|k|u|S|C|I|d|L|P)$/.test(a) ? 2 : 1;
        continue;
      }
      if (name === 'timeout' && /^\d/.test(a)) {
        i++;
        continue;
      }
      break;
    }
  }
  return { argv: words.slice(i), assignments };
}

interface ShellVerdict {
  action: CoderActionClass;
  /** Paths outside the worktree it names, for the prompt's detail. */
  outside: string[];
}

/** Every class in a command line, the strictest winning, with the paths outside it names. */
function classifyShell(source: string, root: string | undefined, depth = 0): ShellVerdict {
  const parsed = parseShell(source);
  let action: CoderActionClass = 'other';
  const outside: string[] = [];
  if (parsed.unbalanced) action = 'outside_worktree';
  // Too deeply nested to follow: ask.
  if (depth > 4) return { action: 'outside_worktree', outside: [] };
  for (const body of parsed.nested) {
    const inner = classifyShell(body, root, depth + 1);
    action = strictest(action, inner.action);
    outside.push(...inner.outside);
  }
  let cwd = root;
  let fetched = false;
  for (const command of parsed.commands) {
    if (!command.piped) fetched = false;
    const verdict = classifyCommand(command.words, cwd, root, depth);
    action = strictest(action, verdict.action);
    outside.push(...verdict.paths);
    const name = verdict.name;
    // `curl … | sh`: a script from the network runs.
    if (command.piped && fetched && name && (SHELLS.has(name) || /^python\d?$/.test(name))) {
      action = strictest(action, 'install');
    }
    if (name && FETCHERS.has(name)) fetched = true;
    if (verdict.cd !== undefined) cwd = verdict.cd ?? undefined;
  }
  return { action, outside };
}

function classifyCommand(
  words: Word[],
  cwd: string | undefined,
  root: string | undefined,
  depth: number,
): Verdict & { name?: string; cd?: string | null } {
  const { argv, assignments } = unwrap(words);
  let action: CoderActionClass = 'other';
  const paths: string[] = [];
  const check = (word: Word, writes = false) => {
    const verdict = pathVerdict(word, cwd, root);
    if (verdict.kind === 'state') action = 'destructive';
    else if (verdict.kind === 'outside') {
      action = strictest(action, 'outside_worktree');
      paths.push(verdict.path);
      if (writes && ETC_PATH.test(posix.normalize(verdict.path))) action = 'destructive';
    }
  };
  for (const word of assignments) check(word);
  if (!argv.length) return { action, paths };
  const head = argv[0]!;
  // A command named by a variable or a substitution could be anything.
  if (head.dynamic) action = strictest(action, 'outside_worktree');
  const name = base(head.text);
  const args = argv.slice(1);
  const texts = args.map((w) => w.text);

  // Redirection targets are written (or read): checked as paths.
  for (let i = 0; i < args.length; i++) {
    if (/^[<>]/.test(args[i]!.text) && args[i + 1]) {
      const writes = args[i]!.text.startsWith('>');
      check(args[i + 1]!, writes);
    }
  }
  const writes =
    WRITERS.has(name) &&
    (name !== 'sed' || texts.some((a) => /^-[^-]*i/.test(a) || a === '--in-place'));
  for (const word of args) {
    if (/^[<>]/.test(word.text)) continue;
    // A bare option names no path; `--out=/x` does, and pathVerdict reads it.
    if (/^-[\w-]*$/.test(word.text)) continue;
    check(word, writes);
  }

  if (DESTRUCTIVE_COMMANDS.has(name) || /^mkfs(?:\.|$)/.test(name)) action = 'destructive';
  if (
    name === 'kill' &&
    texts.some((a) => a === '-9' || /^-(?:s\s*)?(?:SIG)?KILL$/i.test(a) || a === '-KILL')
  ) {
    action = 'destructive';
  }
  if (
    name === 'kill' &&
    texts.some((a, i) => a === '-s' && /^(?:SIG)?KILL$|^9$/i.test(texts[i + 1] ?? ''))
  ) {
    action = 'destructive';
  }
  if (name === 'rm' && recursiveForce(texts)) action = 'destructive';
  if (name === 'git') {
    const git = gitClass(args);
    action = strictest(action, git.action);
  }
  if (name === 'gh') action = strictest(action, ghClass(args));
  if (ALWAYS_INSTALL.has(name)) action = strictest(action, 'install');
  const verbs = INSTALL_VERBS[name];
  if (verbs && texts.some((a) => verbs.has(a))) action = strictest(action, 'install');
  if (
    /^python\d?(?:\.\d+)?$/.test(name) &&
    texts[0] === '-m' &&
    /^pip\d?$/.test(texts[1] ?? '') &&
    texts[2] === 'install'
  ) {
    action = strictest(action, 'install');
  }
  // `sh -c '…'` and `eval …` run their argument as a command line.
  if (SHELLS.has(name)) {
    const at = texts.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (at >= 0 && texts[at + 1] !== undefined) {
      const inner = classifyShell(texts[at + 1]!, root, depth + 1);
      action = strictest(action, inner.action);
      paths.push(...inner.outside);
    }
  }
  if (name === 'eval' || name === 'source' || name === '.') {
    const inner = name === 'eval' ? classifyShell(texts.join(' '), root, depth + 1) : null;
    action = strictest(action, inner?.action ?? 'outside_worktree');
    if (inner) paths.push(...inner.outside);
  }
  let cd: string | null | undefined;
  if (name === 'cd' || name === 'pushd') {
    const target = args.find((w) => !/^-[LPe@]$/.test(w.text));
    if (!target || target.text === '-') {
      // Home, or wherever the last one was: not the worktree.
      action = strictest(action, 'outside_worktree');
      paths.push(target?.text ?? '~');
      cd = null;
    } else {
      const verdict = pathVerdict(target, cwd, root);
      cd = verdict.kind === 'inside' && cwd ? posix.resolve(cwd, target.text) : null;
    }
  }
  return { action, paths, name, ...(cd !== undefined ? { cd } : {}) };
}

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
  if (toolName === 'Bash') {
    const command = str(args.command) ?? '';
    const title = `Run: ${oneLine(command, 200)}`;
    const detail = command.length > 200 ? command : undefined;
    const { action, outside } = classifyShell(command, root);
    if (action === 'outside_worktree') {
      const named = [...new Set(outside)];
      return {
        action,
        title: `Run outside the worktree: ${oneLine(command, 200)}`,
        detail: named.length ? `Touches ${named.join(', ')}` : 'Names a path the shell resolves',
      };
    }
    return { action, title, ...(detail ? { detail } : {}) };
  }
  const path = str(args.file_path) ?? str(args.notebook_path) ?? str(args.path);
  if (path && PATH_TOOLS.has(toolName)) {
    const verdict = pathVerdict({ text: path, dynamic: false }, root, root);
    const verb = toolName === 'Write' ? 'Write' : toolName === 'Read' ? 'Read' : 'Edit';
    if (verdict.kind === 'state') {
      return { action: 'destructive', title: `${verb} the computer's private state: ${path}` };
    }
    if (verdict.kind === 'outside') {
      return { action: 'outside_worktree', title: `${verb} outside the worktree: ${path}` };
    }
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

// What Claude Code says when it is not signed in, or its sign-in lapsed.
const NOT_SIGNED_IN =
  /not logged in|invalid api key|invalid bearer token|please run \/login|oauth token has expired|\b401\b|authentication_error/i;

export const claudeAdapter: CoderAdapter = {
  agent: 'claude',
  versionArgs: ['--version'],
  loginHosts: ['claude.ai', 'console.anthropic.com', 'platform.claude.com', 'anthropic.com'],
  launch,
  parser: claudeParser,
  // Only a UUID reaches the terminal's preset.
  resumeCommand: (vendorSessionId) =>
    isVendorSessionId(vendorSessionId) ? `claude --resume ${vendorSessionId}` : 'claude',
  // The week one spike decides between `setup-token` (a long-lived token,
  // reported to answer 401 on some versions) and the interactive login (a
  // link and a pasted code); see the design doc's "The three agents".
  login: () => ({ command: 'claude', args: ['setup-token'], timeoutMs: 10 * 60_000 }),
  parseLogin,
  classify,
  needsLogin: (text) => NOT_SIGNED_IN.test(text),
};
