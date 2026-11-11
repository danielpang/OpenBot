import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, View } from 'react-native';
import { BotAvatar } from '../components/bot-avatar';
import { useTheme } from '../theme';
import type { Bot } from '../screens/data';

// One loop is two beats: a small bounce leaning left, then one leaning right.
const LOOP_MS = 1100;
const BEATS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
// Each Bot in a group starts a quarter loop after its neighbour, so they bob in turn.
const NEIGHBOUR_OFFSET = 2;
// A bigger group shows its first Bots: one tight row reads better than a crowd.
const MAX_DANCERS = 5;

// Asked once when the app loads, so a loader knows the setting on its first frame
// instead of standing still until the answer arrives.
let reduceMotion: boolean | undefined;
void AccessibilityInfo.isReduceMotionEnabled()
  .then((value) => {
    reduceMotion = value;
  })
  .catch(() => {});

/** The same loop started `beats` eighths later. The last frame repeats the first. */
function shifted<T>(values: T[], beats: number): T[] {
  return BEATS.map((_, index) => values[(index + beats) % (BEATS.length - 1)]!);
}

function avatarSize(count: number) {
  if (count <= 1) return 72;
  if (count === 2) return 60;
  if (count === 3) return 52;
  return 44;
}

/** A conversation's Bots dancing in place while it loads. Motion is decorative. */
export function DancingBots({ bots }: { bots: Bot[] }) {
  const dancers = bots.slice(0, MAX_DANCERS);
  const others = bots.length - dancers.length;
  const phase = useRef(new Animated.Value(0)).current;
  // Unknown only if a chat opens before the app has its answer: still, without a spinner.
  const [reduced, setReduced] = useState(reduceMotion);
  useEffect(() => {
    let mounted = true;
    const update = (value: boolean) => {
      reduceMotion = value;
      if (mounted) setReduced(value);
    };
    void AccessibilityInfo.isReduceMotionEnabled()
      .then(update)
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', update);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (reduced !== false) {
      phase.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(phase, {
        toValue: 1,
        duration: LOOP_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [phase, reduced]);
  const size = avatarSize(dancers.length);
  const names = [...dancers.map((bot) => bot.name), ...(others ? [`${others} more`] : [])];
  return (
    <View
      testID="chat-loading-avatar"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Loading your conversation with ${
        names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
      }`}
      style={{ alignItems: 'center', gap: 12 }}
    >
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'center',
          // Shoulder to shoulder: generated avatars carry their own margin, and the
          // sway is small enough that neighbours don't collide.
          gap: size * 0.05,
        }}
      >
        {dancers.map((bot, index) => (
          <Dancer
            key={bot.id}
            bot={bot}
            size={size}
            phase={phase}
            offset={(index * NEIGHBOUR_OFFSET) % (BEATS.length - 1)}
          />
        ))}
      </View>
      {reduced === true ? <ActivityIndicator /> : null}
    </View>
  );
}

function Dancer({
  bot,
  size,
  phase,
  offset,
}: {
  bot: Bot;
  size: number;
  phase: Animated.Value;
  offset: number;
}) {
  const c = useTheme();
  // A bob, not a jump: the Bot barely leaves the floor.
  const lift = size * 0.07;
  const sway = size * 0.07;
  const beat = <T extends number | string>(values: T[]) =>
    phase.interpolate({ inputRange: BEATS, outputRange: shifted(values, offset) as never });
  return (
    <View testID="chat-loading-dancer" style={{ alignItems: 'center', gap: 6 }}>
      <Animated.View
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        style={{
          transform: [
            {
              translateX: beat([
                0,
                -sway * 0.7,
                -sway,
                -sway * 0.7,
                0,
                sway * 0.7,
                sway,
                sway * 0.7,
              ]),
            },
            {
              translateY: beat([
                0,
                -lift * 0.75,
                -lift,
                -lift * 0.75,
                0,
                -lift * 0.75,
                -lift,
                -lift * 0.75,
              ]),
            },
            { rotate: beat(['0deg', '-5deg', '-7deg', '-5deg', '0deg', '5deg', '7deg', '5deg']) },
            // A slight squash on each landing, a slight stretch on the way up.
            { scaleX: beat([1.04, 0.99, 1, 0.99, 1.04, 0.99, 1, 0.99]) },
            { scaleY: beat([0.96, 1.01, 1, 1.01, 0.96, 1.01, 1, 1.01]) },
          ],
        }}
      >
        <BotAvatar bot={bot} size={size} />
      </Animated.View>
      {/* The shadow stays on the floor and shrinks a little as the Bot lifts. */}
      <Animated.View
        accessible={false}
        style={{
          width: size * 0.6,
          height: size * 0.09,
          borderRadius: size,
          backgroundColor: c.mutedForeground,
          opacity: beat([0.3, 0.25, 0.22, 0.25, 0.3, 0.25, 0.22, 0.25]),
          transform: [{ scaleX: beat([1, 0.9, 0.85, 0.9, 1, 0.9, 0.85, 0.9]) }],
        }}
      />
    </View>
  );
}
