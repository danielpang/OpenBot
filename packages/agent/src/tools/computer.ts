import { anthropic } from '@ai-sdk/anthropic';
import {
  ComputerActionSchema,
  computerPath,
  fromAnthropicAction,
  SCREEN_SIZE,
  type AnthropicComputerInput,
  type ComputerAction,
  type ComputerAgentClient,
  type PageInfo,
  type PageSnapshot,
} from '@openbots/computer';
import { OWNER_HAS_SCREEN } from '@openbots/shared';
import type { Tool } from 'ai';
import { z } from 'zod';
import {
  defineTool,
  type AnyAgentTool,
  type ModelTarget,
  type NativeTool,
  type ToolContext,
  type ToolGroup,
  type ToolResultOutput,
} from './types.js';

// The Computer group (plan 5.4, 9; K1, K2). Every account has one computer
// whose files under /home/bot all its Bots share; each Bot drives its own
// screen. The server supplies the backend (`ComputerServices`,
// apps/server/src/services/computer.ts), which starts the computer on first
// use, allocates the Bot's screen, holds the per-Bot screen lock (K2) and
// answers `OwnerHasScreen` while the owner has taken the screen over (K3).
// `bash` waits for the hand back too, since a command can drive the screen
// with xdotool as well as any screen tool can (S-7).
//
// Files and the terminal (`bash`, `*_file`, `list_dir`) work on the shared
// computer; DOM mode (`browser_*`, Playwright over CDP) and pixel mode
// (`computer`, xdotool) use the Bot's screen. Screenshots go to the model as
// image parts and to the transcript without their bytes. With an Anthropic
// model the `computer` tool is Anthropic's native computer-use tool.
//
// Default decisions (policy/rules.ts): `bash`, `write_file` and `edit_file`
// ask; reads and the Bot's own screen run.

/** The Bot's computer for one run. */
export interface ComputerServices {
  /** The account's computer, started (and created on first use) if it is not running. */
  agent(): Promise<ComputerAgentClient>;
  /**
   * Runs `fn` on the Bot's screen (the agent's screen number) under the
   * Bot's screen lock (K2). Throws
   * `OwnerHasScreen` while the owner has taken the screen over (K3).
   */
  screen<T>(fn: (screen: number, agent: ComputerAgentClient) => Promise<T>): Promise<T>;
  /**
   * Resolves once the owner does not hold the Bot's screen, waiting for the
   * hand back as `screen` does; throws `OwnerHasScreen` if they keep it.
   */
  screenFree(): Promise<void>;
  /**
   * The Bot's screen number, if it has a screen. `bash` passes it so the
   * command can reach that display and no other Bot's (S-7).
   */
  screenNumber?(): Promise<number | undefined>;
  signal?: AbortSignal;
}

/** The owner has the Bot's screen (takeover, plan 9.4); screen tools answer `OWNER_HAS_SCREEN`. */
export class OwnerHasScreen extends Error {
  constructor() {
    super(OWNER_HAS_SCREEN);
    this.name = 'OwnerHasScreen';
  }
}

/** Characters of command output, file content or page snapshot returned to the model. */
export const MAX_OUTPUT_CHARS = 30_000;
const MAX_LIST_ENTRIES = 500;
const DEFAULT_BASH_TIMEOUT_S = 120;

/** A screenshot result; the model gets it as an image part. */
export interface ScreenshotResult {
  type: 'screenshot';
  mediaType: 'image/png';
  /** Base64. */
  data: string;
  width: number;
  height: number;
}

function computer(ctx: ToolContext): ComputerServices {
  if (!ctx.computer) throw new Error('The computer is not available in this run');
  return ctx.computer;
}

/** A screen action, or the takeover answer while the owner has the screen. */
async function onScreen<T>(
  ctx: ToolContext,
  fn: (screen: number, agent: ComputerAgentClient, signal?: AbortSignal) => Promise<T>,
) {
  const services = computer(ctx);
  try {
    return await services.screen((screen, agent) => fn(screen, agent, services.signal));
  } catch (error) {
    if (error instanceof OwnerHasScreen)
      return { status: 'owner_has_screen', message: OWNER_HAS_SCREEN };
    throw error;
  }
}

async function onComputer<T>(
  ctx: ToolContext,
  fn: (agent: ComputerAgentClient, signal?: AbortSignal) => Promise<T>,
) {
  const services = computer(ctx);
  return fn(await services.agent(), services.signal);
}

/** A command, held like a screen action while the owner has the Bot's screen. */
async function offScreen<T>(
  ctx: ToolContext,
  fn: (agent: ComputerAgentClient, signal?: AbortSignal) => Promise<T>,
) {
  try {
    await computer(ctx).screenFree();
  } catch (error) {
    if (error instanceof OwnerHasScreen)
      return { status: 'owner_has_screen', message: OWNER_HAS_SCREEN };
    throw error;
  }
  return onComputer(ctx, fn);
}

function screenshot(png: Uint8Array): ScreenshotResult {
  return {
    type: 'screenshot',
    mediaType: 'image/png',
    data: Buffer.from(png).toString('base64'),
    ...pngSize(png),
  };
}

/** Width and height from the PNG header; the screen size when it cannot be read. */
function pngSize(png: Uint8Array) {
  if (png.byteLength < 24) return { ...SCREEN_SIZE };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function isScreenshot(output: unknown): output is ScreenshotResult {
  const o = output as Partial<ScreenshotResult> | null;
  return !!o && typeof o === 'object' && o.type === 'screenshot' && typeof o.data === 'string';
}

/** Screenshots reach the model as an image part (plan 18.5); other results are framed as data. */
export function screenshotModelOutput(output: unknown): ToolResultOutput | undefined {
  if (!isScreenshot(output)) return undefined;
  return {
    type: 'content',
    value: [
      { type: 'text', text: `Screenshot, ${output.width}x${output.height}` },
      { type: 'file', mediaType: output.mediaType, data: { type: 'data', data: output.data } },
    ],
  };
}

/** The transcript and the activity log keep the screenshot's size, not its bytes. */
export function screenshotTranscript(output: unknown): unknown {
  if (!isScreenshot(output)) return output;
  const { data, ...rest } = output;
  return { ...rest, bytes: Buffer.byteLength(data, 'base64') };
}

/** The last `max` characters, which is where a command's errors are. */
function tail(text: string, max = MAX_OUTPUT_CHARS) {
  return text.length > max ? `[${text.length - max} characters cut]\n${text.slice(-max)}` : text;
}

function lines(text: string) {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function isBinary(bytes: Uint8Array) {
  return bytes.subarray(0, 8_192).includes(0);
}

const Path = z.string().trim().min(1).max(1_000);
/** The file tools reach the persistent home (the agent's `/fs`); bash reaches the rest. */
const HOME_ONLY = { withinHome: true };
const screenshotTool = { toModelOutput: screenshotModelOutput, transcript: screenshotTranscript };

export const bash = defineTool({
  description:
    "Run a shell command (bash) on your computer, in /home/bot unless `cwd` says otherwise. The computer is a Linux sandbox shared by all of your owner's Bots; files under /home/bot persist. Returns the exit code, stdout and stderr (long output keeps its end).",
  inputSchema: z.object({
    command: z.string().min(1).max(20_000),
    cwd: Path.optional(),
    timeout_s: z.number().int().min(1).max(1_800).optional().describe('Default 120'),
  }),
  async execute({ command, cwd, timeout_s }, ctx) {
    return offScreen(ctx, async (agent, signal) => {
      const screen = await computer(ctx).screenNumber?.();
      const result = await agent.exec(
        {
          command,
          cwd: computerPath(cwd ?? '~'),
          timeoutMs: (timeout_s ?? DEFAULT_BASH_TIMEOUT_S) * 1000,
          ...(screen === undefined ? {} : { screen }),
        },
        signal ? { signal } : {},
      );
      return {
        exitCode: result.exitCode,
        stdout: tail(result.stdout),
        stderr: tail(result.stderr),
        ...(result.timedOut ? { timedOut: true } : {}),
      };
    });
  },
});

export const readFile = defineTool({
  description:
    'Read a text file under /home/bot on your computer (relative paths are under it; use bash for other places). `offset` and `limit` pick lines (1-based) of a long file.',
  inputSchema: z.object({
    path: Path,
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(10_000).optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async execute({ path, offset, limit }, ctx) {
    return onComputer(ctx, async (agent, signal) => {
      const absolute = computerPath(path, HOME_ONLY);
      const bytes = await agent.readFile(absolute, signal);
      if (isBinary(bytes)) throw new Error(`${absolute} is a binary file; inspect it with bash`);
      const all = new TextDecoder().decode(bytes);
      let content = all;
      if (offset !== undefined || limit !== undefined) {
        const start = (offset ?? 1) - 1;
        content = all
          .split('\n')
          .slice(start, limit === undefined ? undefined : start + limit)
          .join('\n');
      }
      const truncated = content.length > MAX_OUTPUT_CHARS;
      return {
        path: absolute,
        content: truncated ? content.slice(0, MAX_OUTPUT_CHARS) : content,
        lines: lines(all),
        ...(truncated ? { truncated: true } : {}),
      };
    });
  },
});

export const writeFile = defineTool({
  description:
    'Write a text file under /home/bot on your computer, replacing it if it exists; parent directories are created. Relative paths are under /home/bot.',
  inputSchema: z.object({ path: Path, content: z.string().max(1_000_000) }),
  async execute({ path, content }, ctx) {
    return onComputer(ctx, async (agent, signal) => {
      const absolute = computerPath(path, HOME_ONLY);
      const { size } = await agent.writeFile(absolute, content, signal);
      return { path: absolute, size, lines: lines(content) };
    });
  },
});

export const editFile = defineTool({
  description:
    'Edit a text file on your computer by replacing `old_string` with `new_string`. `old_string` must appear exactly once unless `replace_all` is true; include enough surrounding lines to make it unique.',
  inputSchema: z.object({
    path: Path,
    old_string: z.string().min(1).max(200_000),
    new_string: z.string().max(200_000),
    replace_all: z.boolean().optional(),
  }),
  async execute({ path, old_string, new_string, replace_all }, ctx) {
    return onComputer(ctx, async (agent, signal) => {
      const absolute = computerPath(path, HOME_ONLY);
      const before = new TextDecoder().decode(await agent.readFile(absolute, signal));
      const count = before.split(old_string).length - 1;
      if (count === 0) throw new Error(`old_string was not found in ${absolute}`);
      if (count > 1 && !replace_all) {
        throw new Error(
          `old_string appears ${count} times in ${absolute}; add context to make it unique or set replace_all`,
        );
      }
      const after = replace_all
        ? before.split(old_string).join(new_string)
        : before.replace(old_string, () => new_string);
      await agent.writeFile(absolute, after, signal);
      return {
        path: absolute,
        replacements: replace_all ? count : 1,
        added: lines(new_string) * (replace_all ? count : 1),
        removed: lines(old_string) * (replace_all ? count : 1),
      };
    });
  },
});

export const listDir = defineTool({
  description: 'List a directory under /home/bot on your computer (default /home/bot).',
  inputSchema: z.object({ path: Path.optional() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async execute({ path }, ctx) {
    return onComputer(ctx, async (agent, signal) => {
      const listing = await agent.list(computerPath(path ?? '~', HOME_ONLY), signal);
      const entries = listing.entries.slice(0, MAX_LIST_ENTRIES).map((e) => ({
        name: e.name,
        type: e.type,
        ...(e.type === 'file' ? { size: e.size } : {}),
      }));
      return {
        path: listing.path,
        entries,
        ...(listing.entries.length > MAX_LIST_ENTRIES ? { truncated: listing.entries.length } : {}),
      };
    });
  },
});

const Ref = z.string().min(1).max(50).describe('An element ref from browser_snapshot, like e12');

export const browserNavigate = defineTool({
  description:
    'Open a URL in your browser (your own Chromium on your screen; its logins persist between runs). Then use browser_snapshot to read the page.',
  inputSchema: z.object({ url: z.string().min(1).max(4_000) }),
  async execute({ url }, ctx) {
    return onScreen(ctx, (screen, agent, signal) =>
      agent.browser<PageInfo>(screen, { action: 'navigate', url }, signal),
    );
  },
});

export const browserSnapshot = defineTool({
  description:
    'Read the current page as an accessibility tree with element refs ([ref=e12]) for browser_click and browser_type. Cheaper and more reliable than screenshots.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true },
  async execute(_args, ctx) {
    return onScreen(ctx, async (screen, agent, signal) => {
      const page = await agent.browser<PageSnapshot>(screen, { action: 'snapshot' }, signal);
      const truncated = page.snapshot.length > MAX_OUTPUT_CHARS;
      return {
        ...page,
        snapshot: truncated ? page.snapshot.slice(0, MAX_OUTPUT_CHARS) : page.snapshot,
        ...(truncated ? { truncated: true } : {}),
      };
    });
  },
});

export const browserClick = defineTool({
  description: 'Click an element on the current page by its ref from browser_snapshot.',
  inputSchema: z.object({
    ref: Ref,
    element: z.string().max(200).optional().describe('What the element is, in words'),
  }),
  async execute({ ref }, ctx) {
    return onScreen(ctx, (screen, agent, signal) =>
      agent.browser(screen, { action: 'click', ref }, signal),
    );
  },
});

export const browserType = defineTool({
  description: 'Type text into an element on the current page; `submit` presses Enter after.',
  inputSchema: z.object({
    ref: Ref,
    text: z.string().max(10_000),
    submit: z.boolean().optional(),
  }),
  async execute({ ref, text, submit }, ctx) {
    return onScreen(ctx, (screen, agent, signal) =>
      agent.browser(
        screen,
        { action: 'type', ref, text, ...(submit !== undefined ? { submit } : {}) },
        signal,
      ),
    );
  },
});

export const browserPress = defineTool({
  description: 'Press a key in the browser, like Enter, Escape, ArrowDown or Control+A.',
  inputSchema: z.object({ key: z.string().min(1).max(50) }),
  async execute({ key }, ctx) {
    return onScreen(ctx, (screen, agent, signal) =>
      agent.browser(screen, { action: 'press', key }, signal),
    );
  },
});

export const browserScreenshot = defineTool({
  description: 'Take a screenshot of your screen, where the browser is.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true },
  ...screenshotTool,
  async execute(_args, ctx) {
    return onScreen(ctx, async (screen, agent, signal) =>
      screenshot(await agent.screenshot(screen, signal)),
    );
  },
});

const Point = z.tuple([z.number().int().min(0), z.number().int().min(0)]);

// One flat object: providers want an object at the top of a tool schema.
const ComputerInput = z.object({
  action: z.enum([
    'screenshot',
    'click',
    'double_click',
    'type',
    'key',
    'scroll',
    'move',
    'drag',
    'wait',
  ]),
  coordinate: Point.optional().describe('[x, y] in screenshot pixels'),
  button: z.enum(['left', 'right', 'middle']).optional(),
  count: z.number().int().min(1).max(3).optional(),
  text: z.string().max(10_000).optional().describe('Text to type, or keys like ctrl+l'),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().int().min(1).max(50).optional(),
  from: Point.optional(),
  to: Point.optional(),
  seconds: z.number().min(0).max(30).optional(),
});

export const computerTool = defineTool({
  description: `Operate your screen with the mouse and keyboard (${SCREEN_SIZE.width}x${SCREEN_SIZE.height}) for apps the browser tools cannot drive, like canvas apps. Take a screenshot first and after acting; coordinates are screenshot pixels. Prefer browser_* for web pages.`,
  inputSchema: ComputerInput,
  ...screenshotTool,
  native: anthropicComputer,
  async execute(input, ctx) {
    const action = ComputerActionSchema.parse(dropUndefined(input));
    return runComputerAction(action, ctx);
  },
});

async function runComputerAction(action: ComputerAction, ctx: ToolContext) {
  if (action.action === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, action.seconds * 1000));
    return { ok: true };
  }
  return onScreen(ctx, async (screen, agent, signal) => {
    if (action.action === 'screenshot') return screenshot(await agent.screenshot(screen, signal));
    await agent.input(screen, action, signal);
    return { ok: true };
  });
}

function dropUndefined(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

/**
 * Anthropic's native computer-use tool for the `computer` tool (plan 9.3):
 * the computer toolset on Claude 5-era models, `computer_20251124` and
 * `computer_20250124` on older ones, nothing for other providers or models.
 * Native calls map onto the plan's actions before the policy sees them.
 */
type NativeOptions = Parameters<NativeTool['create']>[0];

export function anthropicComputer(target: ModelTarget): NativeTool | undefined {
  if (target.providerKind !== 'anthropic' || target.protocol !== 'native') return undefined;
  const id = target.modelId;
  const display = { displayWidthPx: SCREEN_SIZE.width, displayHeightPx: SCREEN_SIZE.height };
  // The SDK types `execute`'s input as the native schema; the loop converts it with `toArgs`.
  const sdk = (options: NativeOptions) =>
    options as unknown as Pick<Tool<AnthropicComputerInput, unknown>, 'execute' | 'toModelOutput'>;
  let create: NativeTool['create'];
  if (/(opus|sonnet|fable)-5|opus-4-8/.test(id)) {
    const off = { enabled: false };
    create = (options) =>
      anthropic.tools.computerToolset_20260801({
        configs: { zoom: off, cursor_position: off, left_mouse_down: off, left_mouse_up: off },
        ...sdk(options),
      } as never) as Tool;
  } else if (/opus-4-[56]|sonnet-4-6/.test(id)) {
    create = (options) =>
      anthropic.tools.computer_20251124({ ...display, ...sdk(options) } as never) as Tool;
  } else if (/claude-(3-7|sonnet-4|opus-4|haiku-4-5)/.test(id)) {
    create = (options) =>
      anthropic.tools.computer_20250124({ ...display, ...sdk(options) } as never) as Tool;
  } else {
    return undefined;
  }
  return { create, toArgs: (input) => fromAnthropicAction(input as AnthropicComputerInput) };
}

/**
 * The computer tools whose results are screenshots. A model without vision
 * cannot read them, so its runs go without these (L4); the text-based
 * browser and file tools still work.
 */
export const IMAGE_TOOLS = ['computer', 'browser_screenshot'] as const;

export const computerTools: ToolGroup = {
  name: 'computer',
  tools: (ctx): Record<string, AnyAgentTool> => {
    if (!ctx.computer) return {};
    return {
      bash,
      read_file: readFile,
      write_file: writeFile,
      edit_file: editFile,
      list_dir: listDir,
      browser_navigate: browserNavigate,
      browser_snapshot: browserSnapshot,
      browser_click: browserClick,
      browser_type: browserType,
      browser_press: browserPress,
      browser_screenshot: browserScreenshot,
      computer: computerTool,
    };
  },
};
