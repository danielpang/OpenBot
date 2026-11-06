import { posix } from 'node:path';
import type { CoderActionClass } from '@openbots/shared';
import { oneLine } from './common.js';
import { parseShell, type Word } from './shell-words.js';
import type { CoderAdapter } from './types.js';

// Classifying permission prompts, for all three adapters
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
// owner-started runs (docs/TECHNICAL_PLAN.md 22.7), and a command the classifier
// misreads still meets the hard controls that do not depend on it: the
// process runs as the `coder` uid, whose filesystem permissions keep it out
// of /home/bot outside the repositories and out of the state volume's other
// directories; the credential helper serves a push credential only for a
// session the owner approved a push for; and the computer's sandbox
// firewall (and egress proxy, when set) is the same as for every Bot
// (SECURITY.md S-26).

/** Strictest first, as `strictest` compares them. */
export const CLASS_RANK: Record<CoderActionClass, number> = {
  destructive: 5,
  push: 4,
  pr: 3,
  install: 2,
  outside_worktree: 1,
  other: 0,
};

export const strictest = (a: CoderActionClass, b: CoderActionClass): CoderActionClass =>
  CLASS_RANK[b] > CLASS_RANK[a] ? b : a;

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

/** git subcommands whose plain arguments are paths (or revisions): a glob there names files. */
const GIT_PATH_SUBCOMMANDS = new Set([
  'add',
  'rm',
  'mv',
  'diff',
  'log',
  'status',
  'restore',
  'show',
  'grep',
  'ls-files',
  'blame',
  'commit',
  'checkout',
]);

function gitClass(args: Word[]): { action: CoderActionClass; dirs: Word[]; glob: boolean } {
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
  // A glob is read only once the shell expands it: in a global option, the
  // subcommand (`git pu?h`), a flag, or an argument of a subcommand whose
  // arguments are not paths (`git remote set-ur? …`, a config key).
  const pathArgs = sub !== undefined && GIT_PATH_SUBCOMMANDS.has(sub);
  const glob =
    args.slice(0, i + 1).some((w) => w.glob === true) ||
    args.slice(i + 1).some((w) => w.glob === true && (!pathArgs || w.text.startsWith('-')));
  const rest = args.slice(i + 1).map((w) => w.text);
  const has = (...flags: string[]) => rest.some((a) => flags.includes(a));
  switch (sub) {
    case 'push':
      return { action: strictest(action, 'push'), dirs, glob };
    case 'send-pack':
      return { action: strictest(action, 'push'), dirs, glob };
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
  return { action, dirs, glob };
}

/** gh subcommand verbs that only read. */
const GH_READS = new Set(['view', 'list', 'status', 'diff', 'checks', 'search', 'browse']);

function ghClass(args: Word[]): { action: CoderActionClass; glob: boolean } {
  const rest: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.text;
    if (a === '-R' || a === '--repo' || a === '--hostname') {
      i++;
      continue;
    }
    if (a.startsWith('--repo=') || a.startsWith('--hostname=') || /^-R.+/.test(a)) continue;
    rest.push(args[i]!);
  }
  return {
    action: ghAction(rest.map((w) => w.text)),
    // gh's arguments are names and values, not paths.
    glob: rest.some((w) => w.glob === true),
  };
}

function ghAction(rest: string[]): CoderActionClass {
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
  /** Some part uses shell syntax the reader does not model (`parseShell`). */
  unmodelled: boolean;
}

/** Every class in a command line, the strictest winning, with the paths outside it names. */
function classifyShell(source: string, root: string | undefined, depth = 0): ShellVerdict {
  const parsed = parseShell(source);
  let action: CoderActionClass = 'other';
  const outside: string[] = [];
  let unmodelled = parsed.unmodelled;
  if (parsed.unbalanced || unmodelled) action = 'outside_worktree';
  // Too deeply nested to follow: ask.
  if (depth > 4) return { action: 'outside_worktree', outside: [], unmodelled: true };
  for (const body of parsed.nested) {
    const inner = classifyShell(body, root, depth + 1);
    action = strictest(action, inner.action);
    outside.push(...inner.outside);
    unmodelled ||= inner.unmodelled;
  }
  let cwd = root;
  let fetched = false;
  for (const command of parsed.commands) {
    if (!command.piped) fetched = false;
    const verdict = classifyCommand(command.words, cwd, root, depth);
    action = strictest(action, verdict.action);
    outside.push(...verdict.paths);
    unmodelled ||= verdict.unmodelled ?? false;
    const name = verdict.name;
    // `curl … | sh`: a script from the network runs.
    if (command.piped && fetched && name && (SHELLS.has(name) || /^python\d?$/.test(name))) {
      action = strictest(action, 'install');
    }
    if (name && FETCHERS.has(name)) fetched = true;
    if (verdict.cd !== undefined) cwd = verdict.cd ?? undefined;
  }
  // A shape it could not read asks, whatever else it read.
  if (unmodelled) action = strictest(action, 'outside_worktree');
  return { action, outside, unmodelled };
}

function classifyCommand(
  words: Word[],
  cwd: string | undefined,
  root: string | undefined,
  depth: number,
): Verdict & { name?: string; cd?: string | null; unmodelled?: boolean } {
  const { argv, assignments } = unwrap(words);
  let action: CoderActionClass = 'other';
  const paths: string[] = [];
  let unmodelled = false;
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
  // `g*t push`: the shell picks the command from the files there.
  if (head.glob) unmodelled = true;
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
    if (git.glob) unmodelled = true;
  }
  if (name === 'gh') {
    const gh = ghClass(args);
    action = strictest(action, gh.action);
    if (gh.glob) unmodelled = true;
  }
  if (ALWAYS_INSTALL.has(name)) action = strictest(action, 'install');
  const verbs = INSTALL_VERBS[name];
  // An install tool's or `python -m`'s arguments name verbs and packages, not paths.
  if (verbs && args.some((w) => w.glob)) unmodelled = true;
  if (/^python\d?(?:\.\d+)?$/.test(name)) {
    const module = texts.indexOf('-m');
    if (
      module >= 0 ? args.some((w) => w.glob) : args.some((w) => w.glob && w.text.startsWith('-'))
    ) {
      unmodelled = true;
    }
  }
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
      unmodelled ||= inner.unmodelled;
    }
  }
  if (name === 'eval' || name === 'source' || name === '.') {
    const inner = name === 'eval' ? classifyShell(texts.join(' '), root, depth + 1) : null;
    action = strictest(action, inner?.action ?? 'outside_worktree');
    if (inner) paths.push(...inner.outside);
    if (inner?.unmodelled) unmodelled = true;
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
  return { action, paths, name, unmodelled, ...(cd !== undefined ? { cd } : {}) };
}

/** An adapter's answer for one prompt: the class and the line the owner reads. */
export type Classified = ReturnType<CoderAdapter['classify']>;

/** A shell command line run in the worktree, classed by everything it would run. */
export function classifyCommandLine(command: string, root: string | undefined): Classified {
  const title = `Run: ${oneLine(command, 200)}`;
  const detail = command.length > 200 ? command : undefined;
  const { action, outside, unmodelled } = classifyShell(command, root);
  // At least `outside_worktree` (classifyShell), or stricter for what it did read.
  if (unmodelled) {
    return {
      action,
      title,
      detail: "OpenBots could not read this command's shape, so it asks.",
    };
  }
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

/**
 * A tool reading or writing `path`: `destructive` for the computer's private
 * state, `outside_worktree` outside the worktree, and null inside it (the
 * caller words that one). `verb` is how the title names the access.
 */
export function classifyPathAccess(
  verb: string,
  path: string,
  root: string | undefined,
): Classified | null {
  const verdict = pathVerdict({ text: path, dynamic: false }, root, root);
  if (verdict.kind === 'state') {
    return { action: 'destructive', title: `${verb} the computer's private state: ${path}` };
  }
  if (verdict.kind === 'outside') {
    return { action: 'outside_worktree', title: `${verb} outside the worktree: ${path}` };
  }
  return null;
}
