import { Button, cn, Spinner } from '@openbots/ui';
import { CheckIcon, ExternalLinkIcon, InfoIcon, RefreshIcon } from './icons.js';
import { Notice } from './parts.js';
import type { LocalSetupState, SetupPhase, StartFlow } from './start-flow.js';

// "Run OpenBots on this Mac" once chosen: the steps as they happen, or what
// to do next (install Docker, open it, use a free port, use a network of its
// own), or why it failed.

export const SETUP_STEPS: { phase: SetupPhase; label: string }[] = [
  { phase: 'checking', label: 'Check Docker' },
  { phase: 'pulling', label: 'Download OpenBots' },
  { phase: 'starting', label: 'Start the server' },
  { phase: 'waiting', label: 'Wait for the server to be ready' },
];

const RUNTIMES = [
  { name: 'OrbStack', host: 'orbstack.dev', url: 'https://orbstack.dev/download' },
  {
    name: 'Docker Desktop',
    host: 'docker.com',
    url: 'https://www.docker.com/products/docker-desktop/',
  },
];

export function LocalSetup({
  flow,
  local,
  error,
}: {
  flow: StartFlow;
  local: Exclude<LocalSetupState, { kind: 'idle' }>;
  error: string | null;
}) {
  const checkAgain = (
    <Button
      id="local-check"
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void flow.welcome.checkAgain()}
    >
      <RefreshIcon />
      Check again
    </Button>
  );

  return (
    <div id="local-setup" className="grid gap-3">
      {local.kind === 'progress' && <SetupSteps phase={local.phase} text={local.text} />}

      {local.kind === 'docker-missing' && (
        <div id="docker-missing" className="grid gap-3">
          <p className="text-sm">
            OpenBots runs in Docker. Install one of these, open it, then check again.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {RUNTIMES.map((runtime) => (
              <Button
                key={runtime.name}
                asChild
                variant="outline"
                className="h-auto justify-between bg-background px-3.5 py-2.5"
              >
                <a href={runtime.url} target="_blank" rel="noreferrer">
                  <span className="grid text-left">
                    <span className="font-medium">{runtime.name}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {runtime.host}
                    </span>
                  </span>
                  <ExternalLinkIcon className="text-muted-foreground" />
                </a>
              </Button>
            ))}
          </div>
          <div>{checkAgain}</div>
        </div>
      )}

      {local.kind === 'docker-stopped' && (
        <>
          <p className="flex items-start gap-2 text-sm">
            <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span id="local-progress">{local.text}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              id="local-runtime"
              type="button"
              size="sm"
              onClick={() => void flow.welcome.openRuntime()}
            >
              Open Docker
            </Button>
            {checkAgain}
          </div>
        </>
      )}

      {local.kind === 'port-taken' && (
        <Notice
          variant="warning"
          title="Another app is using the port OpenBots needs"
          actions={
            <>
              {local.free != null && (
                <Button
                  id="local-port"
                  type="button"
                  size="sm"
                  onClick={() => void flow.welcome.usePort()}
                >
                  Use port {local.free}
                </Button>
              )}
              {checkAgain}
            </>
          }
        >
          <p id="local-progress">{local.text}</p>
        </Notice>
      )}

      {local.kind === 'network-clash' && (
        <Notice
          variant="warning"
          title={<span id="local-progress">{local.text}</span>}
          detail={local.detail}
          detailIds={{ details: 'local-details', pre: 'local-detail' }}
          actions={
            <>
              <Button
                id="local-network"
                type="button"
                size="sm"
                onClick={() => void flow.welcome.useOwnNetwork()}
              >
                Use a separate network
              </Button>
              {checkAgain}
            </>
          }
        />
      )}

      {local.kind === 'failed' && (
        <Notice
          title={<span id="local-progress">{local.message}</span>}
          detail={local.detail}
          detailIds={{ details: 'local-details', pre: 'local-detail' }}
          actions={checkAgain}
        />
      )}

      {error && <Notice title={error} />}
    </div>
  );
}

/** The steps of setting up, the current one turning. */
export function SetupSteps({ phase, text }: { phase: SetupPhase | null; text: string }) {
  const current = SETUP_STEPS.findIndex((step) => step.phase === phase);
  if (current < 0) {
    return (
      <p className="flex items-center gap-2 text-sm" id="local-progress">
        <Spinner className="text-muted-foreground motion-reduce:animate-none" />
        {text}
      </p>
    );
  }
  return (
    <ol className="grid gap-0" aria-label="Setting up OpenBots on this Mac">
      {SETUP_STEPS.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'next';
        const last = index === SETUP_STEPS.length - 1;
        return (
          <li
            key={step.phase}
            className="relative flex gap-3 pb-3 last:pb-0"
            aria-current={state === 'current' ? 'step' : undefined}
            data-state={state}
          >
            {!last && (
              <span
                aria-hidden
                className={cn(
                  'absolute top-6 bottom-0 left-[9.5px] w-px',
                  state === 'done' ? 'bg-foreground/30' : 'bg-border',
                )}
              />
            )}
            <span
              aria-hidden
              className={cn(
                'relative z-[1] mt-0.5 grid size-5 shrink-0 place-items-center rounded-full',
                state === 'done' && 'bg-foreground text-background',
                state === 'current' && 'bg-background text-foreground ring-1 ring-foreground/20',
                state === 'next' && 'border border-dashed border-muted-foreground/40 bg-background',
              )}
            >
              {state === 'done' && <CheckIcon className="size-3" strokeWidth={3} />}
              {state === 'current' && (
                <Spinner className="size-3.5 motion-reduce:animate-none" aria-hidden />
              )}
            </span>
            <div className="min-w-0 pt-px">
              <p
                className={cn(
                  'text-sm',
                  state === 'current' && 'font-medium',
                  state === 'next' && 'text-muted-foreground',
                )}
              >
                {step.label}
                <span className="sr-only">
                  {state === 'done' ? ' (done)' : state === 'next' ? ' (to do)' : ''}
                </span>
              </p>
              {state === 'current' && (
                <p
                  id="local-progress"
                  className="mt-0.5 text-xs text-muted-foreground"
                  aria-live="polite"
                >
                  {text}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
