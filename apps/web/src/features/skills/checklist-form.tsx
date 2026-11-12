import { Button } from '@openbots/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

// A checkbox list saved with one button: a Bot's Skills (bot-skills.tsx) and
// a Skill's Bots (skill-bots.tsx). Remount it (a `key` of the enabled ids)
// when the saved set changes.

export interface ChecklistItem {
  id: string;
  title: string;
  detail?: string | null;
}

export function ChecklistForm({
  items,
  enabled,
  label,
  saveLabel,
  onSave,
}: {
  items: readonly ChecklistItem[];
  enabled: readonly string[];
  /** The list's accessible name. */
  label: string;
  saveLabel: string;
  onSave(ids: string[]): Promise<unknown>;
}) {
  const [chosen, setChosen] = useState(() => new Set(enabled));
  const changed = chosen.size !== enabled.length || enabled.some((id) => !chosen.has(id));
  const save = useMutation({ mutationFn: () => onSave([...chosen]) });

  function toggle(id: string, on: boolean) {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y rounded-lg border bg-card" aria-label={label}>
        {items.map((item) => (
          <li key={item.id}>
            <label className="flex cursor-pointer items-start gap-3 px-4 py-3 text-foreground">
              <input
                type="checkbox"
                className="mt-1"
                checked={chosen.has(item.id)}
                onChange={(e) => toggle(item.id, e.target.checked)}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{item.title}</span>
                {item.detail && (
                  <span className="text-xs text-muted-foreground">{item.detail}</span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {save.error && <p className="text-destructive">{save.error.message}</p>}
      <div>
        <Button
          type="button"
          size="sm"
          disabled={!changed || save.isPending}
          onClick={() => save.mutate()}
        >
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
