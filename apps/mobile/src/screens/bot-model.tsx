import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@openbots/api-client';
import { defaultReasoning, modelSupports } from '@openbots/shared';
import { useApi, useMobile } from '../api/provider';
import { botsQueryOptions } from '../api/bots';
import { Button, ErrorNote, Icon, Label, Section, row } from '../components/ui';
import { useTheme } from '../theme';
import type { Bot } from './data';

/** Choose among the server's configured models compatible with this Bot. */
export function BotModel({ bot }: { bot: Bot }) {
  const api = useApi();
  const { connected } = useMobile();
  const cache = useQueryClient();
  const c = useTheme();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inFlight = useRef(false);
  const models = useQuery({
    queryKey: ['models', 'tools', bot.id],
    enabled: open && connected,
    queryFn: () =>
      unwrap(api.GET('/api/v1/models', { params: { query: { needs: 'tools', botId: bot.id } } })),
  });
  const groups = (models.data?.groups ?? [])
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => model.enabled && modelSupports(model, ['tools'])),
    }))
    .filter((group) => group.models.length > 0);

  async function choose(
    group: (typeof groups)[number],
    model: (typeof groups)[number]['models'][number],
  ) {
    if (inFlight.current || !connected) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      // Preserve settings changed elsewhere, but reset thinking for the new model.
      const fresh = await unwrap(
        api.GET('/api/v1/bots/{id}', { params: { path: { id: bot.id } } }),
      );
      const modelConfig = {
        ...fresh.modelConfig,
        provider_id: group.provider.id,
        model_id: model.modelId,
      };
      delete modelConfig.reasoning;
      const reasoning = defaultReasoning(group.provider, model.capabilities);
      if (reasoning !== undefined) modelConfig.reasoning = reasoning;
      const updated = await unwrap(
        api.PATCH('/api/v1/bots/{id}', {
          params: { path: { id: bot.id } },
          body: { modelConfig },
        }),
      );
      const { queryKey } = botsQueryOptions(api);
      await cache.cancelQueries({ queryKey });
      cache.setQueryData(
        queryKey,
        (current) =>
          current && {
            ...current,
            items: current.items.map((item) =>
              item.id === updated.id ? { ...item, modelConfig: updated.modelConfig } : item,
            ),
          },
      );
      void cache.invalidateQueries({ queryKey });
      setOpen(false);
    } catch (cause) {
      setError(cause);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Label>{bot.modelConfig?.model_id ?? 'No model selected'}</Label>
      {!open ? (
        <Button
          title="Change model"
          variant="secondary"
          onPress={() => {
            setError(null);
            setOpen(true);
          }}
        />
      ) : (
        <>
          {!connected ? <Label muted>Reconnect to change the model.</Label> : null}
          {models.isFetching && !models.data ? <Label muted>Loading models…</Label> : null}
          <ErrorNote error={models.error} onRetry={() => void models.refetch()} />
          {models.data && !models.error && groups.length === 0 ? (
            <Label muted>
              No compatible models available. Configure a provider on your computer.
            </Label>
          ) : null}
          {groups.map((group) => (
            <Section key={group.provider.id} title={group.provider.name}>
              {group.models.map((model) => {
                const selected =
                  bot.modelConfig?.provider_id === group.provider.id &&
                  bot.modelConfig.model_id === model.modelId;
                const disabled = saving || !connected;
                return (
                  <Pressable
                    key={model.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${model.displayName} from ${group.provider.name}`}
                    accessibilityState={{ selected, disabled, busy: saving }}
                    disabled={disabled}
                    onPress={() => void choose(group, model)}
                    style={[
                      row.base,
                      {
                        minHeight: 52,
                        padding: 14,
                        borderRadius: 12,
                        backgroundColor: c.muted,
                        opacity: disabled ? 0.5 : 1,
                      },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Label weight="600">{model.displayName}</Label>
                      <Label muted size={12}>
                        {model.capabilities.context_window
                          ? `${Math.round(model.capabilities.context_window / 1000)}k context`
                          : 'Context window unknown'}
                      </Label>
                    </View>
                    {selected ? <Icon name="checkmark" size={20} /> : null}
                  </Pressable>
                );
              })}
            </Section>
          ))}
          {saving ? <Label muted>Saving model…</Label> : null}
          <ErrorNote error={error} />
          <Button title="Cancel" variant="ghost" disabled={saving} onPress={() => setOpen(false)} />
        </>
      )}
    </View>
  );
}
