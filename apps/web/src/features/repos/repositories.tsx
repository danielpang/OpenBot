import {
  Button,
  cn,
  IconButton,
  Input,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  Spinner,
  Switch,
  TerminalIcon,
  TrashIcon,
  XIcon,
} from '@openbots/ui';
import type { SVGProps } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ErrorText } from '../models/error-text.js';
import { useRealtime } from '../transcript/realtime.js';
import {
  addRepo,
  ago,
  cloneRepo,
  forgetRepo,
  foundReposQuery,
  gitConnectionsQuery,
  patchRepo,
  rememberFound,
  reposQuery,
  rescueStatus,
  scanRepos,
  startRescue,
  updateRepo,
  type FoundRepo,
  type GitConnectionView,
  type Repo,
} from './api.js';
import { RepoPicker } from './picker.js';

// The Computer page's Repositories (GH3 to GH6): every repository the owner
// keeps, with its state on the computer (Ready, Cloning, Updating, Behind by
// N, Local changes, Missing), its branch, path and last push, and Update,
// Clone, Open terminal, Pin, Keep cloned and Forget (which can also delete
// the files). Add from GitHub opens the picker for a connection; Add by URL
// takes any git URL. Clones found on the computer that nobody remembered are
// listed below with Remember (GH6); Scan now queues a scan and watches the
// found list for a short while. Rescue unpushed work pushes local commits and
// changes to rescue branches, polling until it is done (GH5). The list
// refetches on `computer.status` and every 30 seconds while a clone or update
// runs. A clone or update that has not moved for 30 minutes shows Stuck
// instead of a spinner: the server retries it when the computer starts.

const BUSY_POLL_MS = 30_000;
export const RESCUE_POLL_MS = 2_000;
export const SCAN_POLL_MS = 2_000;
export const SCAN_WATCH_MS = 20_000;
export const STUCK_MS = 30 * 60_000;
const TOAST_MS = 8_000;

type Pill = { label: string; tone: 'green' | 'neutral' | 'amber' | 'red'; spin?: boolean };

const TONE: Record<Pill['tone'], string> = {
  green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  neutral: 'bg-muted text-muted-foreground',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  red: 'bg-destructive/15 text-destructive',
};

/** The state pill of one repository; `updating` while its Update runs. */
export function repoPill(repo: Repo, updating = false): Pill {
  const checkout = repo.checkout;
  if (updating || checkout?.state === 'updating') {
    return { label: 'Updating', tone: 'neutral', spin: true };
  }
  switch (checkout?.state ?? 'missing') {
    case 'ready':
      return { label: 'Ready', tone: 'green' };
    case 'cloning':
      return { label: 'Cloning', tone: 'neutral', spin: true };
    case 'behind':
      return { label: `Behind by ${checkout?.behind ?? 0}`, tone: 'amber' };
    case 'dirty':
      return { label: 'Local changes', tone: 'amber' };
    case 'error':
      return { label: 'Error', tone: 'red' };
    default:
      return { label: 'Missing', tone: 'red' };
  }
}

const busy = (repo: Repo) =>
  repo.checkout?.state === 'cloning' || repo.checkout?.state === 'updating';

/**
 * Whether a clone or update looks stuck: its checkout last changed (or, when
 * the server does not say, this page first saw it busy) over 30 minutes ago.
 */
export function isStuck(repo: Repo, seenAt: number, now: number): boolean {
  const changed = repo.checkout?.updatedAt ? new Date(repo.checkout.updatedAt).getTime() : NaN;
  const since = Number.isFinite(changed) ? Math.min(changed, seenAt) : seenAt;
  return now - since >= STUCK_MS;
}

/** The paths of the found list, to tell when a scan changed it. */
const foundKey = (found: FoundRepo[] | undefined) =>
  (found ?? [])
    .map((f) => f.path)
    .sort()
    .join('\n');

/** Pinned repositories first, the rest in the server's order. */
const pinnedFirst = (repos: Repo[]) =>
  [...repos].sort((a, b) => Number(b.pinned) - Number(a.pinned));

/** Disk use in human units with one decimal: 12.4 MB. */
export function formatDisk(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}

/** What the checkouts take on disk together; null when none says. */
export function diskTotal(repos: readonly Repo[]): number | null {
  const sizes = repos.flatMap((r) => (typeof r.diskBytes === 'number' ? [r.diskBytes] : []));
  return sizes.length ? sizes.reduce((a, b) => a + b, 0) : null;
}

export function Repositories({
  running,
  onOpenTerminal,
}: {
  /** Whether the computer runs, so a terminal can open. */
  running: boolean;
  onOpenTerminal(cwd: string): void;
}) {
  const queryClient = useQueryClient();
  const repos = useQuery({
    ...reposQuery,
    refetchInterval: (query) => (query.state.data?.repos.some(busy) ? BUSY_POLL_MS : false),
  });
  // After Scan now the server answers 202 and scans in the background: watch
  // the found list every 2 seconds until it changes or 20 seconds pass.
  const [scanning, setScanning] = useState<{ until: number; before: string } | null>(null);
  const found = useQuery({
    ...foundReposQuery,
    refetchInterval: scanning ? SCAN_POLL_MS : false,
  });
  const connections = useQuery(gitConnectionsQuery);
  const usable = (connections.data ?? []).filter((c) => c.status === 'connected');
  const [adding, setAdding] = useState<'url' | 'choose' | null>(null);
  const [picking, setPicking] = useState<GitConnectionView | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  const scan = useMutation({
    mutationFn: scanRepos,
    onSuccess: () =>
      setScanning({ until: Date.now() + SCAN_WATCH_MS, before: foundKey(found.data) }),
  });
  const foundNow = foundKey(found.data);
  useEffect(() => {
    if (!scanning) return;
    const left = scanning.until - Date.now();
    if (foundNow !== scanning.before || left <= 0) {
      setScanning(null);
      return;
    }
    const timer = setTimeout(() => setScanning(null), left);
    return () => clearTimeout(timer);
  }, [scanning, foundNow]);

  const { client } = useRealtime();
  useEffect(() => {
    if (!client) return;
    return client.on('computer.status', () => {
      void queryClient.invalidateQueries({ queryKey: reposQuery.queryKey });
    });
  }, [client, queryClient]);

  function addFromGithub() {
    if (usable.length === 1) setPicking(usable[0]!);
    else setAdding(adding === 'choose' ? null : 'choose');
  }

  const list = pinnedFirst(repos.data?.repos ?? []);
  const unremembered = found.data ?? [];
  const total = diskTotal(list);

  return (
    <section className="flex flex-col gap-3" aria-label="Repositories">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex flex-1 items-baseline gap-2 font-medium">
          Repositories
          {total !== null && (
            <span className="text-xs font-normal text-muted-foreground" data-disk-total>
              {formatDisk(total)} on disk
            </span>
          )}
        </h2>
        {usable.length > 0 ? (
          <Button size="sm" onClick={addFromGithub}>
            Add from GitHub
          </Button>
        ) : (
          <a
            href="/connectors"
            className="text-sm font-medium underline-offset-2 hover:underline"
            data-connect-github
          >
            Connect GitHub to add from GitHub
          </a>
        )}
        {adding !== 'url' && (
          <IconButton label="Add by URL" onClick={() => setAdding('url')}>
            <LinkIcon />
          </IconButton>
        )}
        <RescueButton disabled={!running || list.length === 0} />
      </div>
      <p className="text-xs text-muted-foreground">
        Keep cloned is set per repository. A kept repository is cloned again by itself when the
        computer starts with an empty home.
      </p>
      {adding === 'choose' && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 text-sm">
          <span className="text-muted-foreground">Add from</span>
          {usable.map((connection) => (
            <Button
              key={connection.id}
              size="sm"
              variant="outline"
              onClick={() => {
                setAdding(null);
                setPicking(connection);
              }}
            >
              {connection.accountLogin}
            </Button>
          ))}
        </div>
      )}
      {adding === 'url' && <AddRepoForm onDone={() => setAdding(null)} />}
      {repos.error ? (
        <ErrorText error={repos.error} />
      ) : repos.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repositories yet. Add one from GitHub or by its git URL and coding agents can work on
          it.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card text-sm">
          {list.map((repo) => (
            <RepoRow
              key={repo.id}
              repo={repo}
              running={running}
              onOpenTerminal={onOpenTerminal}
              onForgotten={setToast}
            />
          ))}
        </ul>
      )}
      {(unremembered.length > 0 || running) && (
        <div className="flex flex-col gap-2" aria-label="Found on the computer">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 flex-1 text-sm font-medium">
              Found on the computer, not remembered
            </h3>
            {running && (
              <IconButton
                label={scan.isPending || scanning ? 'Scanning…' : 'Scan now'}
                busy={scan.isPending || !!scanning}
                onClick={() => scan.mutate()}
              >
                <SearchIcon />
              </IconButton>
            )}
          </div>
          <ErrorText error={scan.error} />
          {unremembered.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing found. Repositories you clone by hand in the terminal show here.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border bg-card text-sm">
              {unremembered.map((item) => (
                <FoundRow key={item.path} item={item} />
              ))}
            </ul>
          )}
        </div>
      )}
      <RepoPicker connection={picking} onClose={() => setPicking(null)} />
      {toast && <Toast onClose={closeToast}>{toast}</Toast>}
    </section>
  );
}

/** A short notice in the corner that goes away by itself. */
function Toast({ children, onClose }: { children: ReactNode; onClose(): void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, TOAST_MS);
    return () => clearTimeout(timer);
  }, [children, onClose]);
  return (
    <div
      role="status"
      data-toast
      className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
    >
      <span className="min-w-0 flex-1">{children}</span>
      <IconButton label="Dismiss" className="-my-1 -mr-1" onClick={onClose}>
        <XIcon />
      </IconButton>
    </div>
  );
}

/** The spinner pill of a clone or update, which turns into Stuck after 30 minutes. */
function BusyPill({ repo, label }: { repo: Repo; label: string }) {
  const [seenAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (isStuck(repo, seenAt, now)) {
    return (
      <>
        <span data-stuck className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TONE.amber)}>
          Stuck
        </span>
        <span className="text-xs text-muted-foreground">Will retry when the computer starts.</span>
      </>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        TONE.neutral,
      )}
    >
      <Spinner aria-hidden className="size-3" />
      {label}
    </span>
  );
}

function RepoRow({
  repo,
  running,
  onOpenTerminal,
  onForgotten,
}: {
  repo: Repo;
  running: boolean;
  onOpenTerminal(cwd: string): void;
  /** Called with the server's note on what happened to the files. */
  onForgotten(note: string): void;
}) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const write = (next: Repo) =>
    queryClient.setQueryData(reposQuery.queryKey, (current) =>
      current ? { repos: current.repos.map((r) => (r.id === next.id ? next : r)) } : current,
    );
  const update = useMutation({ mutationFn: () => updateRepo(repo.id), onSuccess: write });
  const clone = useMutation({ mutationFn: () => cloneRepo(repo.id), onSuccess: write });
  const patch = useMutation({
    mutationFn: (body: { keepCloned?: boolean; pinned?: boolean }) => patchRepo(repo.id, body),
    onSuccess: write,
  });
  const forget = useMutation({
    mutationFn: () => forgetRepo(repo.id, deleteFiles),
    onSuccess: ({ note }) => {
      onForgotten(note);
      queryClient.setQueryData(reposQuery.queryKey, (current) =>
        current ? { repos: current.repos.filter((r) => r.id !== repo.id) } : current,
      );
    },
  });

  const pill = repoPill(repo, update.isPending);
  const state = repo.checkout?.state ?? 'missing';
  const onComputer =
    state !== 'missing' && state !== 'cloning' && state !== 'updating' && !!repo.checkout?.path;
  const pending = update.isPending || clone.isPending || forget.isPending;
  const pushed = ago(repo.lastRemotePushAt);

  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-repo={repo.fullName}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            {repo.pinned && (
              <span className="text-xs text-muted-foreground" aria-label="Pinned">
                Pinned
              </span>
            )}
            <span className="font-medium">{repo.fullName}</span>
            {pill.spin ? (
              <span data-state={state} className="contents">
                <BusyPill key={pill.label} repo={repo} label={pill.label} />
              </span>
            ) : (
              <span
                data-state={state}
                className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TONE[pill.tone])}
              >
                {pill.label}
              </span>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {repo.defaultBranch ?? 'default branch'} ·{' '}
            {repo.checkout?.path ?? 'not on this computer'}
            {typeof repo.diskBytes === 'number' && (
              <span data-disk>
                {' · '}
                {formatDisk(repo.diskBytes)}
              </span>
            )}
          </p>
          {pushed && (
            <p className="text-xs text-muted-foreground" data-last-push>
              Last pushed to GitHub {pushed}
            </p>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {(state === 'missing' || state === 'error') && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => clone.mutate()}>
              Clone
            </Button>
          )}
          {onComputer && (
            <IconButton
              label="Update"
              busy={update.isPending}
              disabled={pending}
              onClick={() => update.mutate()}
            >
              <RefreshIcon />
            </IconButton>
          )}
          {onComputer && running && (
            <IconButton label="Open terminal" onClick={() => onOpenTerminal(repo.checkout!.path!)}>
              <TerminalIcon />
            </IconButton>
          )}
          <IconButton
            label={repo.pinned ? 'Unpin' : 'Pin'}
            aria-pressed={repo.pinned}
            disabled={patch.isPending}
            className={repo.pinned ? 'text-foreground' : undefined}
            onClick={() => patch.mutate({ pinned: !repo.pinned })}
          >
            <PinIcon />
          </IconButton>
          {!confirm && (
            <IconButton label="Forget" disabled={pending} onClick={() => setConfirm(true)}>
              <TrashIcon />
            </IconButton>
          )}
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          name="keepCloned"
          checked={repo.keepCloned}
          disabled={patch.isPending}
          onChange={(e) => patch.mutate({ keepCloned: e.target.checked })}
        />
        Keep cloned on the computer
      </label>
      {state === 'error' && repo.checkout?.error && (
        <p className="text-xs text-destructive">{repo.checkout.error}</p>
      )}
      {confirm && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/40 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-xs">
              Forget {repo.fullName}? Coding agents can no longer use it until you add it again.
            </p>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={forget.isPending}
              onClick={() => forget.mutate()}
            >
              Forget
            </Button>
          </div>
          {repo.checkout?.path && (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                name="deleteFiles"
                checked={deleteFiles}
                onChange={(e) => setDeleteFiles(e.target.checked)}
              />
              Also delete its files from the computer. Work that was not pushed is lost.
            </label>
          )}
        </div>
      )}
      <ErrorText error={update.error ?? clone.error ?? patch.error ?? forget.error} />
    </li>
  );
}

function FoundRow({ item }: { item: FoundRepo }) {
  const queryClient = useQueryClient();
  const remember = useMutation({
    mutationFn: () => rememberFound(item.path),
    onSuccess: async () => {
      queryClient.setQueryData(foundReposQuery.queryKey, (current) =>
        current?.filter((f) => f.path !== item.path),
      );
      await queryClient.invalidateQueries({ queryKey: reposQuery.queryKey });
    },
  });
  return (
    <li className="flex flex-col gap-1 px-4 py-3" data-found={item.path}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{item.fullName ?? item.path}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              Not remembered
            </span>
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {item.path} · {item.remoteUrl}
          </p>
        </div>
        <IconButton label="Remember" busy={remember.isPending} onClick={() => remember.mutate()}>
          <PlusIcon />
        </IconButton>
      </div>
      <ErrorText error={remember.error} />
    </li>
  );
}

/** Rescue unpushed work (GH5): start it, poll every 2 seconds, then list what happened. */
function RescueButton({ disabled }: { disabled: boolean }) {
  const [requestId, setRequestId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: startRescue,
    onSuccess: (answer) => setRequestId(answer.requestId),
  });
  const status = useQuery({
    queryKey: ['repos', 'rescue', requestId],
    queryFn: () => rescueStatus(requestId!),
    enabled: !!requestId,
    refetchInterval: (query) => (query.state.data?.status === 'done' ? false : RESCUE_POLL_MS),
  });
  const runningNow = start.isPending || (!!requestId && status.data?.status !== 'done');
  const results = status.data?.status === 'done' ? status.data.results : null;
  const close = () => {
    setRequestId(null);
    start.reset();
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || runningNow}
        onClick={() => start.mutate()}
      >
        Rescue unpushed work
      </Button>
      {(runningNow || results || start.error || status.error) && (
        <div
          className="flex w-full flex-col gap-2 rounded-lg border bg-card p-3 text-sm"
          aria-label="Rescue"
          data-rescue={runningNow ? 'running' : 'done'}
        >
          {runningNow ? (
            <p className="flex items-center gap-2 text-muted-foreground" role="status">
              <Spinner aria-hidden className="size-3" />
              Pushing unpushed commits and changes to rescue branches…
            </p>
          ) : results ? (
            <>
              <p className="font-medium" role="status">
                {results.length === 0
                  ? 'Nothing needed saving. Every repository was already pushed.'
                  : `Rescue finished for ${results.length === 1 ? '1 repository' : `${results.length} repositories`}.`}
              </p>
              {results.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {results.map((result) => (
                    <li
                      key={result.repoId}
                      className="flex flex-col"
                      data-rescued={result.fullName}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{result.fullName}</span>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-xs font-medium',
                            result.pushed ? TONE.green : TONE.amber,
                          )}
                        >
                          {result.pushed ? 'Pushed' : 'Not pushed'}
                        </span>
                        {result.branch && (
                          <code className="text-xs text-muted-foreground">{result.branch}</code>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">{result.note}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
          <ErrorText error={start.error ?? status.error} />
          {!runningNow && (
            <IconButton label="Close" className="self-end" onClick={close}>
              <XIcon />
            </IconButton>
          )}
        </div>
      )}
    </>
  );
}

function AddRepoForm({ onDone }: { onDone(): void }) {
  const queryClient = useQueryClient();
  const [remoteUrl, setRemoteUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [keepCloned, setKeepCloned] = useState(true);
  const add = useMutation({
    mutationFn: addRepo,
    onSuccess: (repo) => {
      queryClient.setQueryData(reposQuery.queryKey, (current) =>
        current ? { repos: [...current.repos.filter((r) => r.id !== repo.id), repo] } : current,
      );
      void queryClient.invalidateQueries({ queryKey: reposQuery.queryKey });
      onDone();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const url = remoteUrl.trim();
    if (!url) return;
    const branch = defaultBranch.trim();
    add.mutate({ remoteUrl: url, keepCloned, ...(branch ? { defaultBranch: branch } : {}) });
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Add repository"
      className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm"
    >
      <label className="flex flex-col gap-1">
        <span className="font-medium">Git URL</span>
        <Input
          name="remoteUrl"
          required
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          placeholder="https://github.com/owner/name.git"
          autoComplete="off"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">Default branch</span>
        <Input
          name="defaultBranch"
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          placeholder="The repository's own default"
          autoComplete="off"
        />
      </label>
      <label className="flex items-center gap-2">
        <Switch
          name="keepCloned"
          checked={keepCloned}
          onChange={(e) => setKeepCloned(e.target.checked)}
        />
        Keep it cloned on the computer
      </label>
      <ErrorText error={add.error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={add.isPending || !remoteUrl.trim()}>
          Add repository
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Glyph({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

function PinIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Glyph>
  );
}

function LinkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Glyph>
  );
}
