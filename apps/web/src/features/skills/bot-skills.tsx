import { Button } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { botSkillsQuery, putBotSkills, skillsQuery, type Skill } from './api.js';

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
  const [chosen, setChosen] = useState(() => new Set(enabled));
  const changed = chosen.size !== enabled.length || enabled.some((id) => !chosen.has(id));
  const save = useMutation({
    mutationFn: () => putBotSkills(botId, [...chosen]),
    // Also refreshes the library's "used by".
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });

  function toggle(id: string, on: boolean) {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2" aria-label="Enabled Skills">
        {skills.map((skill) => (
          <li key={skill.id}>
            <label className="flex items-start gap-2 text-foreground">
              <input
                type="checkbox"
                className="mt-1"
                checked={chosen.has(skill.id)}
                onChange={(e) => toggle(skill.id, e.target.checked)}
              />
              <span className="flex flex-col">
                <span>{skill.name}</span>
                {skill.summary && (
                  <span className="text-xs text-muted-foreground">{skill.summary}</span>
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
          Save Skills
        </Button>
      </div>
    </div>
  );
}
