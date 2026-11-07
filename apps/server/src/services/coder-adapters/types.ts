import type {
  CoderActionClass,
  CoderAgent,
  CoderEvent,
  CoderMode,
  PolicyDecision,
} from '@openbots/shared';

// One adapter per coding agent (docs/TECHNICAL_PLAN.md 22.2 and 22.13; I10).
// An adapter knows how to launch its CLI headless in a worktree, how to read
// the CLI's structured output into the shared `CoderEvent` form, how to resume
// a session, how the vendor's own sign-in runs and how to ask the CLI whether
// it is signed in. Everything else (the socket, the widget, approvals,
// credentials) is the runner's and is the same for every agent.

/**
 * A vendor session id OpenBots accepts: a UUID. The id comes from the CLI's
 * own output, which a process running as `coder` could forge, and it goes
 * into argv (`--resume <id>`) and the terminal's preset, so nothing else is
 * kept.
 */
export const VENDOR_SESSION_ID = /^[0-9a-f-]{36}$/i;

export const isVendorSessionId = (value: unknown): value is string =>
  typeof value === 'string' && VENDOR_SESSION_ID.test(value);

/** The feed line for a vendor session id that is not one. */
export const IGNORED_SESSION_ID = 'Ignored a session id from the agent that is not a UUID';

/** What the runner knows about a session when it asks the adapter for a launch plan. */
export interface CoderSessionSpec {
  sessionId: string;
  agent: CoderAgent;
  mode: CoderMode;
  prompt: string;
  /** The worktree the process runs in; also its cwd. */
  worktreePath: string;
  /**
   * The checkout the worktree belongs to. The worktree's git dir lives in
   * `<repoPath>/.git`, outside the worktree, so an agent that sandboxes its
   * writes must be let write there to commit.
   */
  repoPath?: string;
  repoFullName: string;
  branch: string;
  base: string;
  /** The vendor's own session id, when continuing an earlier session. */
  resumeId?: string;
  /** A model override from the Bot's settings, in the vendor's naming. */
  model?: string;
  /**
   * The provider kind (`anthropic`, `openai`, `google`, `xai`, ...) of an
   * `api_key` account's provider, absent for a plan sign-in.
   */
  apiKeyProvider?: string;
  /**
   * The base URL of an `api_key` account's provider, when it sets one. An
   * adapter that cannot read it from the environment (Codex's app-server)
   * names it in the CLI's own config.
   */
  apiKeyBaseUrl?: string;
  maxTurns: number;
  /**
   * The policy's answer per action class. No adapter pre-allows anything
   * from it today: every prompt meets `classify` and `coderActionDecision`.
   */
  actions: Record<CoderActionClass, PolicyDecision>;
  /** Who the session's commits are by: the git author and committer in its environment. */
  gitIdentity?: { name: string; email: string };
  /** The owner, credited on every commit with a `Co-Authored-By` trailer (GH8). */
  coAuthor?: { name: string; email: string };
}

/**
 * How to start the process. `args` and `env` values may use the agent's
 * placeholders (`{{session_dir}}`, `{{session_id}}`, `{{home}}`), which the
 * computer agent substitutes at start.
 */
export interface CoderLaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Written to stdin after start, then stdin is closed. */
  stdin?: string;
  pty?: boolean;
}

/** How to start the vendor's sign-in in a PTY; the owner finishes it from the widget. */
export interface CoderLoginPlan {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs: number;
}

/** What the login driver has read from the sign-in's output so far. */
export interface CoderLoginParse {
  url?: string;
  deviceCode?: string;
  /** The CLI is waiting for a code to be pasted. */
  awaitingCode?: boolean;
  /**
   * Something the owner should read while the sign-in goes on, such as a
   * pasted code the CLI refused and is waiting for again. Not an end.
   */
  notice?: string;
  signedIn?: boolean;
  accountLabel?: string;
  error?: string;
}

/** What the runner tells an adapter's parser about the session. */
export interface CoderParserOptions {
  billing?: 'subscription' | 'api' | 'unknown';
  worktreePath?: string;
}

/** A streaming parser over the CLI's stdout: one instance per process, fed line by line. */
export interface CoderOutputParser {
  line(text: string): CoderEvent[];
  /** The process ended; flush anything buffered. */
  end(): CoderEvent[];
}

/** A permission prompt a `jsonrpc` session raised, already classified by the adapter. */
export interface CoderSessionApproval {
  /** The session's own id for the prompt, which `answer` takes back. */
  request_id: string;
  /** The vendor's name for what asks, kept on the `approvals` row. */
  tool_name: string;
  /** What it would do, kept on the `approvals` row (small: no file contents). */
  input: unknown;
  action: CoderActionClass;
  title: string;
  detail?: string;
}

/** What the runner gives a `jsonrpc` session: the process's stdin, the feed and the owner. */
export interface CoderSessionIo {
  /** One protocol message to the process's stdin; the newline is the runner's. */
  write(line: string): void;
  /** An event for the feed, as a parser returns them. A `result` ends the session: the runner closes stdin. */
  emit(event: CoderEvent): void;
  /**
   * A prompt for the policy and, when it asks, the owner. The runner answers
   * it through the session's `answer`, at once for an `auto` or `deny` class.
   */
  approval(request: CoderSessionApproval): void;
}

/**
 * A live protocol session over the process's stdin and stdout (`transport:
 * 'jsonrpc'`): created once the process runs, fed every stdout line, told
 * each decision, and ended when the process exits.
 */
export interface CoderSession {
  onLine(line: string): void;
  answer(requestId: string, decision: 'allow' | 'deny', message?: string): void;
  /** The process ended: emit the result if none was, and nothing more after. */
  end(): void;
}

/**
 * How an agent signs in. `pty`: the login driver runs `login()` in a PTY as
 * `coder` and reads its output with `parseLogin`, showing the owner only
 * links on `hosts`. `terminal`: the CLI has no headless sign-in, so the owner
 * signs in in a terminal on the computer (`preset` typed, in the home) and
 * then presses Check. `instructions` is what the sign-in widget and the 409
 * tell the owner.
 */
export type CoderSignIn =
  | {
      kind: 'pty';
      instructions: string;
      /**
       * Hosts a sign-in link may point at, so a tampered CLI or environment
       * cannot put a phishing link in the sign-in widget.
       */
      hosts: readonly string[];
      login(): CoderLoginPlan;
      /** Folds one chunk of login output into the parse so far. */
      parseLogin(chunk: string, state: CoderLoginParse): CoderLoginParse;
    }
  | { kind: 'terminal'; instructions: string; preset: string };

/** What `checkSignIn` may run: one command as `coder` with the agent's config directory. */
export interface CoderCheckContext {
  run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string } | null>;
}

/** How a check found the agent: signed in with a plan or a key the CLI holds, or not. */
export type CoderSignInCheck =
  { signedIn: true; authKind: 'subscription' | 'api_key'; label: string } | { signedIn: false };

export interface CoderAdapter {
  agent: CoderAgent;
  /** The CLI's command: what a session, a check and `--version` run. */
  command: string;
  /** What prints the installed version after `command`, for Settings (CA1): `['--version']`. */
  versionArgs: string[];
  signIn: CoderSignIn;
  launch(spec: CoderSessionSpec): CoderLaunchPlan;
  /**
   * A parser for one process. `billing` is how the session's account is
   * billed (its `auth_kind`), which the stream itself does not say;
   * `worktreePath` is the session's worktree. An adapter may ignore both.
   */
  parser(options?: CoderParserOptions): CoderOutputParser;
  /**
   * How the runner talks to the process. `lines` (the default): the plan's
   * stdin, then EOF, and every stdout line to `parser`; prompts come over
   * the agent socket. `jsonrpc`: stdin stays open for `session`, which
   * speaks the CLI's own protocol, raises its prompts through `approval`
   * and emits the events itself; `parser` is not used.
   */
  transport?: 'lines' | 'jsonrpc';
  /** The protocol session for a `jsonrpc` transport; called once the process runs. */
  session?(spec: CoderSessionSpec, io: CoderSessionIo, options?: CoderParserOptions): CoderSession;
  /** The command the owner continues the session with in the terminal (CA7). */
  resumeCommand(vendorSessionId: string): string;
  /**
   * Classifies a permission prompt the CLI raised (tool name and input, in
   * the vendor's terms) into an OpenBots action class with a one-line title.
   */
  classify(
    toolName: string,
    input: unknown,
    context?: { worktreePath: string },
  ): { action: CoderActionClass; title: string; detail?: string };
  /**
   * Whether the CLI's own words (an error result, stderr) say it is not
   * signed in, so the runner marks the account `needs_login` rather than
   * failing the session plainly.
   */
  needsLogin?(text: string): boolean;
  /**
   * Whether the CLI's own words say the vendor's rate limit ended it, so the
   * runner waits for the reset and tries once more (`rateLimitResetMs`).
   */
  rateLimited?(text: string): boolean;
  /**
   * Asks the CLI whether it is signed in (`POST /coders/{agent}/check`).
   * Null when it could not say. The status text is never kept: it can hold
   * a masked key.
   */
  checkSignIn?(ctx: CoderCheckContext): Promise<CoderSignInCheck | null>;
  /** The feed line every session of this agent starts with, when its posture differs. */
  posture?: string;
  /**
   * What the owner reads when the vendor refuses a plan sign-in with a 401,
   * instead of the vendor's text (which stays in the log).
   */
  signInRefused?: string;
}
