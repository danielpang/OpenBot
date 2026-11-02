import { z } from 'zod';

// Pixel-mode input on a Bot's screen (plan 9.3, the `computer` tool). The set
// mirrors Anthropic's computer-use actions under the plan's names, so the
// Anthropic native tool maps onto it one to one (`fromAnthropicAction`).

/** The screen size every Bot's display is started at; screenshots are this size. */
export const SCREEN_SIZE = { width: 1280, height: 800 } as const;

const X = z.number().int().min(0).max(10_000);
const Point = z.tuple([X, X]);

export const ComputerActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('screenshot') }),
  z.object({
    action: z.literal('click'),
    coordinate: Point,
    button: z.enum(['left', 'right', 'middle']).optional(),
    /** 3 for a triple click. */
    count: z.number().int().min(1).max(3).optional(),
  }),
  z.object({ action: z.literal('double_click'), coordinate: Point }),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(10_000) }),
  z.object({
    action: z.literal('key'),
    /** xdotool key syntax: `Return`, `ctrl+l`, `alt+Tab`. */
    text: z.string().min(1).max(200),
  }),
  z.object({
    action: z.literal('scroll'),
    coordinate: Point,
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(50).optional(),
  }),
  z.object({ action: z.literal('move'), coordinate: Point }),
  z.object({ action: z.literal('drag'), from: Point, to: Point }),
  /** A pause for a page to settle; never reaches the agent. */
  z.object({ action: z.literal('wait'), seconds: z.number().min(0).max(30) }),
]);

export type ComputerAction = z.infer<typeof ComputerActionSchema>;
/** The input actions the agent's `/screens/:n/input` takes (everything but a screenshot or a wait). */
export type InputAction = Exclude<ComputerAction, { action: 'screenshot' | 'wait' }>;

/** An Anthropic computer-use call (`computer_20250124`, `computer_toolset_20260801`). */
export interface AnthropicComputerInput {
  action: string;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  text?: string;
  scroll_direction?: 'up' | 'down' | 'left' | 'right';
  scroll_amount?: number;
  duration?: number;
}

/** The plan's action for a native Anthropic call; throws for actions OpenBots does not offer. */
export function fromAnthropicAction(input: AnthropicComputerInput): ComputerAction {
  const at = () => {
    if (!input.coordinate) throw new Error(`${input.action} needs a coordinate`);
    return input.coordinate;
  };
  switch (input.action) {
    case 'screenshot':
    case 'zoom':
      return { action: 'screenshot' };
    case 'left_click':
      return { action: 'click', coordinate: at() };
    case 'right_click':
      return { action: 'click', coordinate: at(), button: 'right' };
    case 'middle_click':
      return { action: 'click', coordinate: at(), button: 'middle' };
    case 'triple_click':
      return { action: 'click', coordinate: at(), count: 3 };
    case 'double_click':
      return { action: 'double_click', coordinate: at() };
    case 'mouse_move':
      return { action: 'move', coordinate: at() };
    case 'left_click_drag':
      if (!input.start_coordinate) throw new Error('left_click_drag needs a start_coordinate');
      return { action: 'drag', from: input.start_coordinate, to: at() };
    case 'type':
      return { action: 'type', text: input.text ?? '' };
    case 'key':
    case 'hold_key':
      return { action: 'key', text: input.text ?? '' };
    case 'scroll':
      return {
        action: 'scroll',
        coordinate: input.coordinate ?? [SCREEN_SIZE.width / 2, SCREEN_SIZE.height / 2],
        direction: input.scroll_direction ?? 'down',
        ...(input.scroll_amount ? { amount: Math.round(input.scroll_amount) } : {}),
      };
    case 'wait':
      return { action: 'wait', seconds: Math.min(Math.max(input.duration ?? 1, 0), 30) };
    default:
      throw new Error(`The computer does not support the ${input.action} action`);
  }
}
