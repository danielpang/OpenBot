import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { botSkillsQuery, putBotSkills, skillsQuery, type Skill } from './api.js';
import { ChecklistForm } from './checklist-form.js';

// The Bot Settings "Skills" section (S2): which Skills from the account's
// library this Bot may use. Enabled Skills go in the Bot's Skills index.

export function BotSkills({ botId }: { botId: string }) {
  const skills = useQuery(skillsQuery);
  const enabled = useQuery(botSkillsQuery(botId));
  const error = skills.error ?? enabled.error;
  if (error) return <p className="text-destructive">{error.message}</p>;
  if (!skills.data || !enabled.data) return <p>Loading…</p>;
  if (!skills.data.items.length) {
    return (
      <p>
        No Skills in your library yet.{' '}
        <Link to="/skills" className="underline">
          Write one on the Skills page
        </Link>
        , or ask a Bot to save finished work as a Skill.
      </p>
    );
  }
  return (
    <BotSkillsForm
      key={[botId, ...enabled.data.skillIds].join()}
      botId={botId}
      skills={skills.data.items}
      enabled={enabled.data.skillIds}
    />
  );
}

export function BotSkillsForm({
  botId,
  skills,
  enabled,
}: {
  botId: string;
  skills: readonly Skill[];
  enabled: readonly string[];
}) {
  const queryClient = useQueryClient();
  return (
    <ChecklistForm
      items={skills.map((s) => ({ id: s.id, title: s.name, detail: s.summary }))}
      enabled={enabled}
      label="Enabled Skills"
      saveLabel="Save Skills"
      onSave={async (ids) => {
        await putBotSkills(botId, ids);
        // Also refreshes the library's "used by".
        await queryClient.invalidateQueries({ queryKey: ['skills'] });
      }}
    />
  );
}
