import { describeTrigger } from '@openbots/routines';
import type { RoutineCreatedProps } from '../kinds/routine_created.js';
import type { WidgetRendererProps } from './types.js';

// "Routine created" (R5): what was created, when it first runs, and a link
// to the Bot's Routines tab.

export function RoutineCreatedWidget({
  props,
  onNavigate,
}: WidgetRendererProps<RoutineCreatedProps>) {
  const href = `/bots/${props.bot_id}/routines`;
  return (
    <div
      data-widget="routine_created"
      className="flex max-w-lg flex-col gap-1 rounded-lg border bg-card p-3 text-sm"
    >
      <p className="font-medium">Routine created: {props.name}</p>
      <p className="text-muted-foreground">{describeTrigger(props.trigger, props.timezone)}</p>
      {props.next_run_at && (
        <p className="text-xs text-muted-foreground">
          First run {new Date(props.next_run_at).toLocaleString()}
        </p>
      )}
      <a
        href={href}
        className="w-fit text-xs font-medium hover:underline"
        onClick={(event) => {
          if (!onNavigate) return;
          event.preventDefault();
          onNavigate(href);
        }}
      >
        Open Routines
      </a>
    </div>
  );
}
