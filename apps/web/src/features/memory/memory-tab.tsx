import { unwrap, type components } from '@openbots/api-client';
import { Button, SaveButton, useSaveState } from '@openbots/ui';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../app/api.js';

// The Bot's Memory tab (M2): what the Bot has kept, by kind, with the
// reminder that memory can be stale (M3). The owner adds memories of any
// kind, edits a memory's text and kind, and deletes it.

type Memory = components['schemas']['Memory'];
type MemoryKind = components['schemas']['MemoryKind'];

const KINDS: { kind: MemoryKind; title: string; label: string }[] = [
  { kind: 'preference', title: 'Preferences', label: 'Preference' },
  { kind: 'fact', title: 'Facts', label: 'Fact' },
  { kind: 'summary', title: 'Summaries of past work', label: 'Summary of past work' },
];

/** Characters in one memory, as the API takes them. */
const MAX_CONTENT = 1_000;

export const memoriesQuery = (botId: string) =>
  queryOptions({
    queryKey: ['memories', botId],
    queryFn: () =>
      unwrap(api.GET('/api/v1/bots/{id}/memories', { params: { path: { id: botId } } })),
  });

/** Memories by kind in display order, each group newest first as the API returns them. */
export function groupMemories(items: readonly Memory[]) {
  return KINDS.map(({ kind, title }) => ({
    kind,
    title,
    items: items.filter((memory) => memory.kind === kind),
  })).filter((group) => group.items.length > 0);
}

export function MemoryTab({ botId }: { botId: string }) {
  const { data } = useQuery(memoriesQuery(botId));
  const groups = groupMemories(data?.items ?? []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <p className="text-sm text-muted-foreground">
        Memory can be stale, so the Bot double-checks before big decisions.
      </p>
      <AddMemory botId={botId} />
      {data && !groups.length && (
        <p className="text-sm text-muted-foreground">Nothing remembered yet.</p>
      )}
      {groups.map((group) => (
        <section key={group.kind} className="flex flex-col gap-2">
          <h2 className="font-medium">{group.title}</h2>
          <ul className="divide-y rounded-md border">
            {group.items.map((memory) => (
              <MemoryRow key={memory.id} botId={botId} memory={memory} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function KindSelect({ defaultValue, label }: { defaultValue: MemoryKind; label: string }) {
  return (
    <select
      name="kind"
      aria-label={label}
      defaultValue={defaultValue}
      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
    >
      {KINDS.map(({ kind, label }) => (
        <option key={kind} value={kind}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** What a memory form holds: its kind and trimmed text. */
function readForm(form: HTMLFormElement): { kind: MemoryKind; content: string } {
  const data = new FormData(form);
  return {
    kind: String(data.get('kind')) as MemoryKind,
    content: String(data.get('content')).trim(),
  };
}

function AddMemory({ botId }: { botId: string }) {
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: (body: { kind: MemoryKind; content: string }) =>
      unwrap(api.POST('/api/v1/bots/{id}/memories', { params: { path: { id: botId } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoriesQuery(botId).queryKey }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = readForm(form);
    if (!body.content) return;
    add.mutate(body, { onSuccess: () => form.reset() });
  }

  return (
    <form aria-label="Add memory" className="flex flex-col gap-2" onSubmit={submit}>
      <textarea
        name="content"
        aria-label="New memory"
        placeholder="Something the Bot should keep in mind"
        rows={2}
        maxLength={MAX_CONTENT}
        className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
      />
      {add.error && <p className="text-sm text-destructive">{add.error.message}</p>}
      <div className="flex justify-end gap-2">
        <KindSelect defaultValue="fact" label="Kind of new memory" />
        <Button type="submit" size="sm" disabled={add.isPending}>
          Add memory
        </Button>
      </div>
    </form>
  );
}

function MemoryRow({ botId, memory }: { botId: string; memory: Memory }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const path = { params: { path: { id: botId, memoryId: memory.id } } };
  const onSuccess = () =>
    queryClient.invalidateQueries({ queryKey: memoriesQuery(botId).queryKey });
  const save = useMutation({
    mutationFn: (body: { kind?: MemoryKind; content?: string }) =>
      unwrap(api.PATCH('/api/v1/bots/{id}/memories/{memoryId}', { ...path, body })),
    onSuccess: async () => {
      await onSuccess();
      saved.afterCheck(() => setEditing(false));
    },
  });
  const saved = useSaveState(save);
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/bots/{id}/memories/{memoryId}', path)),
    onSuccess,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { kind, content } = readForm(event.currentTarget);
    if (!content) return;
    // Send only what changed; a new text is embedded again, a new kind is not.
    const body = {
      ...(kind !== memory.kind ? { kind } : {}),
      ...(content !== memory.content ? { content } : {}),
    };
    if (Object.keys(body).length) save.mutate(body);
    else setEditing(false);
  }

  if (editing) {
    return (
      <li className="px-3 py-2">
        <form className="flex flex-col gap-2" onSubmit={submit}>
          <textarea
            name="content"
            defaultValue={memory.content}
            aria-label="Memory"
            rows={3}
            maxLength={MAX_CONTENT}
            autoFocus
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          />
          {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
          <div className="flex justify-end gap-2">
            <KindSelect defaultValue={memory.kind} label="Kind" />
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <SaveButton type="submit" size="sm" state={saved.state}>
              Save
            </SaveButton>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex items-start justify-between gap-4 px-3 py-2 text-sm">
      <p className="whitespace-pre-wrap">{memory.content}</p>
      <div className="flex shrink-0 gap-1">
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          Delete
        </Button>
      </div>
    </li>
  );
}
