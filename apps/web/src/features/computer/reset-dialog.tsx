import { ApiError } from '@openbots/api-client';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { codersQuery } from '../coders/api.js';
import { ErrorText } from '../models/error-text.js';
import { reposQuery } from '../repos/api.js';
import {
  computerQuery,
  prepareReset,
  RESET_NOT_PREPARED,
  resetCheck,
  resetComputer,
  type ResetCheck,
} from './api.js';

// Reset computer: the computer starts again with an empty home. First the
// server checks for unpushed work and pushes what it can to rescue branches
// (prepare, then poll every 2 seconds); the dialog then shows what was
// pushed, what could not be saved and the coding sessions a reset stops,
// and only then offers Reset.

export const RESET_POLL_MS = 2_000;

export function ResetComputerDialog({
  open,
  onClose,
  pollMs = RESET_POLL_MS,
}: {
  open: boolean;
  onClose(): void;
  pollMs?: number;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset computer</DialogTitle>
          <DialogDescription>
            The computer starts again with an empty home. Repositories marked keep cloned are cloned
            again.
          </DialogDescription>
        </DialogHeader>
        {open && <ResetSteps onClose={onClose} pollMs={pollMs} />}
      </DialogContent>
    </Dialog>
  );
}

function ResetSteps({ onClose, pollMs }: { onClose(): void; pollMs: number }) {
  const queryClient = useQueryClient();
  const [requestId, setRequestId] = useState<string | null>(null);
  const [resetSignIns, setResetSignIns] = useState(false);
  const prepare = useMutation({
    mutationFn: prepareReset,
    onSuccess: (answer) => setRequestId(answer.requestId),
  });
  const { mutate: startCheck } = prepare;
  // The check starts once as the dialog opens.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    startCheck();
  }, [startCheck]);

  const check = useQuery({
    queryKey: ['computer', 'reset', requestId],
    queryFn: () => resetCheck(requestId!),
    enabled: !!requestId,
    refetchInterval: (query) => (query.state.data?.status === 'done' ? false : pollMs),
  });
  const reset = useMutation({
    mutationFn: () => resetComputer(requestId!, resetSignIns),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: computerQuery.queryKey, exact: true });
      void queryClient.invalidateQueries({ queryKey: reposQuery.queryKey });
      if (resetSignIns) void queryClient.invalidateQueries({ queryKey: codersQuery.queryKey });
      onClose();
    },
  });

  const done = check.data?.status === 'done' ? check.data : null;
  const checkError = prepare.error ?? check.error;
  const stale = reset.error instanceof ApiError && reset.error.code === RESET_NOT_PREPARED;
  const checkAgain = () => {
    setRequestId(null);
    reset.reset();
    startCheck();
  };

  return (
    <div className="flex flex-col gap-4 text-sm" data-reset={done ? 'checked' : 'checking'}>
      {!done && !checkError && (
        <p className="flex items-center gap-2 text-muted-foreground" role="status">
          <Spinner aria-hidden className="size-3" />
          Checking for unpushed work…
        </p>
      )}
      {done && <CheckResults check={done} />}
      {done && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="resetSignIns"
            checked={resetSignIns}
            onChange={(event) => setResetSignIns(event.currentTarget.checked)}
          />
          Also forget sign-ins: the coding agents' logins and the browser logins the Bots share
        </label>
      )}
      <ErrorText error={checkError} />
      {stale ? (
        <p className="text-sm text-destructive">
          The check is out of date. Check again before you reset.
        </p>
      ) : (
        <ErrorText error={reset.error} />
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        {(checkError || stale) && (
          <Button variant="outline" disabled={prepare.isPending} onClick={checkAgain}>
            Check again
          </Button>
        )}
        <Button
          variant="destructive"
          disabled={!done || stale || reset.isPending}
          onClick={() => reset.mutate()}
        >
          {reset.isPending ? 'Resetting…' : 'Reset'}
        </Button>
      </DialogFooter>
    </div>
  );
}

const TONE = {
  green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
};

function CheckResults({ check }: { check: ResetCheck }) {
  const pushed = check.results.filter((result) => result.pushed);
  const sessions = check.runningSessions;
  return (
    <div className="flex flex-col gap-3">
      {pushed.length === 0 && check.unsaved.length === 0 ? (
        <p data-reset-clean>Nothing needed saving. Every repository was already pushed.</p>
      ) : null}
      {pushed.length > 0 && (
        <section className="flex flex-col gap-1.5" aria-label="Pushed">
          <h3 className="font-medium">Pushed to rescue branches</h3>
          <ul className="flex flex-col gap-1.5">
            {pushed.map((result) => (
              <li key={result.repoId} className="flex flex-col" data-reset-pushed={result.fullName}>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{result.fullName}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TONE.green)}>
                    Pushed
                  </span>
                  {result.branch && (
                    <code className="text-xs text-muted-foreground">{result.branch}</code>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{result.note}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {check.unsaved.length > 0 && (
        <section className="flex flex-col gap-1.5" aria-label="Not saved">
          <h3 className="font-medium">Could not be saved</h3>
          <p className="text-xs text-muted-foreground">
            This work is lost when the computer resets.
          </p>
          <ul className="flex flex-col gap-1.5">
            {check.unsaved.map((item) => (
              <li
                key={`${item.fullName} ${item.branch}`}
                className="flex flex-col"
                data-reset-unsaved={item.fullName}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{item.fullName}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TONE.amber)}>
                    Not saved
                  </span>
                  <code className="text-xs text-muted-foreground">{item.branch}</code>
                </span>
                <span className="text-xs text-muted-foreground">{item.note}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {sessions.length > 0 && (
        <section
          className="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
          aria-label="Running sessions"
          role="alert"
        >
          <p className="font-medium">
            {sessions.length === 1
              ? '1 coding session is running. Reset stops it.'
              : `${sessions.length} coding sessions are running. Reset stops them.`}
          </p>
          <ul className="flex flex-col gap-0.5 text-xs">
            {sessions.map((session) => (
              <li key={session.id} data-reset-session={session.id}>
                {session.repoFullName}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
