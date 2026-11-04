import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@openbots/api-client';
import {
  AVATAR_ACCESSORIES,
  AVATAR_EYES,
  AVATAR_PALETTES,
  BOT_SHAPES,
  generate,
  newBotAvatar,
  resolveParts,
  shuffle,
  type GeneratedAvatar,
} from '@openbots/avatars';
import { useApi, useMobile } from '../api/provider';
import { botsQueryOptions } from '../api/bots';
import { BotAvatar } from '../components/bot-avatar';
import { Button, Card, ErrorNote, Label, Section } from '../components/ui';
import { useTheme } from '../theme';
import type { Bot } from './data';

/** A local draft: no server or roster changes until Save succeeds. */
export function BotAppearance({
  bot,
  bots,
  onClose,
}: {
  bot: Bot;
  bots: Bot[];
  onClose: () => void;
}) {
  const api = useApi();
  const { connected } = useMobile();
  const cache = useQueryClient();
  const c = useTheme();
  const [draft, setDraft] = useState(bot.avatar);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inFlight = useRef(false);
  const generated = draft.kind === 'generated' ? draft : null;
  const parts = generated ? resolveParts(generated) : null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(bot.avatar);
  const taken = bots.flatMap((other) =>
    other.id !== bot.id && other.avatar.kind === 'generated' ? [other.avatar] : [],
  );

  function change(next: Bot['avatar']) {
    setDraft(next);
    setError(null);
  }
  async function save() {
    if (inFlight.current || !dirty || !connected) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const updated = await unwrap(
        api.PATCH('/api/v1/bots/{id}', {
          params: { path: { id: bot.id } },
          body: { avatar: draft },
        }),
      );
      const { queryKey } = botsQueryOptions(api);
      await cache.cancelQueries({ queryKey });
      cache.setQueryData(queryKey, (current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.id === updated.id ? { ...item, avatar: updated.avatar } : item,
              ),
            }
          : current,
      );
      void cache.invalidateQueries({ queryKey });
      onClose();
    } catch (cause) {
      setError(cause);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function choices<K extends 'shape' | 'palette' | 'eyes' | 'accessory'>(
    title: string,
    part: K,
    options: readonly { value: NonNullable<GeneratedAvatar[K]>; label: string }[],
  ) {
    if (!generated || !parts) return null;
    return (
      <Section title={title}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {options.map(({ value, label }) => {
            const selected = parts[part] === value;
            return (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityLabel={`${title}: ${label}`}
                accessibilityState={{ selected, disabled: saving }}
                disabled={saving}
                onPress={() => change({ ...generated, [part]: value })}
                style={({ pressed }) => ({
                  minWidth: 64,
                  minHeight: 72,
                  padding: 8,
                  gap: 4,
                  alignItems: 'center',
                  borderRadius: 12,
                  borderWidth: 2,
                  borderColor: selected ? c.primary : 'transparent',
                  backgroundColor: c.muted,
                  opacity: pressed || saving ? 0.6 : 1,
                })}
              >
                <SvgXml
                  xml={generate({ ...generated, [part]: value }).svg}
                  width={40}
                  height={40}
                />
                <Label size={12} weight={selected ? '600' : '400'}>
                  {label}
                </Label>
              </Pressable>
            );
          })}
        </View>
      </Section>
    );
  }
  const named = <T extends string>(values: readonly T[]) =>
    values.map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));

  return (
    <Card>
      <Label size={21} weight="600">
        Edit appearance
      </Label>
      <View style={{ alignItems: 'center', gap: 12 }}>
        <BotAvatar bot={{ ...bot, avatar: draft }} size={104} />
        <Label muted size={13}>
          Preview · changes are saved only when you tap Save.
        </Label>
      </View>
      {generated ? (
        <>
          <Button
            title="Shuffle avatar"
            variant="secondary"
            icon="shuffle-outline"
            disabled={saving}
            onPress={() =>
              change(
                shuffle(generated.seed, taken, generated.shape ? { shape: generated.shape } : {}),
              )
            }
          />
          {choices(
            'Shape',
            'shape',
            BOT_SHAPES.map(({ shape, label }) => ({ value: shape, label })),
          )}
          {choices('Colors', 'palette', named(AVATAR_PALETTES))}
          {choices('Eyes', 'eyes', named(AVATAR_EYES))}
          {choices('Accessory', 'accessory', named(AVATAR_ACCESSORIES))}
        </>
      ) : (
        <>
          <Label muted size={14}>
            This Bot uses an uploaded image. Switch to a generated avatar to choose its shape and
            colors.
          </Label>
          <Button
            title="Use a generated avatar"
            variant="secondary"
            disabled={saving}
            onPress={() => change(newBotAvatar(bot.id, taken))}
          />
        </>
      )}
      <ErrorNote error={error} />
      {!connected ? (
        <Label muted size={13}>
          Reconnecting… You can keep editing and save when connected.
        </Label>
      ) : null}
      <Button
        title="Save appearance"
        loading={saving}
        disabled={!dirty || !connected}
        onPress={() => void save()}
      />
      <Button title="Cancel" variant="ghost" disabled={saving} onPress={onClose} />
    </Card>
  );
}
