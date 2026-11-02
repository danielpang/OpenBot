import { SKILL_CONTENT_MAX, SKILL_NAME_MAX } from '@openbots/shared';
import { Button, Input, Textarea } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  createSkill,
  deleteSkill,
  skillsQuery,
  updateSkill,
  type Skill,
  type SkillOrigin,
} from './api.js';
import { ImportSkillsDialog } from './import-dialog.js';

// The Skills library page (S1 to S3, plan 10.1): every Skill in the account's
// library with the Bots that use it, and an editor for its name and content.
// Bots get a Skill once it is enabled in their Settings.

export const SKILLS_HELP =
  'Instructions your Bots can follow. Enable them per Bot in its Settings, or type / in a chat.';

type Selected = { kind: 'new' } | { kind: 'skill'; id: string } | null;

export function SkillsPage() {
  const { data, error } = useQuery(skillsQuery);
  const [selected, setSelected] = useState<Selected>(null);
  const [importing, setImporting] = useState(false);
  const skills = data?.items ?? [];
  const open = selected?.kind === 'skill' ? skills.find((s) => s.id === selected.id) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{SKILLS_HELP}</p>
      {selected?.kind === 'new' || open ? (
        <SkillEditor
          key={open?.id ?? 'new'}
          skill={open}
          onSaved={(skill) => setSelected({ kind: 'skill', id: skill.id })}
          onClose={() => setSelected(null)}
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setSelected({ kind: 'new' })}>
              New Skill
            </Button>
            <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
              Import from GitHub
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error.message}</p>}
          {data && !skills.length && (
            <p className="text-sm text-muted-foreground">No Skills yet.</p>
          )}
          {skills.length > 0 && (
            <SkillList skills={skills} onOpen={(id) => setSelected({ kind: 'skill', id })} />
          )}
        </>
      )}
      <ImportSkillsDialog
        open={importing}
        onClose={() => setImporting(false)}
        onOpenSkill={(id) => {
          setImporting(false);
          setSelected({ kind: 'skill', id });
        }}
      />
    </div>
  );
}

export function SkillList({
  skills,
  onOpen,
}: {
  skills: readonly Skill[];
  onOpen(id: string): void;
}) {
  return (
    <ul className="divide-y rounded-md border" aria-label="Skills">
      {skills.map((skill) => (
        <li key={skill.id}>
          <button
            type="button"
            className="flex w-full flex-col gap-1 px-4 py-3 text-left text-sm hover:bg-accent"
            onClick={() => onOpen(skill.id)}
          >
            <span className="font-medium">{skill.name}</span>
            {skill.summary && <span className="text-muted-foreground">{skill.summary}</span>}
            <span className="text-xs text-muted-foreground">
              {usedByText(skill.usedBy)}
              {skill.origin && `. Imported from ${skill.origin.repo}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "Used by Ada and Scout", or that no Bot has it enabled. */
export function usedByText(bots: readonly { name: string }[]): string {
  if (!bots.length) return 'Not enabled for any Bot';
  const names = bots.map((b) => b.name);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Used by ${list}`;
}

/** The editor (S1): name, content, save, delete. */
export function SkillEditor({
  skill,
  onSaved,
  onClose,
}: {
  /** Absent for a new Skill. */
  skill?: Skill;
  onSaved?(skill: Skill): void;
  onClose(): void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(skill?.name ?? '');
  const [content, setContent] = useState(skill?.content ?? '');
  const [confirming, setConfirming] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['skills'] });

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), content };
      return skill ? updateSkill(skill.id, body) : createSkill(body);
    },
    onSuccess: async (saved) => {
      await invalidate();
      onSaved?.(saved);
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteSkill(skill!.id),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} aria-label="Skill editor">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Back
        </Button>
        {skill && <span className="text-xs text-muted-foreground">{usedByText(skill.usedBy)}</span>}
      </div>
      {skill?.origin && <SkillOriginNote origin={skill.origin} />}
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Name</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={SKILL_NAME_MAX}
          required
          aria-label="Name"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Content</span>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={SKILL_CONTENT_MAX}
          aria-label="Content"
          placeholder="Markdown"
          className="max-h-[70vh] min-h-64 font-mono"
        />
      </label>
      {save.error && (
        <p role="alert" className="text-sm text-destructive">
          {save.error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!name.trim() || save.isPending}>
          {skill ? 'Save' : 'Create'}
        </Button>
        {skill && (
          <Button
            type="button"
            variant={confirming ? 'destructive' : 'ghost'}
            className="ml-auto"
            disabled={remove.isPending}
            onClick={() => (confirming ? remove.mutate() : setConfirming(true))}
          >
            {confirming ? 'Delete for every Bot' : 'Delete'}
          </Button>
        )}
      </div>
      {remove.error && <p className="text-sm text-destructive">{remove.error.message}</p>}
    </form>
  );
}

/** Where an imported Skill came from (S3). */
export function SkillOriginNote({ origin }: { origin: SkillOrigin }) {
  return (
    <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      Imported from{' '}
      <a
        href={origin.permalink}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-foreground underline-offset-4 hover:underline"
      >
        {origin.repo}/{origin.path}
      </a>{' '}
      at {origin.ref} ({origin.sha.slice(0, 7)}).
      {origin.license && ` License: ${origin.license}.`} Read it before you enable it.
    </p>
  );
}
