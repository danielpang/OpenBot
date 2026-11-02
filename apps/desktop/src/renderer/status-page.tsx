import { Badge, Button, Card, cn, Spinner } from '@openbots/ui';
import { useEffect, useRef } from 'react';
import {
  ArrowRightIcon,
  DownloadIcon,
  KindIcon,
  PlayIcon,
  RefreshIcon,
  TerminalIcon,
} from './icons.js';
import { connectionLine, Notice, StatusDot, WindowFrame } from './parts.js';
import { SavedConnections } from './saved-connections.js';
import { stackButtons, stackHealth, type StartFlow, type StartState } from './start-flow.js';

// The start page when the server does not answer: why, This Mac's stack
// (status, controls, logs) when it is This Mac, and the saved connections.

export function StatusPage({ flow, state }: { flow: StartFlow; state: StartState }) {
  const { status, error } = state;
  const profile = status.profile;
  const pageError = error?.place === 'page' ? error : null;

  return (
    <WindowFrame>
      <header className="flex items-center gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl border bg-card shadow-xs">
          <KindIcon kind={profile?.kind ?? 'local'} className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl leading-tight font-semibold tracking-tight">
            {profile?.name ?? 'OpenBots'}
          </h1>
          {profile && (
            <p className="truncate text-sm text-muted-foreground">{connectionLine(profile)}</p>
          )}
        </div>
        <Button
          id="change"
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void flow.status.change()}
        >
          Change connection…
        </Button>
      </header>

      {pageError && (
        <Notice
          id="error"
          className="mt-6"
          title={pageError.message}
          detail={pageError.detail}
          detailIds={{ details: 'error-details', pre: 'error-detail' }}
          actions={
            status.reason ? (
              <Button id="retry" type="button" size="sm" onClick={() => void flow.status.retry()}>
                <RefreshIcon />
                Try again
              </Button>
            ) : null
          }
        />
      )}
      {!pageError && status.reason && (
        <div className="mt-6">
          <Button id="retry" type="button" size="sm" onClick={() => void flow.status.retry()}>
            <RefreshIcon />
            Try again
          </Button>
        </div>
      )}

      {status.stack && <ThisMac flow={flow} state={state} />}

      <SavedConnections flow={flow} state={state} className="mt-10" />
    </WindowFrame>
  );
}

const HEALTH = {
  running: { label: 'Running', tone: 'running' },
  unhealthy: { label: 'Unhealthy', tone: 'unhealthy' },
  stopped: { label: 'Stopped', tone: 'stopped' },
} as const;

function ThisMac({ flow, state }: { flow: StartFlow; state: StartState }) {
  const { stack, busy, logs } = state.status;
  if (!stack) return null;
  const { view, status } = stack;
  const show = stackButtons(view, busy != null);
  const health = HEALTH[stackHealth(view)];
  const stackError = state.error?.place === 'stack' ? state.error : null;
  // Starting would fail on a taken port; the notice says so and offers a free one.
  const portTaken = status.docker.state === 'ready' && status.port?.taken === true && busy == null;

  return (
    <Card id="local" aria-labelledby="local-title" className="mt-6 gap-0 overflow-hidden py-0">
      <div className="flex items-start gap-3 px-5 pt-5">
        <div className="min-w-0 flex-1">
          <h2 id="local-title" className="text-[15px] font-semibold">
            OpenBots server
          </h2>
          <p className="text-sm text-muted-foreground">Runs on this Mac in Docker.</p>
        </div>
        {busy ? (
          <Badge variant="outline" className="gap-1.5">
            <StatusDot tone="busy" pulse />
            Working
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1.5" data-health={stackHealth(view)}>
            <StatusDot tone={health.tone} pulse={health.tone === 'running'} />
            {health.label}
          </Badge>
        )}
      </div>

      <div className="grid gap-4 px-5 pt-4 pb-5">
        {portTaken ? (
          <Notice
            variant="warning"
            title={`Another app is using port ${status.port?.port}`}
            actions={
              show.port ? (
                <Button
                  id="stack-port"
                  type="button"
                  size="sm"
                  onClick={() => void flow.status.usePort()}
                >
                  Use port {view.freePort}
                </Button>
              ) : null
            }
          >
            <p id="stack-status">{view.text}</p>
          </Notice>
        ) : (
          <p id="stack-status" className="flex items-start gap-2 text-sm" aria-live="polite">
            {busy && (
              <Spinner className="mt-0.5 shrink-0 text-muted-foreground motion-reduce:animate-none" />
            )}
            <span>{busy ?? view.text}</span>
          </p>
        )}

        {view.upgrade && (
          <Notice id="stack-upgrade" variant="default" title="An update is ready">
            {view.upgrade}
          </Notice>
        )}

        {status.services.length > 0 && (
          <ul
            id="services"
            className="grid gap-px overflow-hidden rounded-lg border bg-border text-sm"
          >
            {status.services.map((service) => {
              const ok =
                service.state === 'running' &&
                (service.health === '' || service.health === 'healthy');
              return (
                <li key={service.service} className="flex items-center gap-2.5 bg-card px-3 py-2">
                  <StatusDot
                    tone={ok ? 'running' : service.state === 'running' ? 'unhealthy' : 'stopped'}
                  />
                  <span className="flex-1 font-mono text-[12.5px]">{service.service}</span>
                  <span className="text-xs text-muted-foreground">
                    {service.state}
                    {service.health ? ` (${service.health})` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {stackError && (
          <Notice
            title={stackError.message}
            detail={stackError.detail}
            detailIds={{ details: 'error-details', pre: 'error-detail' }}
            actions={
              stackError.kind === 'network-clash' && busy == null ? (
                <Button
                  id="stack-network"
                  type="button"
                  size="sm"
                  onClick={() => void flow.status.useOwnNetwork()}
                >
                  Use a separate network
                </Button>
              ) : null
            }
          />
        )}

        <div className="flex flex-wrap items-center gap-2">
          {show.start && (
            <Button
              id="stack-start"
              type="button"
              size="sm"
              onClick={() => void flow.status.start()}
            >
              <PlayIcon />
              Start
            </Button>
          )}
          {show.update && (
            <Button
              id="stack-update"
              type="button"
              size="sm"
              onClick={() => void flow.status.update()}
            >
              <DownloadIcon />
              Update
            </Button>
          )}
          {show.runtime && (
            <Button
              id="stack-runtime"
              type="button"
              size="sm"
              onClick={() => void flow.status.openRuntime()}
            >
              Open Docker
            </Button>
          )}
          {show.open && (
            <Button
              id="stack-open"
              type="button"
              size="sm"
              variant={show.update ? 'outline' : 'default'}
              onClick={() => void flow.status.open()}
            >
              Open
              <ArrowRightIcon />
            </Button>
          )}
          {show.stop && (
            <Button
              id="stack-stop"
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void flow.status.stop()}
            >
              Stop
            </Button>
          )}
          <Button
            id="stack-logs"
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto text-muted-foreground"
            aria-expanded={logs.open}
            aria-controls="logs"
            onClick={() => void flow.status.toggleLogs()}
          >
            <TerminalIcon />
            {logs.open ? 'Hide logs' : 'Show logs'}
          </Button>
        </div>
      </div>

      {logs.open && <Logs lines={logs.lines} />}
    </Card>
  );
}

/** The stack's log lines, following the end unless the owner scrolled up. */
function Logs({ lines }: { lines: string[] }) {
  const box = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <pre
      id="logs"
      ref={box}
      tabIndex={0}
      aria-label="Server logs"
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className={cn(
        'h-72 overflow-auto border-t bg-muted/40 px-5 py-3 font-mono text-[11.5px] leading-[1.6] text-foreground/85 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
        lines.length === 0 && 'text-muted-foreground',
      )}
    >
      {lines.length === 0 ? 'Waiting for log lines…' : lines.join('\n')}
    </pre>
  );
}
