import { Alert, AlertDescription, AlertTitle, cn } from '@openbots/ui';
import type { ReactNode } from 'react';
import type { ServerProfile } from '../ipc.js';
import { AlertCircleIcon, AlertTriangleIcon, ChevronRightIcon, InfoIcon } from './icons.js';

// Pieces the app pages share: the window's frame, notices with an optional
// "Show details", and the status dot.

/**
 * The page inside the main window. Its title bar is hidden (`hiddenInset`),
 * so a strip along the top drags the window and the content starts below the
 * traffic lights.
 */
export function WindowFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-sidebar dark:bg-background">
      <div aria-hidden className="fixed inset-x-0 top-0 z-10 h-11 [-webkit-app-region:drag]" />
      <main className="mx-auto w-full max-w-[680px] px-6 pt-16 pb-16">{children}</main>
    </div>
  );
}

/** Long output (a failed pull's, say) behind a disclosure, monospaced and scrollable. */
export function Details({
  id,
  preId,
  children,
}: {
  id?: string;
  preId?: string;
  children: string;
}) {
  return (
    <details id={id} className="group mt-1 w-full">
      <summary className="inline-flex cursor-default list-none items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        <span className="group-open:hidden">Show details</span>
        <span className="hidden group-open:inline">Hide details</span>
      </summary>
      <pre
        id={preId}
        tabIndex={0}
        className="mt-2 max-h-56 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-foreground/80 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {children}
      </pre>
    </details>
  );
}

/** Calm: the sentence in the text colour, the tone in the icon, border and wash. */
const NOTICE_TONES = {
  destructive:
    'border-destructive/25 bg-destructive/[0.04] dark:bg-destructive/[0.08] [&>svg]:text-destructive',
  warning:
    'border-amber-500/30 bg-amber-500/[0.06] dark:bg-amber-400/[0.07] [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400',
  default: '[&>svg]:text-muted-foreground',
} as const;

const NOTICE_ICONS = {
  destructive: AlertCircleIcon,
  warning: AlertTriangleIcon,
  default: InfoIcon,
} as const;

/**
 * A calm block for an error, a warning or a note: a sentence, more text, the
 * command output behind "Show details", and actions.
 */
export function Notice({
  variant = 'destructive',
  title,
  children,
  detail,
  detailIds,
  actions,
  className,
  id,
}: {
  variant?: keyof typeof NOTICE_ICONS;
  title: ReactNode;
  children?: ReactNode;
  detail?: string | null;
  detailIds?: { details: string; pre: string };
  actions?: ReactNode;
  className?: string;
  id?: string;
}) {
  const Icon = NOTICE_ICONS[variant];
  return (
    <Alert id={id} variant={variant} className={cn(NOTICE_TONES[variant], className)}>
      <Icon />
      <AlertTitle className="leading-snug text-foreground">{title}</AlertTitle>
      {(children || detail || actions) && (
        <AlertDescription className="text-muted-foreground!">
          {children}
          {detail && (
            <Details id={detailIds?.details} preId={detailIds?.pre}>
              {detail}
            </Details>
          )}
          {actions && <div className="mt-2 flex flex-wrap gap-2 text-foreground">{actions}</div>}
        </AlertDescription>
      )}
    </Alert>
  );
}

const DOT = {
  running: 'bg-emerald-500',
  unhealthy: 'bg-amber-500',
  stopped: 'bg-muted-foreground/50',
  busy: 'bg-sky-500',
} as const;

export function StatusDot({ tone, pulse }: { tone: keyof typeof DOT; pulse?: boolean }) {
  return (
    <span aria-hidden className="relative inline-flex size-2 shrink-0">
      {pulse && (
        <span
          className={cn(
            'absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping',
            DOT[tone],
          )}
        />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', DOT[tone])} />
    </span>
  );
}

const KIND_LABEL = { local: 'This Mac', remote: 'Self-hosted', cloud: 'OpenBots account' };

/** A connection's kind and host, e.g. "Self-hosted · openbots.example.com". */
export function connectionLine(profile: ServerProfile): string {
  const host = new URL(profile.url).host;
  const kind = KIND_LABEL[profile.kind];
  return profile.name === kind ? host : `${kind} · ${host}`;
}
