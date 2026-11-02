import { badRequest } from './errors.js';
import type { Run, RunOptions } from './proc.js';
import { InputActionSchema, type InputAction, type InputResult } from './protocol.js';

// Pixel-mode input through xdotool (plan 9.3). The action set covers
// Anthropic's computer-use actions, which the computer tools map onto.

const BUTTONS = { left: '1', middle: '2', right: '3' } as const;
const SCROLL_BUTTONS = { up: '4', down: '5', left: '6', right: '7' } as const;
const TYPE_DELAY_MS = '12';

function moveTo(x: number | undefined, y: number | undefined): string[] {
  if (x === undefined && y === undefined) return [];
  if (x === undefined || y === undefined) throw badRequest('Give both x and y, or neither');
  return ['mousemove', '--sync', String(x), String(y)];
}

/** The xdotool arguments for one action (commands chained in one call). */
export function xdotoolArgs(input: InputAction): string[] {
  const a = InputActionSchema.parse(input);
  switch (a.action) {
    case 'click':
      return [
        ...moveTo(a.x, a.y),
        'click',
        '--repeat',
        String(a.count),
        '--delay',
        '80',
        BUTTONS[a.button],
      ];
    case 'double_click':
      return [...moveTo(a.x, a.y), 'click', '--repeat', '2', '--delay', '80', BUTTONS.left];
    case 'type':
      return ['type', '--delay', TYPE_DELAY_MS, '--', a.text];
    case 'key':
      return ['key', '--delay', TYPE_DELAY_MS, '--', ...a.keys.trim().split(/\s+/)];
    case 'scroll':
      return [
        ...moveTo(a.x, a.y),
        'click',
        '--repeat',
        String(a.amount),
        '--delay',
        '20',
        SCROLL_BUTTONS[a.direction],
      ];
    case 'move':
      return moveTo(a.x, a.y);
    case 'drag':
      return [
        ...moveTo(a.from.x, a.from.y),
        'mousedown',
        BUTTONS[a.button],
        ...moveTo(a.to.x, a.to.y),
        'mouseup',
        BUTTONS[a.button],
      ];
    case 'cursor_position':
      return ['getmouselocation', '--shell'];
  }
}

/** `screen` is how xdotool reaches the screen: its display, cookie and user. */
export async function sendInput(
  run: Run,
  screen: RunOptions,
  input: InputAction,
): Promise<InputResult> {
  const args = xdotoolArgs(input);
  const { stdout } = await run('xdotool', args, screen);
  if (input.action !== 'cursor_position') return { ok: true };
  const out = stdout.toString('utf8');
  const x = /^X=(\d+)$/m.exec(out)?.[1];
  const y = /^Y=(\d+)$/m.exec(out)?.[1];
  return { ok: true, x: Number(x ?? 0), y: Number(y ?? 0) };
}
