import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, View } from 'react-native';
import { BotAvatar } from '../components/bot-avatar';
import { useTheme } from '../theme';
import type { Bot } from '../screens/data';

// One loop is two beats: a hop leaning left, then a hop leaning right.
const LOOP_MS = 1100;
const BEATS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

/** The Bot dancing in place while its conversation loads. Motion is decorative. */
export function DancingBotAvatar({ bot, size = 72 }: { bot: Bot; size?: number }) {
  const c = useTheme();
  const phase = useRef(new Animated.Value(0)).current;
  // Still until the setting is known, so Reduce Motion never sees a first hop.
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (reduced) {
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
  const hop = size * 0.22;
  const sway = size * 0.14;
  const beat = (outputRange: number[] | string[]) =>
    phase.interpolate({ inputRange: BEATS, outputRange });
  return (
    <View
      testID="chat-loading-avatar"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Loading your conversation with ${bot.name}`}
      style={{ alignItems: 'center', gap: 10 }}
    >
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
                0,
              ]),
            },
            {
              translateY: beat([
                0,
                -hop * 0.75,
                -hop,
                -hop * 0.75,
                0,
                -hop * 0.75,
                -hop,
                -hop * 0.75,
                0,
              ]),
            },
            {
              rotate: beat([
                '0deg',
                '-8deg',
                '-12deg',
                '-8deg',
                '0deg',
                '8deg',
                '12deg',
                '8deg',
                '0deg',
              ]),
            },
            // Squash on each landing, stretch on the way up.
            { scaleX: beat([1.1, 0.97, 1, 0.97, 1.1, 0.97, 1, 0.97, 1.1]) },
            { scaleY: beat([0.9, 1.04, 1, 1.04, 0.9, 1.04, 1, 1.04, 0.9]) },
          ],
        }}
      >
        <BotAvatar bot={bot} size={size} />
      </Animated.View>
      {/* The shadow stays on the floor and shrinks as the Bot leaves it. */}
      <Animated.View
        accessible={false}
        style={{
          width: size * 0.6,
          height: size * 0.09,
          borderRadius: size,
          backgroundColor: c.mutedForeground,
          opacity: beat([0.3, 0.18, 0.12, 0.18, 0.3, 0.18, 0.12, 0.18, 0.3]),
          transform: [{ scaleX: beat([1, 0.75, 0.6, 0.75, 1, 0.75, 0.6, 0.75, 1]) }],
        }}
      />
      {reduced ? <ActivityIndicator /> : null}
    </View>
  );
}
