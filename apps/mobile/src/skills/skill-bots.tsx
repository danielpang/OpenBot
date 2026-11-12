import { ActivityIndicator, Switch, View } from 'react-native';
import { unwrap } from '@openbots/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { botsQueryOptions } from '../api/bots';
import { useApi } from '../api/provider';
import { Card, ErrorNote, Label, Section, row } from '../components/ui';
import { SKILLS_KEY, skillsQuery, type Skill } from './data';

// A Skill's Bots (S2): which of the owner's Bots have it enabled, the other
// side of Bot details → About → Skills. A new Skill starts enabled for every
// Bot; each switch here saves at once.

export function SkillBots({ skill }: { skill: Skill }) {
  const api = useApi();
  const cache = useQueryClient();
  const bots = useQuery(botsQueryOptions(api));
  const key = skillsQuery(api).queryKey;
  const save = useMutation({
    mutationFn: (botIds: string[]) =>
      unwrap(
        api.PUT('/api/v1/skills/{id}/bots', {
          params: { path: { id: skill.id } },
          body: { botIds },
        }),
      ),
    onMutate: async (botIds) => {
      await cache.cancelQueries({ queryKey: key });
      const previous = cache.getQueryData(key);
      if (previous && bots.data) {
        const usedBy = bots.data.items
          .filter((b) => botIds.includes(b.id))
          .map(({ id, name, handle }) => ({ id, name, handle }));
        cache.setQueryData(key, {
          ...previous,
          items: previous.items.map((s) => (s.id === skill.id ? { ...s, usedBy } : s)),
        });
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) cache.setQueryData(key, context.previous);
    },
    // Also refreshes each Bot's enabled Skills.
    onSettled: () => cache.invalidateQueries({ queryKey: SKILLS_KEY }),
  });

  if (bots.error) return <ErrorNote error={bots.error} />;
  if (!bots.data) return <ActivityIndicator />;
  const items = bots.data.items ?? [];
  if (!items.length) return null;
  const on = new Set(skill.usedBy.map((b) => b.id));

  function toggle(id: string, value: boolean) {
    const next = new Set(on);
    if (value) next.add(id);
    else next.delete(id);
    save.mutate([...next]);
  }

  return (
    <Section title="Bots">
      <Label muted size={13}>
        The Bots that can use this Skill. New Skills start on for every Bot.
      </Label>
      <Card style={{ gap: 4, paddingVertical: 8 }}>
        {items.map((bot) => (
          <View key={bot.id} style={[row.between, { minHeight: 44, paddingVertical: 6 }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <Label weight="600">{bot.name}</Label>
              <Label muted size={13}>
                @{bot.handle}
              </Label>
            </View>
            <Switch
              accessibilityLabel={`Enable for ${bot.name}`}
              value={on.has(bot.id)}
              disabled={save.isPending}
              onValueChange={(value) => toggle(bot.id, value)}
            />
          </View>
        ))}
      </Card>
      <ErrorNote error={save.error} />
    </Section>
  );
}
