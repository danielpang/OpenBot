import { cn } from '@openbots/ui';
import type { z } from 'zod';
import type { EventPropsSchema } from '../kinds/event.js';
import type { WidgetRendererProps } from './types.js';

// The compact system row (W3): Routine ran, computer started, connector needs
// login, run blocked. One line in the timeline, never a chat bubble.

export interface EventRowProps {
  /** `blocked`, `routine_ran`, `computer_started`, `connector_login`, ... */
  kind: string;
  text: string;
  /** A follow-up the owner can take. */
  fix?: string;
  /** An app path for the follow-up, e.g. `/connectors?connector=<id>` for a connector that needs login. */
  link?: string;
  /** Opens `link` inside the app; without it the link is an ordinary page load. */
  onLink?: (href: string) => void;
}

export function EventRow({ kind, text, fix, link, onLink }: EventRowProps) {
  const blocked = kind === 'blocked';
  // Only paths inside the app; anything else in the data is not a link.
  const href = link && /^\/(?![/\\])/.test(link) ? link : undefined;
  return (
    <div
      role="status"
      data-event={kind}
      className="flex items-baseline gap-2 px-2 py-0.5 text-xs text-muted-foreground"
    >
      <span
        aria-hidden
        className={cn(
          'inline-block size-1.5 shrink-0 translate-y-[-1px] rounded-full',
          blocked ? 'bg-destructive' : 'bg-muted-foreground/50',
        )}
      />
      <span className={cn('min-w-0', blocked && 'text-foreground')}>{text}</span>
      {fix && !text.includes(fix) && <span className="min-w-0">{fix}</span>}
      {href && (
        <a
          href={href}
          className="shrink-0 underline"
          onClick={(event) => {
            if (!onLink || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            onLink(href);
          }}
        >
          {linkLabel(href)}
        </a>
      )}
    </div>
  );
}

function linkLabel(href: string): string {
  // Events stored before the rename still link to `/tools`, which redirects.
  if (href.startsWith('/connectors') || href.startsWith('/tools')) return 'Open Connectors';
  if (href.startsWith('/settings')) return 'Open Settings';
  return 'Open';
}

export function EventWidget({ props }: WidgetRendererProps<z.infer<typeof EventPropsSchema>>) {
  return <EventRow kind={props.event} text={props.text} fix={props.fix} />;
}
