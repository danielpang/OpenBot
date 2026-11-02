import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@openbots/ui';
import { useCallback, useEffect, useState, type SVGProps } from 'react';
import { useRealtimeStatus } from '../features/transcript/realtime.js';
import { indicatorState, type IndicatorTone } from './connection.js';
import {
  desktopConnection,
  type DesktopConnection,
  type DesktopConnectionInfo,
} from './platform.js';

// The Mac app's connection indicator (plan 14.4): one small icon at the foot
// of the sidebar that says how the app reaches its server. Its menu has the
// details, "Change connection…", and for This Mac the stack's Start, Stop and
// Show logs. A browser has no bridge, so nothing renders there.

/** How often the indicator asks again while the realtime connection is down. */
export const RECHECK_MS = 10_000;

export function ConnectionIndicator() {
  const [connection] = useState(desktopConnection);
  return connection ? <Indicator connection={connection} /> : null;
}

const TONES: Record<IndicatorTone, string> = {
  normal: 'text-muted-foreground',
  warning: 'text-amber-600 dark:text-amber-400',
  problem: 'text-destructive',
};

export function Indicator({
  connection,
  defaultOpen,
}: {
  connection: DesktopConnection;
  /** For tests: render with the menu open. */
  defaultOpen?: boolean;
}) {
  const realtime = useRealtimeStatus();
  const [info, setInfo] = useState<DesktopConnectionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      void connection
        .info()
        .then(setInfo)
        .catch(() => undefined),
    [connection],
  );
  useEffect(() => {
    refresh();
    if (realtime.status === 'open') return;
    // While the server does not answer, ask again: This Mac's stack may have stopped.
    const timer = setInterval(refresh, RECHECK_MS);
    return () => clearInterval(timer);
  }, [refresh, realtime.status]);

  if (!info) return null;
  const state = indicatorState(info, realtime);
  const act = (action: () => Promise<unknown>) => {
    setError(null);
    void action().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const local = info.kind === 'local';
  const stack = info.stack?.state;

  return (
    <DropdownMenu
      defaultOpen={defaultOpen}
      onOpenChange={(open) => {
        if (open) refresh();
      }}
    >
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger
              className={cn('self-start rounded-md p-1.5 hover:bg-accent', TONES[state.tone])}
              aria-label={state.tooltip}
              data-tone={state.tone}
            >
              <KindIcon kind={info.kind} className="size-4" aria-hidden />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">{state.tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuLabel>
          {state.title}
          <span className="block text-xs font-normal text-muted-foreground">{info.host}</span>
          <span className={cn('block text-xs font-normal', TONES[state.tone])}>{state.status}</span>
          {local && info.stack && (
            <span className="block text-xs font-normal text-muted-foreground">
              {info.stack.text}
            </span>
          )}
          {error && <span className="block text-xs font-normal text-destructive">{error}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {local && stack !== 'running' && (
          <DropdownMenuItem onSelect={() => act(() => connection.start().then(setInfo))}>
            Start
          </DropdownMenuItem>
        )}
        {local && stack !== 'stopped' && (
          <DropdownMenuItem onSelect={() => act(() => connection.stop())}>Stop</DropdownMenuItem>
        )}
        {local && (
          <DropdownMenuItem onSelect={() => act(() => connection.showLogs())}>
            Show logs
          </DropdownMenuItem>
        )}
        {local && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => act(() => connection.change())}>
          Change connection…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type IconProps = SVGProps<SVGSVGElement>;

function KindIcon({ kind, ...props }: { kind: DesktopConnectionInfo['kind'] } & IconProps) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'data-kind': kind,
    ...props,
  };
  switch (kind) {
    case 'cloud':
      return (
        <svg {...common}>
          <path d="M17.5 19H8a5 5 0 1 1 1.1-9.9A6 6 0 0 1 20.5 11 4 4 0 0 1 17.5 19Z" />
        </svg>
      );
    case 'remote':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="7" rx="1.5" />
          <rect x="3" y="13" width="18" height="7" rx="1.5" />
          <path d="M7 7.5h.01M7 16.5h.01" />
        </svg>
      );
    case 'local':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="11" rx="1.5" />
          <path d="M2 19h20" />
        </svg>
      );
  }
}
