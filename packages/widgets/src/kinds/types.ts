import type { z } from 'zod';

// The contract every widget kind implements (plan 12.2, W1, W2). A kind is a
// props schema, plus for interactive kinds an action schema and a reducer that
// turns an action into the stored `widget_states.state`.

export interface WidgetKind<
  Props extends z.ZodType = z.ZodType,
  Action extends z.ZodType = z.ZodType,
  State = unknown,
> {
  kind: string;
  /** What the Bot is told the kind is for, in the `show_widget` tool description. */
  description: string;
  props: Props;
  /** Present on interactive kinds; actions posted to `POST /messages/:id/widgets/:part/action`. */
  action?: Action;
  /** The state a widget starts in. */
  initialState?: (props: z.infer<Props>) => State;
  /**
   * The next state after an action, or a string explaining why the action is
   * refused (the widget is already answered, say), or `invalidAction(...)`
   * when the action itself does not fit the widget (a form's missing field).
   */
  reduce?: (
    state: State | undefined,
    action: z.infer<Action>,
    props: z.infer<Props>,
  ) => State | string | InvalidAction;
  /** What a run waiting on this widget receives as the tool result. */
  toolResult?: (state: State) => unknown;
  /**
   * A tool call the action asks for, made by the run the action starts and
   * gated by the Bot's policy like any other (W2: Send on an email draft).
   */
  toolCall?: (state: State, props: z.infer<Props>) => { toolName: string; args: unknown } | null;
  /** Bots may emit it with `show_widget`; some kinds are posted only by the system. */
  botEmits: boolean;
}

export function defineWidget<P extends z.ZodType, A extends z.ZodType, S>(
  kind: WidgetKind<P, A, S>,
): WidgetKind<P, A, S> {
  return kind;
}

/** A reducer's refusal of the action itself, as opposed to the widget being closed. */
export class InvalidAction {
  constructor(readonly error: string) {}
}

export const invalidAction = (error: string) => new InvalidAction(error);
