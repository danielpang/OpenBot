import { WIDGET_KINDS, type WidgetKind } from './kinds/index.js';
import { InvalidAction } from './kinds/types.js';

// Lookups over the registry with the "unknown kind" fallback: a kind that is
// not registered (or registered later than this build) is never an error to
// render, only to emit or act on.

export function widgetKind(kind: string): WidgetKind | null {
  return Object.hasOwn(WIDGET_KINDS, kind)
    ? (WIDGET_KINDS[kind as keyof typeof WIDGET_KINDS] ?? null)
    : null;
}

/** Kinds a Bot may post with `show_widget` in this build. */
export function botWidgetKinds(): WidgetKind[] {
  return Object.values(WIDGET_KINDS).filter((k): k is WidgetKind => Boolean(k?.botEmits));
}

export type WidgetCheck<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validates a widget's props against its kind. */
export function validateWidgetProps(kind: string, props: unknown): WidgetCheck<unknown> {
  const def = widgetKind(kind);
  if (!def) return { ok: false, error: `Unknown widget kind "${kind}"` };
  const parsed = def.props.safeParse(props);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error: parsed.error.issues
          .map((i) => `${i.path.join('.') || 'props'}: ${i.message}`)
          .join('; '),
      };
}

/**
 * Validates a widget a Bot posts with `show_widget` (W1): the kind must be
 * one Bots may emit, since the rest (approvals, sign-in requests, Routine and
 * Artifact cards, Skill drafts, event rows) are backed by server state and
 * posted only by the system. Returns the parsed props.
 */
export function validateBotWidget(kind: string, props: unknown): WidgetCheck<unknown> {
  const def = widgetKind(kind);
  if (def && !def.botEmits) return { ok: false, error: `Only the system posts ${kind} widgets` };
  return validateWidgetProps(kind, props);
}

/** Validates an action against its kind; non-interactive kinds take none. */
export function validateWidgetAction(kind: string, action: unknown): WidgetCheck<unknown> {
  const def = widgetKind(kind);
  if (!def) return { ok: false, error: `Unknown widget kind "${kind}"` };
  if (!def.action) return { ok: false, error: `A ${kind} widget takes no actions` };
  const parsed = def.action.safeParse(action);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error: parsed.error.issues
          .map((i) => `${i.path.join('.') || 'action'}: ${i.message}`)
          .join('; '),
      };
}

export type WidgetReduction =
  { ok: true; value: unknown } | { ok: false; error: string; invalid?: true };

/**
 * Applies a validated action to a widget's stored state. Returns the next
 * state, or an error string when the kind refuses the action; `invalid` marks
 * an action that does not fit the widget, as opposed to a closed widget.
 */
export function reduceWidget(
  kind: string,
  state: unknown,
  action: unknown,
  props: unknown,
): WidgetReduction {
  const def = widgetKind(kind);
  if (!def?.reduce) return { ok: false, error: `A ${kind} widget takes no actions` };
  const next = def.reduce(state ?? def.initialState?.(props), action, props);
  if (next instanceof InvalidAction) return { ok: false, error: next.error, invalid: true };
  return typeof next === 'string' ? { ok: false, error: next } : { ok: true, value: next };
}

/** The tool call an action asks for (`WidgetKind.toolCall`), if any. */
export function widgetToolCall(
  kind: string,
  state: unknown,
  props: unknown,
): { toolName: string; args: unknown } | null {
  return widgetKind(kind)?.toolCall?.(state, props) ?? null;
}

/** What a run waiting on the widget receives once it is acted on. */
export function widgetToolResult(kind: string, state: unknown): unknown {
  return widgetKind(kind)?.toolResult?.(state) ?? state;
}
