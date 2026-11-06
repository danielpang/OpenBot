import type {
  CoderActionClass,
  CoderAgent,
  CoderEvent,
  CoderMode,
  PolicyDecision,
} from '@openbots/shared';

// One adapter per coding agent (design doc, "The three agents"; I10). An
// adapter knows how to launch its CLI headless in a worktree, how to read the
// CLI's structured output into the shared `CoderEvent` form, how to resume a
// session, and how to drive the vendor's own sign-in. Everything else (the
// socket, the widget, approvals, credentials) is the runner's and is the same
// for every agent.

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
  maxTurns: number;
  /** The policy's answer per action class; `auto` classes are pre-allowed where the CLI supports it. */
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

/** How to start the vendor's sign-in: always a PTY, the owner finishes it from the widget. */
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

export interface CoderAdapter {
  agent: CoderAgent;
  /** The command and args that print the installed version, for the Computer page (CA1). */
  versionArgs: string[];
  /**
   * Hosts a sign-in link may point at. The login driver shows the owner only
   * links on these hosts, so a tampered CLI or environment cannot put a
   * phishing link in the sign-in widget.
   */
  loginHosts: string[];
  launch(spec: CoderSessionSpec): CoderLaunchPlan;
  /**
   * A parser for one process. `billing` is how the session's account is
   * billed (its `auth_kind`), which the stream itself does not say;
   * `worktreePath` is the session's worktree. An adapter may ignore both.
   */
  parser(options?: CoderParserOptions): CoderOutputParser;
  /** The command the owner continues the session with in the terminal (CA7). */
  resumeCommand(vendorSessionId: string): string;
  login(): CoderLoginPlan;
  /** Folds one chunk of login output into the parse so far. */
  parseLogin(chunk: string, state: CoderLoginParse): CoderLoginParse;
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
}
