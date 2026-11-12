import { ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { unwrap } from '@openbots/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api/provider';
import { Button, ErrorNote, Label } from '../components/ui';
import { SKILLS_KEY, botSkillsQuery, skillsQuery } from './data';
import { SwitchList } from './switch-list';

// Bot details → About → Skills (S2): which Skills from the library this Bot
// may use. Each switch saves at once; enabled Skills go in the Bot's index.

export function BotSkills({ botId }: { botId: string }) {
  const api = useApi();
  const cache = useQueryClient();
  const library = useQuery(skillsQuery(api));
  const enabled = useQuery(botSkillsQuery(api, botId));
  const key = botSkillsQuery(api, botId).queryKey;
  const save = useMutation({
    mutationFn: (skillIds: string[]) =>
      unwrap(
        api.PUT('/api/v1/bots/{id}/skills', {
          params: { path: { id: botId } },
          body: { skillIds },
        }),
      ),
    onMutate: async (skillIds) => {
      await cache.cancelQueries({ queryKey: key });
      const previous = cache.getQueryData(key);
      cache.setQueryData(key, { skillIds });
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) cache.setQueryData(key, context.previous);
    },
    // Also refreshes the library's "used by".
    onSettled: () => cache.invalidateQueries({ queryKey: SKILLS_KEY }),
  });

  const error = library.error ?? enabled.error;
  if (error) return <ErrorNote error={error} />;
  if (!library.data || !enabled.data) return <ActivityIndicator />;
  const skills = library.data.items;

  return (
    <>
      {skills.length ? (
        <SwitchList
          items={skills.map((skill) => ({
            id: skill.id,
            title: skill.name,
            detail: skill.summary,
            label: `Enable ${skill.name}`,
          }))}
          on={new Set(enabled.data.skillIds)}
          disabled={save.isPending}
          onChange={(ids) => save.mutate(ids)}
        />
      ) : (
        <Label muted size={14}>
          No Skills in your library yet. Write or import one, or ask a Bot to save finished work as
          a Skill.
        </Label>
      )}
      <ErrorNote error={save.error} />
      <Button
        title={skills.length ? 'Manage Skills' : 'Add a Skill'}
        icon={skills.length ? 'sparkles-outline' : 'add'}
        variant="secondary"
        onPress={() => router.push('/skills')}
      />
    </>
  );
}
