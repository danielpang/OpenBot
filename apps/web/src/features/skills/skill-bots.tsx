import { useQuery, useQueryClient } from '@tanstack/react-query';
import { botsQuery } from '../bots/queries.js';
import { putSkillBots, type Skill } from './api.js';
import { ChecklistForm } from './checklist-form.js';

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
  if (!bots.length) return null;
  return (
    <section className="flex flex-col gap-3 text-sm" aria-label="Bots">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">Bots</span>
        <span className="text-xs text-muted-foreground">
          The Bots that can use this Skill. New Skills start on for every Bot.
        </span>
      </div>
      <ChecklistForm
        items={bots.map((b) => ({ id: b.id, title: b.name, detail: `@${b.handle}` }))}
        enabled={enabled}
        label="Bots with this Skill"
        saveLabel="Save Bots"
        onSave={async (ids) => {
          await putSkillBots(skillId, ids);
          // Refreshes the library's "used by" and each Bot's enabled Skills.
          await queryClient.invalidateQueries({ queryKey: ['skills'] });
        }}
      />
    </section>
  );
}
