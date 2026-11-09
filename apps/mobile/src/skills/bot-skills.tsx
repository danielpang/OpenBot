import { ActivityIndicator, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { unwrap } from '@openbots/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api/provider';
import { Button, Card, ErrorNote, Label, row } from '../components/ui';
import { SKILLS_KEY, botSkillsQuery, skillsQuery } from './data';

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
  const on = new Set(enabled.data.skillIds);

  function toggle(id: string, value: boolean) {
    const next = new Set(on);
    if (value) next.add(id);
    else next.delete(id);
    save.mutate([...next]);
  }

  return (
    <>
      {skills.length ? (
        <Card style={{ gap: 4, paddingVertical: 8 }}>
          {skills.map((skill) => (
            <View key={skill.id} style={[row.between, { minHeight: 52, paddingVertical: 6 }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Label weight="600">{skill.name}</Label>
                {skill.summary ? (
                  <Label muted size={13} style={{ maxHeight: 38 }}>
                    {skill.summary}
                  </Label>
                ) : null}
              </View>
              <Switch
                accessibilityLabel={`Enable ${skill.name}`}
                value={on.has(skill.id)}
                disabled={save.isPending}
                onValueChange={(value) => toggle(skill.id, value)}
              />
            </View>
          ))}
        </Card>
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
