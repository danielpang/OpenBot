import { useState } from 'react';
import { View, Pressable, Switch } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@openbots/api-client';
import { acceptsEdits, withAcceptEdits, ACCEPT_EDITS_HELP } from '@openbots/shared';
import { useApi } from '../api/provider';
import { useBots } from '../screens/data';
import { ErrorNote, Icon, Label, row } from './ui';
import { useTheme } from '../theme';
import { GlassSurface } from './glass';

export function AcceptEdits({
  botId,
  compact = false,
  composer = false,
}: {
  botId: string;
  compact?: boolean;
  composer?: boolean;
}) {
  const c = useTheme();
  const api = useApi();
  const cache = useQueryClient();
  const bots = useBots();
  const bot = bots.data?.find((item) => item.id === botId);
  const [open, setOpen] = useState(!compact && !composer);
  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const fresh = await unwrap(api.GET('/api/v1/bots/{id}', { params: { path: { id: botId } } }));
      return unwrap(
        api.PATCH('/api/v1/bots/{id}', {
          params: { path: { id: botId } },
          body: { toolPolicy: withAcceptEdits(fresh.toolPolicy, enabled) },
        }),
      );
    },
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ['bots'] });
    },
  });
  if (!bot) return null;
  const enabled = acceptsEdits(bot.toolPolicy);
  if (composer) {
    return (
      <View testID="code-edit-mode" style={{ gap: 8 }}>
        {open && (
          <GlassSurface
            radius={24}
            accessibilityLabel="File edit approvals"
            onAccessibilityEscape={() => setOpen(false)}
            style={{ alignSelf: 'flex-start', width: 280, maxWidth: '100%', padding: 6 }}
          >
            {(
              [
                { value: false, label: 'Ask before edits', icon: 'hand-left-outline' },
                { value: true, label: 'Accept edits', icon: 'create-outline' },
              ] as const
            ).map((option) => (
              <Pressable
                key={option.label}
                accessibilityRole="button"
                accessibilityLabel={option.label}
                accessibilityState={{
                  selected: enabled === option.value,
                  disabled: save.isPending,
                }}
                disabled={save.isPending}
                onPress={() => {
                  setOpen(false);
                  save.mutate(option.value);
                }}
                style={({ pressed }) => [
                  row.base,
                  {
                    minHeight: 52,
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderRadius: 18,
                    backgroundColor: pressed ? c.muted : 'transparent',
                  },
                ]}
              >
                <Icon name={option.icon} size={22} />
                <Label size={16} style={{ flex: 1 }}>
                  {option.label}
                </Label>
                {enabled === option.value && <Icon name="checkmark" size={18} />}
              </Pressable>
            ))}
          </GlassSurface>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit mode: ${enabled ? 'Accept edits' : 'Ask before edits'}`}
          accessibilityHint="Choose how file edits are approved"
          accessibilityState={{ disabled: save.isPending, busy: save.isPending, expanded: open }}
          disabled={save.isPending}
          onPress={() => setOpen(!open)}
          style={({ pressed }) => [
            row.base,
            {
              alignSelf: 'flex-start',
              minHeight: 44,
              paddingHorizontal: 12,
              gap: 6,
              borderRadius: 22,
              backgroundColor: c.muted,
              opacity: save.isPending ? 0.5 : pressed ? 0.7 : 1,
            },
          ]}
        >
          <Icon name={enabled ? 'create-outline' : 'hand-left-outline'} size={15} />
          <Label size={13} weight="500">
            {enabled ? 'Accept edits' : 'Ask before edits'}
          </Label>
          <Icon name="chevron-expand" size={14} />
        </Pressable>
        <ErrorNote error={save.error} />
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      {compact && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit approval settings"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={[row.base, { minHeight: 44 }]}
        >
          <Label muted size={13}>
            Accept edits: {enabled ? 'On' : 'Off'}
          </Label>
          <Icon size={16} name="chevron-expand" />
        </Pressable>
      )}
      {open && (
        <>
          <View style={row.between}>
            <Label weight="600">Accept edits</Label>
            <Switch
              accessibilityLabel="Accept edits"
              value={enabled}
              disabled={save.isPending}
              onValueChange={(value) => save.mutate(value)}
            />
          </View>
          <Label muted size={12}>
            {ACCEPT_EDITS_HELP}
          </Label>
        </>
      )}
      <ErrorNote error={save.error} />
    </View>
  );
}
