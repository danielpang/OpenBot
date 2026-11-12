import { SKILL_CONTENT_MAX, SKILL_NAME_MAX } from '@openbots/shared';
import {
  Button,
  IconButton,
  Input,
  PlusIcon,
  SaveButton,
  Textarea,
  TrashIcon,
  useSaveState,
} from '@openbots/ui';
import type { SVGProps } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  availabilityText,
  createSkill,
  deleteSkill,
  skillsQuery,
  updateSkill,
  type Skill,
  type SkillOrigin,
} from './api.js';
import { botsQuery } from '../bots/queries.js';
import { ImportSkillsDialog } from './import-dialog.js';
import { SkillBots } from './skill-bots.js';

// The Skills library page (S1 to S3, plan 10.1): every Skill in the account's
// library with the Bots that use it, an editor for its name and content, and
// the Bots it is turned off for. Every Skill is on for all of the owner's
// Bots unless its page turns it off for one.

export const SKILLS_HELP =
  'Instructions your Bots can follow. Every Skill is on for all your Bots; open one to turn it off for a Bot. Type / in a chat to use one.';

type Selected = { kind: 'new' } | { kind: 'skill'; id: string } | null;

export function SkillsPage() {
  const { data, error } = useQuery(skillsQuery);
  const bots = useQuery(botsQuery);
  const [selected, setSelected] = useState<Selected>(null);
  const [importing, setImporting] = useState(false);
  const skills = data?.items ?? [];
  const open = selected?.kind === 'skill' ? skills.find((s) => s.id === selected.id) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">{SKILLS_HELP}</p>
        {!(selected?.kind === 'new' || open) && (
          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton label="Import from GitHub" onClick={() => setImporting(true)}>
              <DownloadIcon />
            </IconButton>
            <IconButton label="New Skill" onClick={() => setSelected({ kind: 'new' })}>
              <PlusIcon />
            </IconButton>
          </div>
        )}
      </div>
      {selected?.kind === 'new' || open ? (
        <>
          <SkillEditor
            key={open?.id ?? 'new'}
            skill={open}
            onSaved={(skill) => setSelected({ kind: 'skill', id: skill.id })}
            onClose={() => setSelected(null)}
          />
          {open && <SkillBots skill={open} />}
        </>
      ) : (
        <>
          {error && <p className="text-sm text-destructive">{error.message}</p>}
          {data && !skills.length && (
            <p className="text-sm text-muted-foreground">No Skills yet.</p>
          )}
          {skills.length > 0 && (
            <SkillList
              skills={skills}
              bots={bots.data?.items}
              onOpen={(id) => setSelected({ kind: 'skill', id })}
            />
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
  bots,
  onOpen,
}: {
  skills: readonly Skill[];
  /** The owner's Bots, once loaded, to say which ones each Skill is on for. */
  bots?: readonly { id: string; name: string }[];
  onOpen(id: string): void;
}) {
  return (
    <ul className="divide-y overflow-hidden rounded-lg border bg-card" aria-label="Skills">
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
              {[
                bots && availabilityText(skill.blockedBotIds, bots),
                skill.origin && `Imported from ${skill.origin.repo}`,
              ]
                .filter(Boolean)
                .join('. ')}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
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
  const saveState = useSaveState(save);
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
        <IconButton label="Back" onClick={onClose}>
          <BackIcon />
        </IconButton>
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
        <SaveButton
          type="submit"
          state={saveState.state}
          savedLabel={skill ? 'Saved' : 'Created'}
          disabled={!name.trim()}
        >
          {skill ? 'Save' : 'Create'}
        </SaveButton>
        {skill &&
          (confirming ? (
            <div className="ml-auto flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Delete for every Bot
              </Button>
            </div>
          ) : (
            <IconButton label="Delete" className="ml-auto" onClick={() => setConfirming(true)}>
              <TrashIcon />
            </IconButton>
          ))}
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
      {origin.license && ` License: ${origin.license}.`} It is on for every Bot: read it, and turn
      it off below for any Bot that should not use it.
    </p>
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

function DownloadIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </Glyph>
  );
}

function BackIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="m15 18-6-6 6-6" />
    </Glyph>
  );
}
