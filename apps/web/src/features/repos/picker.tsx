import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@openbots/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ErrorText } from '../models/error-text.js';
import {
  ago,
  gitConnectionsQuery,
  rememberRepos,
  remoteReposQuery,
  reposQuery,
  type GitConnectionView,
} from './api.js';

// The repository picker (GH2): every repository a connection reaches, with
// search, a Private badge, the default branch and the last push. Those
// already remembered are checked and cannot be unchecked here (Forget is on
// the Computer page). Keep on the computer remembers the rest in one call;
// the server clones them in the background.

const SEARCH_DEBOUNCE_MS = 250;

export function RepoPicker({
  connection,
  onClose,
}: {
  /** The connection to list; null keeps the dialog closed. */
  connection: Pick<GitConnectionView, 'id' | 'accountLogin'> | null;
  onClose(): void;
}) {
  return (
    <Dialog open={connection !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        {connection && <PickerBody connection={connection} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function PickerBody({
  connection,
  onClose,
}: {
  connection: Pick<GitConnectionView, 'id' | 'accountLogin'>;
  onClose(): void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const list = useQuery({
    ...remoteReposQuery(connection.id, q),
    placeholderData: keepPreviousData,
  });
  const remember = useMutation({
    mutationFn: () => rememberRepos(connection.id, [...picked]),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: reposQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: gitConnectionsQuery.queryKey }),
      ]);
      onClose();
    },
  });

  const toggle = (fullName: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });

  const repositories = list.data ?? [];
  return (
    <>
      <DialogHeader>
        <DialogTitle>Choose repositories</DialogTitle>
        <DialogDescription>
          Repositories {connection.accountLogin} can reach on GitHub. The ones you select are cloned
          on the computer so coding agents can work on them.
        </DialogDescription>
      </DialogHeader>
      <Input
        type="search"
        aria-label="Search repositories"
        placeholder="Search by name"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
        {list.error ? (
          <div className="p-3">
            <ErrorText error={list.error} />
          </div>
        ) : list.isPending ? (
          <p className="p-3 text-sm text-muted-foreground">Loading…</p>
        ) : repositories.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            {q ? `No repository matches “${q}”.` : 'This connection reaches no repositories yet.'}
          </p>
        ) : (
          <ul className="divide-y text-sm" aria-label="Repositories on GitHub">
            {repositories.map((repo) => {
              const pushed = ago(repo.pushedAt);
              return (
                <li key={repo.fullName} data-remote={repo.fullName}>
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 has-[:disabled]:cursor-default">
                    <input
                      type="checkbox"
                      className="mt-1"
                      aria-label={`Select ${repo.fullName}`}
                      checked={repo.remembered || picked.has(repo.fullName)}
                      disabled={repo.remembered}
                      onChange={() => toggle(repo.fullName)}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{repo.fullName}</span>
                        {repo.private && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            Private
                          </span>
                        )}
                        {repo.remembered && (
                          <span className="text-xs text-muted-foreground">Already kept</span>
                        )}
                      </span>
                      {repo.description && (
                        <span className="line-clamp-1 text-xs text-muted-foreground">
                          {repo.description}
                        </span>
                      )}
                      <span className="font-mono text-xs text-muted-foreground">
                        {repo.defaultBranch}
                        {pushed && ` · pushed ${pushed}`}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <ErrorText error={remember.error} />
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={picked.size === 0 || remember.isPending}
          onClick={() => remember.mutate()}
        >
          {picked.size > 0 ? `Select ${picked.size}` : 'Select repositories'}
        </Button>
      </DialogFooter>
    </>
  );
}
