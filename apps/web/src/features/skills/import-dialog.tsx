import { SKILL_NAME_MAX } from '@openbots/shared';
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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { importSkills, previewSkillImport, type SkillImportPreview } from './api.js';

// Import from GitHub (S3): paste a link to a repository, a folder or a
// SKILL.md; the server lists the Skills it holds, the owner ticks the ones to
// import and may rename them. One imported Skill opens in the editor. Fetching
// happens on the server, which also checks the library's room again.

export const IMPORT_HELP =
  'Link a GitHub repository, folder or SKILL.md file. For a private repository, add the GitHub connector first.';

type Picked = Record<string, { on: boolean; name: string }>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The picks a preview starts with: every importable Skill, as far as the library has room. */
function initialPicks(preview: SkillImportPreview): Picked {
  let room = preview.room;
  return Object.fromEntries(
    preview.skills.map((s) => {
      const on = !s.error && room > 0;
      if (on) room--;
      return [s.path, { on, name: s.suggestedName }];
    }),
  );
}

export function ImportSkillsDialog({
  open,
  onClose,
  onOpenSkill,
}: {
  open: boolean;
  onClose(): void;
  /** Opens an imported Skill in the editor. */
  onOpenSkill(id: string): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {open && <ImportFlow onClose={onClose} onOpenSkill={onOpenSkill} />}
      </DialogContent>
    </Dialog>
  );
}

/** The link, then the Skills found. */
export function ImportFlow({
  onClose,
  onOpenSkill,
}: {
  onClose(): void;
  onOpenSkill(id: string): void;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [picked, setPicked] = useState<Picked>({});

  const find = useMutation({
    mutationFn: () => previewSkillImport(url.trim()),
    onSuccess: (found) => {
      setPreview(found);
      setPicked(initialPicks(found));
    },
  });
  const run = useMutation({
    mutationFn: (found: SkillImportPreview) =>
      importSkills({
        url: found.source.url,
        ref: found.source.ref,
        sha: found.source.sha,
        skills: found.skills
          .filter((s) => picked[s.path]?.on)
          .map((s) => ({ path: s.path, name: picked[s.path]!.name.trim() })),
      }),
    onSuccess: async ({ items }) => {
      await queryClient.invalidateQueries({ queryKey: ['skills'] });
      if (items.length === 1) onOpenSkill(items[0]!.skill.id);
      else onClose();
    },
  });

  if (preview) {
    const chosen = preview.skills.filter((s) => picked[s.path]?.on);
    const over = chosen.length > preview.room;
    const unnamed = chosen.some((s) => !picked[s.path]!.name.trim());
    const set = (path: string, change: Partial<Picked[string]>) =>
      setPicked((current) => ({ ...current, [path]: { ...current[path]!, ...change } }));
    const { source } = preview;
    return (
      <>
        <DialogHeader>
          <DialogTitle>Import from GitHub</DialogTitle>
          <DialogDescription>
            {preview.skills.length
              ? `Found ${plural(preview.skills.length, 'Skill', 'Skills')} in ${source.repo}${source.path ? `/${source.path}` : ''} at ${source.ref}. Pick the ones to import.`
              : `No SKILL.md files found in ${source.repo}${source.path ? `/${source.path}` : ''}. Link a folder that has one, or a markdown file.`}
          </DialogDescription>
        </DialogHeader>
        {preview.skills.length > 0 && (
          <ul className="flex flex-col divide-y rounded-md border" aria-label="Skills found">
            {preview.skills.map((s) => {
              const pick = picked[s.path]!;
              return (
                <li key={s.path} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-2.5"
                    aria-label={`Import ${s.path}`}
                    checked={pick.on}
                    disabled={s.error !== null}
                    onChange={(e) => set(s.path, { on: e.target.checked })}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Input
                      value={pick.name}
                      maxLength={SKILL_NAME_MAX}
                      disabled={s.error !== null}
                      aria-label={`Name for ${s.path}`}
                      onChange={(e) => set(s.path, { name: e.target.value })}
                    />
                    {s.suggestedName !== s.name && (
                      <span className="text-xs text-muted-foreground">
                        Your library already has a Skill named {s.name}.
                      </span>
                    )}
                    {s.description && (
                      <span className="line-clamp-2 text-muted-foreground">{s.description}</span>
                    )}
                    <span className="text-xs break-all text-muted-foreground">{s.path}</span>
                    {s.error && <span className="text-xs text-destructive">{s.error}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {preview.more && (
          <p className="text-xs text-muted-foreground">
            Only the first {preview.skills.length} are listed. Link a folder to see the rest.
          </p>
        )}
        <p className={over ? 'text-sm text-destructive' : 'text-xs text-muted-foreground'}>
          {preview.room > 0
            ? `Your library has room for ${plural(preview.room, 'more Skill', 'more Skills')} (limit ${preview.limit}).`
            : `Your library is at its limit of ${preview.limit} Skills. Delete Skills you no longer need first.`}
          {over && ' Pick fewer to import.'}
        </p>
        {run.error && (
          <p role="alert" className="text-sm text-destructive">
            {run.error.message}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={run.isPending}
            onClick={() => {
              setPreview(null);
              run.reset();
            }}
          >
            Back
          </Button>
          <Button
            disabled={!chosen.length || over || unnamed || run.isPending}
            onClick={() => run.mutate(preview)}
          >
            {run.isPending
              ? 'Importing…'
              : `Import ${chosen.length ? plural(chosen.length, 'Skill', 'Skills') : 'Skills'}`}
          </Button>
        </DialogFooter>
      </>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (url.trim()) find.mutate();
  }

  return (
    <form className="grid gap-4" onSubmit={submit} aria-label="Import from GitHub">
      <DialogHeader>
        <DialogTitle>Import from GitHub</DialogTitle>
        <DialogDescription>{IMPORT_HELP}</DialogDescription>
      </DialogHeader>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">GitHub link</span>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo/tree/main/skills"
          aria-label="GitHub link"
          autoFocus
        />
      </label>
      {find.error && (
        <p role="alert" className="text-sm text-destructive">
          {find.error.message}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!url.trim() || find.isPending}>
          {find.isPending ? 'Looking…' : 'Find Skills'}
        </Button>
      </DialogFooter>
    </form>
  );
}
