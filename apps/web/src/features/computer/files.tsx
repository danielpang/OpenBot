import { Button } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ErrorText } from '../models/error-text.js';
import {
  computerFileUrl,
  filesQuery,
  HOME,
  isComputerOff,
  joinPath,
  uploadComputerFile,
  type DirEntry,
} from './api.js';
import { ComputerOff } from './computer-off.js';
import { useRefreshComputer } from './live.js';

// The file browser (K7): the computer's persistent files under /home/bot.
// Folders open in place, files download, and uploads land in the open folder,
// replacing a file of the same name. The routes never start the computer: if
// it turns out to be off (a stale page), the browser says so and offers Start.

const byFolderThenName = (a: DirEntry, b: DirEntry) =>
  Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name);

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

/** `/home/bot/a/b` as crumbs: home, a, b, each with the path it opens. */
function crumbs(path: string) {
  const rest = path.slice(HOME.length).split('/').filter(Boolean);
  return [
    { name: 'home', path: HOME },
    ...rest.map((name, i) => ({ name, path: `${HOME}/${rest.slice(0, i + 1).join('/')}` })),
  ];
}

export function FileBrowser() {
  const [path, setPath] = useState(HOME);
  const listing = useQuery(filesQuery(path));
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) await uploadComputerFile(joinPath(path, file.name), file);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: filesQuery(path).queryKey }),
  });

  const entries = [...(listing.data?.entries ?? [])].sort(byFolderThenName);
  const off = isComputerOff(listing.error) || isComputerOff(upload.error);
  const refresh = useRefreshComputer();
  useEffect(() => {
    if (off) void refresh();
  }, [off, refresh]);

  if (off) return <ComputerOff text="The computer is off." />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <nav
          aria-label="Folder"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm"
        >
          {crumbs(path).map((crumb, i, all) => (
            <span key={crumb.path} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground">/</span>}
              {i === all.length - 1 ? (
                <span aria-current="page" className="font-medium">
                  {crumb.name}
                </span>
              ) : (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground hover:underline"
                  onClick={() => setPath(crumb.path)}
                >
                  {crumb.name}
                </button>
              )}
            </span>
          ))}
        </nav>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Files to upload"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            if (files.length) upload.mutate(files);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={upload.isPending}
          onClick={() => input.current?.click()}
        >
          {upload.isPending ? 'Uploading…' : 'Upload'}
        </Button>
      </div>
      <ErrorText error={upload.error} />
      <ErrorText error={listing.error} />
      {listing.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : listing.data && entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">This folder is empty.</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm" aria-label="Files">
          {entries.map((entry) => {
            const full = joinPath(path, entry.name);
            return (
              <li key={entry.name} className="flex items-center gap-3 px-3 py-2">
                {entry.type === 'dir' ? (
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                    onClick={() => setPath(full)}
                  >
                    {entry.name}/
                  </button>
                ) : (
                  <a
                    href={computerFileUrl(full)}
                    download={entry.name}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {entry.name}
                  </a>
                )}
                <span className="shrink-0 text-muted-foreground">
                  {entry.type === 'dir' ? '' : formatSize(entry.size)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
