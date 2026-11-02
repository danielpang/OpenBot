import { z } from 'zod';

// The computer (plan 4.5, 9; K1 to K7, I5). `computers.status` and
// `bot_screens.status` are text columns; their value sets live here.

/**
 * `creating` and `starting` while the sandbox comes up, `updating` while a
 * start makes it again from a new image or new settings (plan 16.3), keeping
 * its files; `stopped` after the idle timeout (plan 9.5).
 */
export const ComputerStatusSchema = z.enum([
  'creating',
  'updating',
  'starting',
  'running',
  'stopping',
  'stopped',
  'error',
]);
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>;

/** A Bot's screen: its display, window manager and Chromium are up (`running`) or not. */
export const ScreenStatusSchema = z.enum(['stopped', 'running']);
export type ScreenStatus = z.infer<typeof ScreenStatusSchema>;

export const ComputerProviderNameSchema = z.enum(['docker', 'remote']);
export type ComputerProviderName = z.infer<typeof ComputerProviderNameSchema>;

/** The Computer tool group (plan 5.4). */
export const COMPUTER_TOOL_NAMES = [
  'bash',
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_screenshot',
  'computer',
] as const;

/** Tools that use the Bot's screen and so take its screen lock (K2) and respect a takeover (K3). */
export const SCREEN_TOOL_NAMES: readonly string[] = COMPUTER_TOOL_NAMES.filter(
  (name) => name === 'computer' || name.startsWith('browser_'),
);

/**
 * The file browser, the terminal and a screen's Preview never start the
 * computer: while it is off they answer this problem code (HTTP 409), and
 * their sockets close with `COMPUTER_OFF_CLOSE_CODE`.
 */
export const COMPUTER_OFF = 'COMPUTER_OFF';
export const COMPUTER_OFF_CLOSE_CODE = 4409;

/** What a screen tool answers while the owner has taken over the screen (plan 9.4). */
export const OWNER_HAS_SCREEN = 'The owner has the screen; wait';

/**
 * The title-bar computer icon (I5, plan 9.4): lit while the Bot's current
 * action is a computer tool. Reads `bot_state.current_tool`, which the run
 * sets beside `current_action` while a tool executes.
 */
export function isComputerTool(toolName: string | null | undefined): boolean {
  return (
    !!toolName &&
    ((COMPUTER_TOOL_NAMES as readonly string[]).includes(toolName) ||
      toolName === 'publish_artifact' ||
      toolName === 'artifact_to_computer' ||
      toolName === 'attachment_to_computer')
  );
}
