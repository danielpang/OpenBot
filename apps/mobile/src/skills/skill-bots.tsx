import { ActivityIndicator, Switch, View } from 'react-native';
import { unwrap } from '@openbots/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { botsQueryOptions } from '../api/bots';
import { useApi } from '../api/provider';
import { Card, ErrorNote, Label, Section, row } from '../components/ui';
import { SKILLS_KEY, skillsQuery, type Skill } from './data';

// A Skill's Bots (S2): every Skill is on for all of the owner's Bots,
// including ones made later; switching a Bot off puts it on the Skill's
// blocklist. This is the only place a Skill is turned off for a Bot. Each
// switch saves at once.

export function SkillBots({ skill }: { skill: Skill }) {
  const api = useApi();
  const cache = useQueryClient();
  const bots = useQuery(botsQueryOptions(api));
  const key = skillsQuery(api).queryKey;
  const save = useMutation({
    mutationFn: (botIds: string[]) =>
      unwrap(
        api.PUT('/api/v1/skills/{id}/blocked-bots', {
          params: { path: { id: skill.id } },
          body: { botIds },
        }),
      ),
    onMutate: async (blockedBotIds) => {
      await cache.cancelQueries({ queryKey: key });
      const previous = cache.getQueryData(key);
      if (previous) {
        cache.setQueryData(key, {
          ...previous,
          items: previous.items.map((s) => (s.id === skill.id ? { ...s, blockedBotIds } : s)),
        });
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) cache.setQueryData(key, context.previous);
    },
    onSettled: () => cache.invalidateQueries({ queryKey: SKILLS_KEY }),
  });

  if (bots.error) return <ErrorNote error={bots.error} />;
  if (!bots.data) return <ActivityIndicator />;
  const items = bots.data.items ?? [];
  if (!items.length) return null;
  const off = new Set(skill.blockedBotIds);

  function toggle(id: string, on: boolean) {
    const next = new Set(off);
    if (on) next.delete(id);
    else next.add(id);
    save.mutate([...next]);
  }

  return (
    <Section title="Bots">
      <Label muted size={13}>
        On for every Bot, including new ones. Switch a Bot off to turn this Skill off for it.
      </Label>
      <Card style={{ gap: 4, paddingVertical: 8 }}>
        {items.map((bot) => (
          <View key={bot.id} style={[row.between, { minHeight: 52, paddingVertical: 6 }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <Label weight="600">{bot.name}</Label>
              <Label muted size={13}>
                @{bot.handle}
              </Label>
            </View>
            <Switch
              accessibilityLabel={`Use for ${bot.name}`}
              value={!off.has(bot.id)}
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
