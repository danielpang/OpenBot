import { CODING_ROUTINE_TEMPLATES, type CodingRoutineTemplate } from '@openbots/shared';
import { Button, cn, Input } from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { reposQuery } from '../coders/api.js';
import { routineTemplatesQuery } from '../repos/api.js';
import { useRoutineActions, type CreateRoutine } from './api.js';

// Coding Routine templates (CA11, F6): New Routine offers "Start from a
// template" above the manual form. Picking one asks for the repository (from
// the remembered list) and the label when its trigger waits for one, then
// sends only the template's id and those params. The server is the authority
// on the template: it fills the name, prompt and trigger, and the form shows
// the name it chose.

const selectClass = 'h-9 rounded-md border bg-transparent px-2 text-sm';

/** The longest label the server takes. */
export const LABEL_MAX = 100;

export interface TemplateParams {
  repo: string;
  label?: string;
}

/** Whether the template's trigger waits for a label the owner can change. */
export const needsLabel = (template: CodingRoutineTemplate) =>
  template.trigger.type === 'event' && template.trigger.label !== undefined;

/** The create body for a template: its id and params, nothing the server fills itself. */
export function routineFromTemplate(
  template: CodingRoutineTemplate,
  params: TemplateParams,
): CreateRoutine {
  return {
    template: {
      id: template.id as NonNullable<CreateRoutine['template']>['id'],
      params: {
        repo: params.repo,
        ...(needsLabel(template) && params.label ? { label: params.label } : {}),
      },
    },
  };
}

/** The templates from the server, or the built-in ones when it has none to say. */
function useTemplates() {
  const templates = useQuery(routineTemplatesQuery);
  return templates.data ?? (templates.error ? CODING_ROUTINE_TEMPLATES : undefined);
}

export function TemplateChooser({ onPick }: { onPick(template: CodingRoutineTemplate): void }) {
  const templates = useTemplates();
  if (!templates?.length) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="routine-templates-title">
      <h3 id="routine-templates-title" className="text-sm font-medium">
        Start from a template
      </h3>
      <ul className="grid gap-2 sm:grid-cols-3">
        {templates.map((template) => (
          <li key={template.id}>
            <button
              type="button"
              data-template={template.id}
              onClick={() => onPick(template)}
              className="flex h-full w-full flex-col gap-1 rounded-md border p-3 text-left text-sm hover:bg-muted"
            >
              <span className="font-medium">{template.name}</span>
              <span className="text-xs text-muted-foreground">{template.description}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">Or write your own below.</p>
    </section>
  );
}

export function TemplateRoutineForm({
  botId,
  template,
  onBack,
  onDone,
}: {
  botId: string;
  template: CodingRoutineTemplate;
  onBack(): void;
  /** Called with the name the server gave the new Routine. */
  onDone(name: string): void;
}) {
  const actions = useRoutineActions(botId);
  const repos = useQuery(reposQuery);
  const list = repos.data?.repos ?? [];
  const [repo, setRepo] = useState('');
  const [label, setLabel] = useState(
    template.trigger.type === 'event' ? (template.trigger.label ?? '') : '',
  );
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = repo || list[0]?.fullName || '';
  const withLabel = needsLabel(template);

  function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (!chosen) return setProblem('Pick a repository.');
    if (withLabel && !label.trim()) return setProblem('Name the label to wait for.');
    const body = routineFromTemplate(template, {
      repo: chosen,
      ...(withLabel ? { label: label.trim() } : {}),
    });
    actions.create.mutate(body, { onSuccess: (routine) => onDone(routine.name) });
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      onSubmit={submit}
      aria-label="New Routine from a template"
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{template.name}</span>
        <span className="text-xs text-muted-foreground">{template.description}</span>
      </div>
      {repos.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repositories yet. Add one on the{' '}
          <a href="/computer" className="underline">
            Computer page
          </a>{' '}
          first.
        </p>
      ) : (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Repository
          <select
            aria-label="Repository"
            value={chosen}
            onChange={(e) => setRepo(e.target.value)}
            className={cn(selectClass, 'w-72')}
          >
            {list.map((r) => (
              <option key={r.id} value={r.fullName}>
                {r.fullName}
              </option>
            ))}
          </select>
        </label>
      )}
      {withLabel && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Label
          <Input
            aria-label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-56"
            maxLength={LABEL_MAX}
          />
          <span>The Bot starts when an issue gets this label.</span>
        </label>
      )}
      {(problem ?? actions.create.error) && (
        <p className="text-sm text-destructive">{problem ?? actions.create.error?.message}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Choose another
        </Button>
        <Button type="submit" size="sm" disabled={actions.create.isPending || !chosen}>
          Create Routine
        </Button>
      </div>
    </form>
  );
}
