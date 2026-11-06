import { Button, cn } from '@openbots/ui';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ErrorText } from '../models/error-text.js';
import { Repositories } from '../repos/repositories.js';
import { updateComputerSettings, type Computer, type PtyAttach } from './api.js';
import { FileBrowser } from './files.js';
import { ResetComputerDialog } from './reset-dialog.js';
import { useComputer, useRestartComputer, useStartComputer, useWriteComputer } from './live.js';
import { ComputerIcon } from './status-icon.js';
import { ComputerTerminal } from './terminal.js';

// The account-level Computer page (K1, K2, K7, plan 9.4): the computer's
// status from `computer.status`, Start, Restart or Reset computer, how long it idles before it
// stops, and while it runs a terminal and its files, then the repositories
// coding agents work on (GH3). `attach` opens the terminal in a directory,
// as another user, with a command typed: Open terminal on a coding session
// links here with it in the search (CA7), and a repository's Open terminal
// sets it in place.

const STATUS: Record<Computer['status'], string> = {
  creating: 'Setting up',
  updating: 'Updating',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  error: 'Not working',
};

/** The steps that take a while, shown with an indeterminate progress bar. */
const BUSY = new Set<Computer['status']>(['creating', 'updating', 'starting', 'stopping']);

const attachKey = (attach: PtyAttach | undefined) =>
  JSON.stringify([attach?.cwd ?? null, attach?.user ?? null, attach?.preset ?? null]);

export function ComputerPage({ attach: linked }: { attach?: PtyAttach } = {}) {
  const { data, isPending, error, statusError } = useComputer();
  const start = useStartComputer();
  const restart = useRestartComputer();
  const [resetting, setResetting] = useState(false);
  // A repository's Open terminal replaces the linked attach until the link changes.
  const [opened, setOpened] = useState<{ base: string; attach: PtyAttach }>();
  const attach = opened && opened.base === attachKey(linked) ? opened.attach : linked;
  const terminal = useRef<HTMLElement>(null);
  const openTerminal = (cwd: string) => {
    setOpened({ base: attachKey(linked), attach: { cwd } });
    terminal.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  if (isPending) return null;
  if (error) return <ErrorText error={error} />;
  if (!data.available) {
    return <p className="text-sm text-muted-foreground">This install has no computer.</p>;
  }

  const computer = data.computer;
  const status = computer?.status ?? (start.isPending ? 'creating' : null);
  const canStart = !status || status === 'stopped' || status === 'error';

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-label="Status">
        <div className="flex items-center gap-3">
          <p className="flex flex-1 items-center gap-2 text-sm">
            <ComputerIcon
              aria-hidden
              className={cn(
                'size-4',
                status === 'running' ? 'text-emerald-500' : 'text-muted-foreground',
              )}
            />
            <span className="font-medium" data-status={status ?? 'off'}>
              {status ? STATUS[status] : 'Not started'}
            </span>
          </p>
          {canStart && (
            <Button disabled={start.isPending} onClick={() => start.mutate()}>
              Start
            </Button>
          )}
          {status === 'running' && (
            <Button variant="outline" disabled={restart.isPending} onClick={() => restart.mutate()}>
              Restart
            </Button>
          )}
          {computer && status && !BUSY.has(status) && (
            <Button variant="outline" onClick={() => setResetting(true)}>
              Reset computer
            </Button>
          )}
        </div>
        {status && BUSY.has(status) && (
          <div
            role="progressbar"
            aria-label={STATUS[status]}
            className="h-1 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
          </div>
        )}
        {status === 'error' && statusError && (
          <p className="text-sm text-destructive">{statusError}</p>
        )}
        <ErrorText error={start.error ?? restart.error} />
      </section>
      {computer && <IdleSetting computer={computer} />}
      {status === 'running' && (
        <>
          <section ref={terminal} className="flex flex-col gap-3">
            <h2 className="font-medium">Terminal</h2>
            {attach?.cwd && (
              <p className="truncate font-mono text-xs text-muted-foreground" data-terminal-cwd>
                {attach.user ? `${attach.user} in ` : ''}
                {attach.cwd}
              </p>
            )}
            <ComputerTerminal attach={attach} />
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="font-medium">Files</h2>
            <FileBrowser />
          </section>
        </>
      )}
      <Repositories running={status === 'running'} onOpenTerminal={openTerminal} />
      <ResetComputerDialog open={resetting} onClose={() => setResetting(false)} />
    </div>
  );
}

/** Idle minutes to choose from, within the server's 5 to 1440. */
const IDLE_CHOICES = [15, 30, 60, 120, 240, 480, 1440];
const DEFAULT_IDLE_MIN = 30;
const NEVER = 'never';

function idleLabel(minutes: number) {
  if (minutes === 1440) return '1 day';
  if (minutes % 60 !== 0) return `${minutes} min`;
  return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
}

const idleValue = ({ alwaysOn, idleTimeoutMin }: Pick<Computer, 'alwaysOn' | 'idleTimeoutMin'>) =>
  alwaysOn ? NEVER : String(idleTimeoutMin ?? DEFAULT_IDLE_MIN);

/** How long after its last use the computer idles before it stops, or never (plan 9.5). */
function IdleSetting({ computer }: { computer: Computer }) {
  const write = useWriteComputer();
  const save = useMutation({ mutationFn: updateComputerSettings, onSuccess: write });
  const current = computer.idleTimeoutMin ?? DEFAULT_IDLE_MIN;
  // A value set before these choices existed stays selectable.
  const choices = IDLE_CHOICES.includes(current)
    ? IDLE_CHOICES
    : [...IDLE_CHOICES, current].sort((a, b) => a - b);
  const value = idleValue(save.isPending ? { ...computer, ...save.variables } : computer);

  function change(next: string) {
    save.mutate(
      next === NEVER ? { alwaysOn: true } : { alwaysOn: false, idleTimeoutMin: Number(next) },
    );
  }

  return (
    <section className="flex flex-col gap-2" aria-label="Idle">
      <label className="flex items-center gap-3 text-sm">
        <span className="flex-1 font-medium">Stop after idle</span>
        <select
          name="idle"
          value={value}
          disabled={save.isPending}
          onChange={(event) => change(event.currentTarget.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {choices.map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {idleLabel(minutes)}
            </option>
          ))}
          <option value={NEVER}>Never</option>
        </select>
      </label>
      <ErrorText error={save.error} />
    </section>
  );
}
