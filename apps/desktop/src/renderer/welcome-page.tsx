import { Avatar } from '@openbots/avatars/react';
import type { AvatarState } from '@openbots/avatars';
import { Badge, Button, Card, cn, Input, Spinner } from '@openbots/ui';
import { useEffect, type FormEvent, type ReactNode } from 'react';
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CloudIcon,
  LaptopIcon,
  MoonIcon,
  PairedIcon,
  ServerIcon,
  SunIcon,
  UserIcon,
} from './icons.js';
import { LocalSetup } from './local-setup.js';
import { Notice, WindowFrame } from './parts.js';
import { SavedConnections } from './saved-connections.js';
import type { StartFlow, StartState } from './start-flow.js';

// The welcome screen (plan 14.4): the ways to connect, as cards.

/** A few of the product's own generated Bots, at rest and at work. */
const HERO_BOTS: { seed: string; state: AvatarState }[] = [
  { seed: 'pixel', state: 'idle' },
  { seed: 'juniper', state: 'idle' },
  { seed: 'atlas', state: 'thinking' },
  { seed: 'marlowe', state: 'idle' },
  { seed: 'sprocket', state: 'idle' },
];

export function WelcomePage({ flow, state }: { flow: StartFlow; state: StartState }) {
  const { welcome, error } = state;
  const title = welcome.changing ? 'Change connection' : 'Welcome to OpenBots';
  useEffect(() => {
    if (welcome.changing) document.title = 'Change connection';
  }, [welcome.changing]);
  const errorFor = (place: string) => (error?.place === place ? error : null);

  return (
    <WindowFrame>
      <header className="flex flex-col items-center text-center">
        <div className="flex items-center gap-2.5" aria-hidden>
          {HERO_BOTS.map((bot) => (
            <Avatar key={bot.seed} params={{ seed: bot.seed }} state={bot.state} size={48} />
          ))}
        </div>
        <h1
          id="welcome-title"
          className="mt-5 text-[28px] leading-tight font-semibold tracking-tight"
        >
          {title}
        </h1>
        <p className="mt-2 max-w-md text-[15px] text-pretty text-muted-foreground">
          Choose where your Bots run.
        </p>
      </header>

      {error && !['cloud', 'server', 'pair', 'local'].includes(error.place) && (
        <Notice id="welcome-error" className="mt-8" title={error.message} />
      )}

      <ul className="mt-9 grid gap-3" aria-label="Ways to connect">
        <CloudChoice flow={flow} state={state} error={errorFor('cloud')?.message ?? null} />
        <ServerChoice flow={flow} state={state} error={errorFor('server')?.message ?? null} />
        <PairChoice flow={flow} state={state} error={errorFor('pair')?.message ?? null} />
        <LocalChoice flow={flow} state={state} error={errorFor('local')?.message ?? null} />
      </ul>

      <SavedConnections flow={flow} state={state} className="mt-10" />
    </WindowFrame>
  );
}

function ChoiceCard({
  icon,
  title,
  description,
  facts,
  action,
  disabled,
  children,
  labelId,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  facts: { icon: ReactNode; text: string }[];
  action: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
  labelId: string;
}) {
  return (
    <li>
      <Card
        aria-labelledby={labelId}
        aria-disabled={disabled || undefined}
        className={cn(
          'gap-0 overflow-hidden py-0 transition-shadow',
          disabled ? 'bg-transparent shadow-none' : 'hover:shadow-md',
        )}
      >
        <div className="flex items-start gap-4 p-5">
          <div
            className={cn(
              'grid size-10 shrink-0 place-items-center rounded-[10px] border bg-background [&_svg]:size-5',
              disabled ? 'text-muted-foreground' : 'text-foreground shadow-xs',
            )}
          >
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id={labelId}
              className={cn(
                'text-[15px] leading-snug font-semibold',
                disabled && 'text-muted-foreground',
              )}
            >
              {title}
            </h2>
            <p className="mt-1 text-sm text-pretty text-muted-foreground">{description}</p>
            <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {facts.map((fact) => (
                <li key={fact.text} className="inline-flex items-center gap-1.5 [&_svg]:size-3.5">
                  {fact.icon}
                  {fact.text}
                </li>
              ))}
            </ul>
          </div>
          <div className="shrink-0 self-center">{action}</div>
        </div>
        {children}
      </Card>
    </li>
  );
}

/** The part of a card that grows with the choice: a form, progress, what to do next. */
function CardPanel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('border-t bg-muted/30 px-5 py-4', className)}>{children}</div>;
}

function CloudChoice({
  flow,
  state,
  error,
}: {
  flow: StartFlow;
  state: StartState;
  error: string | null;
}) {
  const { cloud } = state.welcome;
  return (
    <ChoiceCard
      labelId="cloud-title"
      icon={<CloudIcon />}
      title="Sign in to an OpenBots account"
      disabled={!cloud.enabled}
      description={
        <span id="cloud-note">
          {cloud.note ?? 'Sign in or create an account. Nothing to install.'}
        </span>
      }
      facts={[
        { icon: <UserIcon />, text: 'Hosted by OpenBots' },
        { icon: <SunIcon />, text: 'Works while this Mac sleeps' },
      ]}
      action={
        cloud.enabled ? (
          <Button id="cloud-go" type="button" onClick={() => void flow.welcome.cloud()}>
            Sign in or sign up
          </Button>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            Coming soon
          </Badge>
        )
      }
    >
      {error && (
        <CardPanel>
          <Notice title={error} />
        </CardPanel>
      )}
    </ChoiceCard>
  );
}

function ServerChoice({
  flow,
  state,
  error,
}: {
  flow: StartFlow;
  state: StartState;
  error: string | null;
}) {
  const { address, warning, checking } = state.welcome;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void flow.welcome.connectServer();
  };
  const hint = error ? 'server-error' : warning ? 'server-warning' : undefined;
  return (
    <ChoiceCard
      labelId="server-title"
      icon={<ServerIcon />}
      title="Connect to a self-hosted server"
      description="Your OpenBots server, on a computer you manage."
      facts={[
        { icon: <UserIcon />, text: 'Hosted by you' },
        { icon: <SunIcon />, text: 'Works while this Mac sleeps' },
      ]}
      action={null}
    >
      <CardPanel className="pt-3.5">
        <form id="server-form" onSubmit={submit} noValidate>
          <label htmlFor="server-url" className="text-xs font-medium text-muted-foreground">
            Server address
          </label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id="server-url"
              value={address}
              onChange={(event) => flow.welcome.setAddress(event.target.value)}
              placeholder="openbots.example.com"
              required
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={hint}
              className="bg-background"
            />
            <Button
              id="server-go"
              type="submit"
              disabled={checking || address.trim() === ''}
              className="min-w-24"
            >
              {checking ? (
                <>
                  <Spinner className="motion-reduce:animate-none" aria-label="Checking" />
                  Checking…
                </>
              ) : (
                'Connect'
              )}
            </Button>
          </div>
          {error ? (
            <p
              id="server-error"
              role="alert"
              className="mt-2 flex items-start gap-1.5 text-[13px] text-destructive"
            >
              <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : warning ? (
            <p
              id="server-warning"
              className="mt-2 flex items-start gap-1.5 text-[13px] text-amber-700 dark:text-amber-400"
            >
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              {warning}
            </p>
          ) : null}
        </form>
      </CardPanel>
    </ChoiceCard>
  );
}

function PairChoice({
  flow,
  state,
  error,
}: {
  flow: StartFlow;
  state: StartState;
  error: string | null;
}) {
  const { pairLink, pairing } = state.welcome;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void flow.welcome.connectPair();
  };
  return (
    <ChoiceCard
      labelId="pair-title"
      icon={<PairedIcon />}
      title="Connect to another Mac"
      description="Use OpenBots running on another Mac or server. On it, choose Pair your phone… and copy the link."
      facts={[
        { icon: <UserIcon />, text: 'Hosted on the other Mac' },
        { icon: <MoonIcon />, text: 'Pauses while that Mac sleeps' },
      ]}
      action={null}
    >
      <CardPanel className="pt-3.5">
        <form id="pair-form" onSubmit={submit} noValidate>
          <label htmlFor="pair-link" className="text-xs font-medium text-muted-foreground">
            Pairing link
          </label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id="pair-link"
              value={pairLink}
              onChange={(event) => flow.welcome.setPairLink(event.target.value)}
              placeholder="openbots://pair#…"
              required
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'pair-error' : 'pair-note'}
              className="bg-background"
            />
            <Button
              id="pair-go"
              type="submit"
              disabled={pairing || pairLink.trim() === ''}
              className="min-w-24"
            >
              {pairing ? (
                <>
                  <Spinner className="motion-reduce:animate-none" aria-label="Pairing" />
                  Pairing…
                </>
              ) : (
                'Pair'
              )}
            </Button>
          </div>
          {error ? (
            <p
              id="pair-error"
              role="alert"
              className="mt-2 flex items-start gap-1.5 text-[13px] text-destructive"
            >
              <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : (
            <p id="pair-note" className="mt-2 text-[13px] text-muted-foreground">
              The link works once, for 5 minutes. This Mac reaches the other one through its relay,
              end to end encrypted.
            </p>
          )}
        </form>
      </CardPanel>
    </ChoiceCard>
  );
}

function LocalChoice({
  flow,
  state,
  error,
}: {
  flow: StartFlow;
  state: StartState;
  error: string | null;
}) {
  const { local } = state.welcome;
  return (
    <ChoiceCard
      labelId="local-title"
      icon={<LaptopIcon />}
      title="Run OpenBots on this Mac"
      description="The OpenBots server runs here, in Docker."
      facts={[
        { icon: <UserIcon />, text: 'Hosted on this Mac' },
        { icon: <MoonIcon />, text: 'Pauses while this Mac sleeps' },
      ]}
      action={
        local.kind === 'idle' ? (
          <Button
            id="local-go"
            type="button"
            variant="outline"
            onClick={() => void flow.welcome.setUpLocal()}
          >
            Set up on this Mac
          </Button>
        ) : null
      }
    >
      {local.kind !== 'idle' && (
        <CardPanel>
          <LocalSetup flow={flow} local={local} error={error} />
        </CardPanel>
      )}
    </ChoiceCard>
  );
}
