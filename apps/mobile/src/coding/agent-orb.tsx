import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, View } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop, Ellipse } from 'react-native-svg';
import { Label, row } from '../components/ui';

/** Native counterpart to Bento's inline thinking orb. Motion is decorative. */
export function AgentOrb({ label, tool }: { label: string; tool?: string }) {
  const phase = useRef(new Animated.Value(0)).current;
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
  const searching = /read|grep|glob|search|fetch|ls|find/i.test(tool ?? '');
  useEffect(() => {
    if (reduced) {
      phase.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(phase, {
        toValue: 1,
        duration: searching ? 2200 : 3600,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [phase, reduced, searching]);
  return (
    <View style={row.base} accessibilityLiveRegion="polite" accessibilityLabel={label}>
      <Animated.View
        accessible={false}
        style={{
          transform: [
            { rotate: phase.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
            {
              scale: phase.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.9, 1.08, 0.9] }),
            },
          ],
        }}
      >
        <Svg width={28} height={28} viewBox="0 0 32 32">
          <Defs>
            <RadialGradient id="orb" cx="35%" cy="25%" r="75%">
              <Stop offset="0" stopColor="#d5f2ff" />
              <Stop offset="0.45" stopColor="#72acbd" />
              <Stop offset="1" stopColor="#304b68" />
            </RadialGradient>
          </Defs>
          <Circle cx={16} cy={16} r={13} fill="url(#orb)" />
          <Ellipse
            cx={16}
            cy={16}
            rx={7}
            ry={12}
            rotation={35}
            origin="16,16"
            fill="none"
            stroke="#e0f7ff"
            strokeOpacity={0.65}
            strokeWidth={1}
          />
          <Ellipse
            cx={16}
            cy={16}
            rx={12}
            ry={5}
            rotation={-25}
            origin="16,16"
            fill="none"
            stroke="#e0f7ff"
            strokeOpacity={0.45}
            strokeWidth={1}
          />
        </Svg>
      </Animated.View>
      <Label muted size={14}>
        {label}
      </Label>
    </View>
  );
}
