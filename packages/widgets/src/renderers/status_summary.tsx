import { cn } from '@openbots/ui';
import type { StatusSummaryProps } from '../kinds/status_summary.js';
import type { WidgetRendererProps } from './types.js';

// Team or task status from a coordinating Bot (W1, plan 12.2): a title, an
// optional summary, then one row per piece of work with where it stands and
// who has it. Read only; there are no assignment or handoff controls
// (principle 8), the Bot posts a new summary when the picture changes.

type Status = StatusSummaryProps['items'][number]['status'];

export const STATUS_WORDS: Record<Status, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  waiting: 'Waiting',
  blocked: 'Blocked',
  done: 'Done',
};

const DOT: Record<Status, string> = {
  todo: 'border border-muted-foreground/60',
  in_progress: 'bg-foreground/70',
  waiting: 'bg-muted-foreground/50',
  blocked: 'bg-destructive',
  done: 'bg-muted-foreground',
};

export function StatusSummaryWidget({ props }: WidgetRendererProps<StatusSummaryProps>) {
  const done = props.items.filter((item) => item.status === 'done').length;
  return (
    <div
      data-widget="status_summary"
      className="flex max-w-lg flex-col gap-2 rounded-lg border bg-card p-3 text-sm"
    >
      <div className="flex items-baseline gap-2">
        <h3 className="font-medium">{props.title}</h3>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {done} of {props.items.length} done
        </span>
      </div>
      {props.summary && <p className="text-muted-foreground">{props.summary}</p>}
      <ul className="flex flex-col divide-y">
        {props.items.map((item, i) => (
          <li key={i} className="flex items-baseline gap-2 py-1.5">
            <span
              aria-hidden
              className={cn(
                'inline-block size-2 shrink-0 translate-y-[-1px] rounded-full',
                DOT[item.status],
              )}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn(item.status === 'done' && 'text-muted-foreground line-through')}>
                {item.label}
              </span>
              {item.note && <span className="text-xs text-muted-foreground">{item.note}</span>}
            </span>
            {item.owner && (
              <span className="shrink-0 text-xs text-muted-foreground">@{item.owner}</span>
            )}
            <span
              className={cn(
                'w-20 shrink-0 text-right text-xs',
                item.status === 'blocked' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {STATUS_WORDS[item.status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
