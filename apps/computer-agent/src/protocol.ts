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
