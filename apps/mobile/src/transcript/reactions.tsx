import { Pressable, View } from 'react-native';
import { Icon, Label, row } from '../components/ui';
import { useTheme } from '../theme';
import type { Message } from './model';

/** The picker's choices, in the order they are offered. */
export const REACTION_EMOJI = ['👍', '👎', '❤️', '💯', '👌'] as const;

/**
 * A message's footer: its reactions, a button that opens the picker in place, and the
 * thread reply. The picker is a row in the message, not a system alert.
 */
export function MessageReactions({
  message,
  alignEnd,
  picking,
  onPicking,
  onReaction,
  onThread,
}: {
  message: Pick<Message, 'reactions' | 'replyCount'>;
  alignEnd: boolean;
  picking: boolean;
  onPicking: (open: boolean) => void;
  onReaction: (emoji: string) => void;
  onThread?: () => void;
}) {
  const c = useTheme();
  const reactions = message.reactions ?? [];
  const mine = new Set(
    reactions.filter((reaction) => reaction.reactorType === 'user').map(({ emoji }) => emoji),
  );
  const counts = new Map<string, number>();
  for (const { emoji } of reactions) counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  const justify = alignEnd ? 'flex-end' : 'flex-start';
  return (
    <View style={{ marginTop: 8, gap: 8 }}>
      <View
        style={[
          row.base,
          { flexWrap: 'wrap', justifyContent: justify, position: 'relative', zIndex: 10 },
        ]}
      >
        {picking ? (
          <View
            testID="reaction-picker"
            // Opens upward over the message, as a panel, so nothing below moves
            // and the close button never slips behind the composer.
            style={[
              row.base,
              {
                position: 'absolute',
                bottom: '100%',
                marginBottom: 6,
                ...(alignEnd ? { right: 0 } : { left: 0 }),
                zIndex: 10,
                elevation: 8,
                gap: 4,
                padding: 6,
                borderRadius: 26,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.card,
                shadowColor: '#000',
                shadowOpacity: 0.3,
                shadowRadius: 12,
                shadowOffset: { width: 0, height: 4 },
              },
            ]}
          >
            {REACTION_EMOJI.map((emoji) => (
              <Pressable
                key={emoji}
                accessibilityRole="button"
                accessibilityLabel={`${mine.has(emoji) ? 'Remove' : 'React with'} ${emoji}`}
                accessibilityState={{ selected: mine.has(emoji) }}
                onPress={() => {
                  onPicking(false);
                  onReaction(emoji);
                }}
                style={({ pressed }) => ({
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 1,
                  borderColor: mine.has(emoji) ? c.foreground : 'transparent',
                  backgroundColor: pressed || mine.has(emoji) ? c.muted : 'transparent',
                })}
              >
                <Label size={20}>{emoji}</Label>
              </Pressable>
            ))}
          </View>
        ) : null}
        {[...counts].map(([emoji, count]) => (
          <Pressable
            key={emoji}
            accessibilityRole="button"
            accessibilityLabel={`${mine.has(emoji) ? 'Remove' : 'React'} ${emoji}, ${count} ${
              count === 1 ? 'reaction' : 'reactions'
            }`}
            accessibilityState={{ selected: mine.has(emoji) }}
            onPress={() => onReaction(emoji)}
            style={{
              borderWidth: 1,
              borderColor: mine.has(emoji) ? c.foreground : c.border,
              backgroundColor: mine.has(emoji) ? c.muted : 'transparent',
              borderRadius: 14,
              paddingHorizontal: 9,
              paddingVertical: 4,
            }}
          >
            <Label size={13}>
              {emoji} {count}
            </Label>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a reaction"
          accessibilityState={{ expanded: picking }}
          onPress={() => onPicking(!picking)}
          hitSlop={8}
          style={[row.base, { padding: 6 }]}
        >
          <Icon name={picking ? 'close' : 'happy-outline'} size={18} color={c.mutedForeground} />
        </Pressable>
        {onThread ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reply in thread"
            onPress={onThread}
            hitSlop={8}
            style={[row.base, { padding: 6, gap: 5 }]}
          >
            <Icon name="chatbubble-outline" size={17} color={c.mutedForeground} />
            {/* Icon only, as React is; a thread with replies still says how many. */}
            {message.replyCount ? (
              <Label size={12} muted>
                {message.replyCount === 1 ? '1 reply' : `${message.replyCount} replies`}
              </Label>
            ) : null}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
