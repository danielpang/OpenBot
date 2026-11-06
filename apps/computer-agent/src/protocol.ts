import { z } from 'zod';

// The control agent's wire format (plan 9.3). Only zod lives here so the
// server's agent client can import these without the agent's native deps.

export const MAX_SCREEN = 89;

export const ScreenNumberSchema = z.coerce.number().int().min(0).max(MAX_SCREEN);

// --- POST /exec ----------------------------------------------------------------

export const ExecRequestSchema = z.strictObject({
  /** Run by `bash -c` as the `bot` user. */
  command: z.string().min(1),
  /**
   * The screen of the Bot running it. The command gets that screen's
   * DISPLAY and XAUTHORITY, and the group that may read its cookie; without
   * a screen it can reach no display (S-7).
   */
  screen: z.number().int().min(0).max(MAX_SCREEN).optional(),
  /** Absolute, or relative to the home directory (the default). */
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional(),
  stdin: z.string().optional(),
});
export type ExecRequest = z.infer<typeof ExecRequestSchema>;

/** One NDJSON line of the `POST /exec` response. `exit` is always last. */
export type ExecEvent =
  | { type: 'start'; pid: number }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | {
      type: 'exit';
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      durationMs: number;
    }
  | { type: 'error'; message: string };

// --- /fs/* ---------------------------------------------------------------------

export type FsEntryType = 'file' | 'dir' | 'symlink' | 'other';

export interface FsEntry {
  name: string;
  /** Relative to the home directory, `/`-separated, no leading slash. */
  path: string;
  type: FsEntryType;
  size: number;
  modifiedAt: string;
}

export interface FsListing {
  path: string;
  entries: FsEntry[];
}

// --- /screens ------------------------------------------------------------------

export const StartScreenSchema = z.strictObject({
  n: z.number().int().min(0).max(MAX_SCREEN),
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(240).max(2160).optional(),
  /** Start from an empty Chromium profile: the screen number is new to its Bot. */
  fresh: z.boolean().optional(),
});
export type StartScreen = z.infer<typeof StartScreenSchema>;

export interface ScreenInfo {
  n: number;
  /** X display, `:10+n`. */
  display: string;
  width: number;
  height: number;
  /** x11vnc on 127.0.0.1, behind the screen's password (S-7). */
  vncPort: number;
  /**
   * The screen's old DevTools port, kept for `bot_screens.cdp_port`.
   * Chromium no longer listens on it: CDP goes over a pipe to the agent.
   */
  cdpPort: number;
}

// --- POST /screens/:n/input (xdotool) -----------------------------------------

const Coordinate = z.number().int().min(0);
const Point = z.strictObject({ x: Coordinate, y: Coordinate });
const MouseButton = z.enum(['left', 'right', 'middle']);

export const InputActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('click'),
    x: Coordinate.optional(),
    y: Coordinate.optional(),
    button: MouseButton.default('left'),
    count: z.number().int().min(1).max(3).default(1),
  }),
  z.strictObject({
    action: z.literal('double_click'),
    x: Coordinate.optional(),
    y: Coordinate.optional(),
  }),
  z.strictObject({ action: z.literal('type'), text: z.string().min(1) }),
  /** xdotool key names joined by `+` (`ctrl+s`); spaces separate presses. */
  z.strictObject({ action: z.literal('key'), keys: z.string().min(1) }),
  z.strictObject({
    action: z.literal('scroll'),
    x: Coordinate.optional(),
    y: Coordinate.optional(),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(50).default(3),
  }),
  z.strictObject({ action: z.literal('move'), x: Coordinate, y: Coordinate }),
  z.strictObject({
    action: z.literal('drag'),
    from: Point,
    to: Point,
    button: MouseButton.default('left'),
  }),
  z.strictObject({ action: z.literal('cursor_position') }),
]);
export type InputAction = z.input<typeof InputActionSchema>;

export type InputResult = { ok: true } | { ok: true; x: number; y: number };

// --- POST /screens/:n/browser/:action (Playwright over CDP) --------------------

export const BROWSER_ACTIONS = ['navigate', 'snapshot', 'click', 'type', 'press', 'wait'] as const;
export type BrowserActionName = (typeof BROWSER_ACTIONS)[number];

const Ref = z.string().regex(/^[a-z0-9]+$/i, 'a ref from the latest snapshot, like e12');
const Timeout = z.number().int().positive().max(120_000).optional();

export const BrowserActionSchemas = {
  navigate: z.strictObject({ url: z.string().min(1), timeoutMs: Timeout }),
  snapshot: z.strictObject({}),
  click: z.strictObject({
    ref: Ref,
    button: MouseButton.optional(),
    doubleClick: z.boolean().optional(),
    timeoutMs: Timeout,
  }),
  type: z.strictObject({
    ref: Ref,
    text: z.string(),
    /** Press Enter afterwards. */
    submit: z.boolean().optional(),
    timeoutMs: Timeout,
  }),
  /** Playwright key names (`Enter`, `Control+A`); focused element unless `ref`. */
  press: z.strictObject({ key: z.string().min(1), ref: Ref.optional(), timeoutMs: Timeout }),
  /** Wait for a time, for text to appear, or for text to disappear. */
  wait: z
    .strictObject({
      ms: z.number().int().min(0).max(60_000).optional(),
      text: z.string().min(1).optional(),
      textGone: z.string().min(1).optional(),
      timeoutMs: Timeout,
    })
    .refine((w) => w.ms !== undefined || w.text !== undefined || w.textGone !== undefined, {
      message: 'Give ms, text or textGone',
    }),
} satisfies Record<BrowserActionName, z.ZodType>;

export type BrowserActionInput<A extends BrowserActionName> = z.input<
  (typeof BrowserActionSchemas)[A]
>;

export interface BrowserResult {
  url: string;
  title: string;
  /** Present for `snapshot`: Playwright's AI-mode aria snapshot with `[ref=eN]` markers. */
  snapshot?: string;
}

// --- POST /cookies/sync ------------------------------------------------------------

/**
 * Exports a screen's cookies into the computer's shared store now and
 * spreads what changed to the other screens (K1): after a hand back, or once
 * the owner says they signed in. Every running screen without `screen`.
 */
export const CookieSyncRequestSchema = z.strictObject({
  screen: z.number().int().min(0).max(MAX_SCREEN).optional(),
});
export type CookieSyncRequest = z.infer<typeof CookieSyncRequestSchema>;

export interface CookieSyncResult {
  /** The screens whose cookies were exported. */
  screens: number[];
  /** How many cookies the shared store holds afterwards. */
  cookies: number;
}

// --- POST /wallpaper -------------------------------------------------------------

export const WallpaperRequestSchema = z.strictObject({
  /** Hour of the day to show; the agent's local hour when omitted. */
  hour: z.number().int().min(0).max(23).optional(),
});

export interface WallpaperResult {
  hour: number;
  screens: number[];
}

// --- WS /pty -----------------------------------------------------------------------

export type PtyClientMessage =
  { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };

export type PtyServerMessage =
  { type: 'output'; data: string } | { type: 'exit'; exitCode: number; signal?: number };

export const PtyClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('input'), data: z.string() }),
  z.strictObject({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
]);

// --- WS /mcp/stdio -------------------------------------------------------------
//
// A stdio MCP server run inside the computer for a connector of the owner (the
// managed service's OPENBOTS_STDIO_RUNNER=computer). The server opens one socket
// per process: its first frame is `start`, then `stdin` frames carry what the
// MCP client writes. The agent answers `started` once the process runs, then
// relays its output; `exit` (or `error`) is the last frame. Closing the socket
// stops the process. Every frame is one JSON text message.

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const McpStdioStartSchema = z.strictObject({
  type: z.literal('start'),
  command: z.string().min(1),
  args: z.array(z.string()).max(256),
  /**
   * Added to the bot user's environment, for this process only: the
   * connector's secrets among them, so never logged and never on disk.
   */
  env: z.record(EnvName, z.string()),
  /** Absolute, or relative to the home directory (the default). */
  cwd: z.string().optional(),
  /** Folders under the home created first when missing: the filesystem server's roots. */
  dirs: z.array(z.string().min(1)).max(32).optional(),
});
export type McpStdioStart = z.infer<typeof McpStdioStartSchema>;

export const McpStdioClientMessageSchema = z.discriminatedUnion('type', [
  McpStdioStartSchema,
  z.strictObject({ type: z.literal('stdin'), data: z.string() }),
]);
export type McpStdioClientMessage = z.infer<typeof McpStdioClientMessageSchema>;

export type McpStdioServerMessage =
  | { type: 'started'; pid: number }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; exitCode: number | null; signal: string | null }
  | { type: 'error'; message: string };

// --- WS /coder -----------------------------------------------------------------
//
// A coding agent session (I3): Claude Code, Codex or pi run as the `coder`
// user (or `bot`, for the owner's own commands) in the session's worktree.
// Shaped like WS /mcp/stdio: the first frame is `start`, then `stdin` frames
// feed the process; the agent answers `started`, relays its output, and ends
// with `exit` (or `error`). Two round trips run beside the output: the git
// credential helper's requests (`credential_request`, answered by
// `credential`) and the permission MCP server's prompts
// (`permission_request`, answered by `answer`). Closing the socket stops the
// process group, SIGTERM then SIGKILL, as mcp-stdio.ts does.

/**
 * Placeholders the agent replaces in `env` values and in the `args` before
 * the first literal `--` (never after it, where the server puts the prompt)
 * at start: the session's own directory under the coder state dir, the
 * session id, and the home directory.
 */
export const CODER_ARG_PLACEHOLDERS = ['{{session_dir}}', '{{session_id}}', '{{home}}'] as const;
export type CoderArgPlaceholder = (typeof CODER_ARG_PLACEHOLDERS)[number];

export const CoderStartSchema = z.strictObject({
  type: z.literal('start'),
  /** `coding_sessions.id`: the session directory's name and the server's handle. */
  session_id: z.string().min(8).max(128),
  /**
   * Who runs it: `coder` for the agents and their logins, `bot` for the
   * owner's own commands, `runner` for the server's own git operations.
   */
  user: z.enum(['coder', 'bot', 'runner']).default('coder'),
  command: z.string().min(1),
  args: z.array(z.string()).max(256).default([]),
  /** Relative to the home directory, or absolute under it: the worktree. */
  cwd: z.string().optional(),
  /**
   * Added to the user's environment for this process only (the agent's
   * config dir, the git identity); never logged. The agent sets
   * `OPENBOTS_CODER_SESSION` itself, to a secret of its own.
   */
  env: z.record(EnvName, z.string()).default({}),
  /** Runs under a pseudo-terminal (an interactive login), not pipes. */
  pty: z.boolean().default(false),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
  /** Sets the credential helper up for the process; off for a login. */
  git_credentials: z.boolean().default(true),
});
export type CoderStart = z.infer<typeof CoderStartSchema>;
/** `start` as the server writes it, before defaults. */
export type CoderStartInput = z.input<typeof CoderStartSchema>;

export const CoderClientMessageSchema = z.discriminatedUnion('type', [
  CoderStartSchema,
  z.strictObject({
    type: z.literal('stdin'),
    data: z.string(),
    /**
     * Closes stdin after `data`. `claude -p` and `codex exec` read a piped
     * stdin to its end before they start, so a one-shot run sends this.
     */
    end: z.boolean().optional(),
  }),
  /** The answer to a `credential_request`: a username and token, or why not. */
  z.strictObject({
    type: z.literal('credential'),
    request_id: z.string().min(1).max(128),
    username: z.string().optional(),
    password: z.string().optional(),
    denied: z.string().max(500).optional(),
  }),
  /** The answer to a `permission_request` from the permission MCP server. */
  z.strictObject({
    type: z.literal('answer'),
    request_id: z.string().min(1).max(128),
    decision: z.enum(['allow', 'deny']),
    message: z.string().max(2_000).optional(),
  }),
  z.strictObject({ type: z.literal('signal'), signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL']) }),
  z.strictObject({
    type: z.literal('resize'),
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  }),
]);
export type CoderClientMessage = z.infer<typeof CoderClientMessageSchema>;
/** A client frame as the server writes it, before defaults. */
export type CoderClientMessageInput = z.input<typeof CoderClientMessageSchema>;

export type CoderServerMessage =
  | { type: 'started'; pid: number; session_dir: string }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | {
      type: 'credential_request';
      request_id: string;
      protocol: string;
      host: string;
      path?: string;
      username?: string;
    }
  | { type: 'permission_request'; request_id: string; tool_name: string; input: unknown }
  | { type: 'exit'; code: number | null; signal: string | null }
  | { type: 'error'; message: string };

/**
 * What openbots-git-credential (I5) writes, as one JSON line, to the
 * session's credential socket (`$OPENBOTS_CODER_CREDENTIAL_SOCKET`): git's
 * credential `get`, with the secret the agent minted for that process
 * (`$OPENBOTS_CODER_SESSION`). The agent checks the secret, never the
 * server's session id, and asks the server with a `credential_request`.
 */
export const GitCredentialRequestSchema = z.strictObject({
  secret: z.string().min(16).max(256),
  protocol: z.string().min(1).max(32),
  host: z.string().min(1).max(253),
  path: z.string().max(2_000).optional(),
  username: z.string().max(200).optional(),
});
export type GitCredentialRequest = z.infer<typeof GitCredentialRequestSchema>;

export interface GitCredentialResponse {
  username: string;
  password: string;
}

// --- WS /pty query parameters (I15) ------------------------------------------
//
// Beside `cols` and `rows`, /pty takes `cwd` (relative to the home or
// absolute under it), `user` (`bot`, the default, or `coder`, for a coding
// session's terminal) and `preset` (text typed into the terminal without a
// newline: the session's resume command, for the owner to run). The server
// validates `cwd` against a session the owner has before it proxies them.

export const PtyOpenSchema = z.object({
  cols: z.coerce.number().int().min(1).max(1000).optional(),
  rows: z.coerce.number().int().min(1).max(1000).optional(),
  cwd: z.string().min(1).max(4_096).optional(),
  user: z.enum(['bot', 'coder']).default('bot'),
  preset: z.string().max(4_096).optional(),
});
export type PtyOpen = z.infer<typeof PtyOpenSchema>;
