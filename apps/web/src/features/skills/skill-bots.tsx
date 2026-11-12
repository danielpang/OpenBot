import { Button } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { botsQuery } from '../bots/queries.js';
import { putSkillBots, type Skill } from './api.js';

// A Skill's "Bots" section on the Skills page (S2): which of the owner's Bots
// have it enabled, the other side of each Bot's Settings > Skills. A new
// Skill starts enabled for every Bot; this is where it is turned off.

export function SkillBots({ skill }: { skill: Skill }) {
  const bots = useQuery(botsQuery);
  if (bots.error) return <p className="text-sm text-destructive">{bots.error.message}</p>;
  if (!bots.data) return null;
  const enabled = skill.usedBy.map((b) => b.id);
  return (
    <SkillBotsForm
      key={[skill.id, ...enabled].join()}
      skillId={skill.id}
      bots={bots.data.items}
      enabled={enabled}
    />
  );
}

export function SkillBotsForm({
  skillId,
  bots,
  enabled,
}: {
  skillId: string;
  bots: readonly { id: string; name: string; handle: string }[];
  enabled: readonly string[];
}) {
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState(() => new Set(enabled));
  const changed = chosen.size !== enabled.length || enabled.some((id) => !chosen.has(id));
  const save = useMutation({
    mutationFn: () => putSkillBots(skillId, [...chosen]),
    // Refreshes the library's "used by" and each Bot's enabled Skills.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });

  function toggle(id: string, on: boolean) {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  }

  if (!bots.length) return null;
  return (
    <section className="flex flex-col gap-3 text-sm" aria-label="Bots">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">Bots</span>
        <span className="text-xs text-muted-foreground">
          The Bots that can use this Skill. New Skills start on for every Bot.
        </span>
      </div>
      <ul className="divide-y rounded-lg border bg-card" aria-label="Bots with this Skill">
        {bots.map((bot) => (
          <li key={bot.id}>
            <label className="flex cursor-pointer items-center gap-3 px-4 py-3 text-foreground">
              <input
                type="checkbox"
                checked={chosen.has(bot.id)}
                onChange={(e) => toggle(bot.id, e.target.checked)}
              />
              <span className="font-medium">{bot.name}</span>
              <span className="text-xs text-muted-foreground">@{bot.handle}</span>
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
          Save Bots
        </Button>
      </div>
    </section>
  );
}
