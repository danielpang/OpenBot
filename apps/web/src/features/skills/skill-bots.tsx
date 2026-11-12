import { SaveButton, useSaveState } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { botsQuery } from '../bots/queries.js';
import { putSkillBlocks, type Skill } from './api.js';

// A Skill's "Bots" section on the Skills page (S2): every Skill is on for all
// of the owner's Bots, including ones made later; unticking a Bot here puts
// it on the Skill's blocklist. This is the only place a Skill is turned off
// for a Bot.

export function SkillBots({ skill }: { skill: Skill }) {
  const bots = useQuery(botsQuery);
  if (bots.error) return <p className="text-sm text-destructive">{bots.error.message}</p>;
  if (!bots.data) return null;
  return (
    <SkillBotsForm
      key={[skill.id, ...skill.blockedBotIds].join()}
      skillId={skill.id}
      bots={bots.data.items}
      blocked={skill.blockedBotIds}
    />
  );
}

export function SkillBotsForm({
  skillId,
  bots,
  blocked,
}: {
  skillId: string;
  bots: readonly { id: string; name: string; handle: string }[];
  /** The Bots the Skill is turned off for. */
  blocked: readonly string[];
}) {
  const queryClient = useQueryClient();
  const [off, setOff] = useState(() => new Set(blocked));
  const changed = off.size !== blocked.length || blocked.some((id) => !off.has(id));
  const save = useMutation({
    mutationFn: () => putSkillBlocks(skillId, [...off]),
    // Refreshes the library's "used by" and blocklists.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });
  const saved = useSaveState(save);

  function toggle(id: string, on: boolean) {
    const next = new Set(off);
    if (on) next.delete(id);
    else next.add(id);
    setOff(next);
  }

  if (!bots.length) return null;
  return (
    <section className="flex flex-col gap-3 text-sm" aria-label="Bots">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">Bots</span>
        <span className="text-xs text-muted-foreground">
          On for every Bot, including new ones. Untick a Bot to turn this Skill off for it.
        </span>
      </div>
      <ul className="divide-y rounded-lg border bg-card" aria-label="Bots that can use this Skill">
        {bots.map((bot) => (
          <li key={bot.id}>
            <label className="flex cursor-pointer items-start gap-3 px-4 py-3 text-foreground">
              <input
                type="checkbox"
                className="mt-1"
                checked={!off.has(bot.id)}
                onChange={(e) => toggle(bot.id, e.target.checked)}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{bot.name}</span>
                <span className="text-xs text-muted-foreground">@{bot.handle}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {save.error && <p className="text-destructive">{save.error.message}</p>}
      <div>
        <SaveButton
          type="button"
          size="sm"
          state={saved.state}
          disabled={!changed}
          onClick={() => save.mutate()}
        >
          Save Bots
        </SaveButton>
      </div>
    </section>
  );
}
