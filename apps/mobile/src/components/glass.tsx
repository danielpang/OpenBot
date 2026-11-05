import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ViewProps,
} from 'react-native';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useTheme } from '../theme';
import { Icon } from './ui';

// Start opaque until accessibility preferences resolve. Native bars manage their
// own accessibility appearance; this policy is only for our custom surfaces.
const GlassEnabled = createContext(false);

export function GlassProvider({ children }: PropsWithChildren) {
  const [reduceTransparency, setReduceTransparency] = useState(true);
  const [increaseContrast, setIncreaseContrast] = useState(true);
  const available =
    Platform.OS === 'ios' && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

  useEffect(() => {
    if (!available) return;
    let active = true;
    let transparencyChanged = false;
    let contrastChanged = false;
    const transparency = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      (value) => {
        transparencyChanged = true;
        setReduceTransparency(value);
      },
    );
    const contrast = AccessibilityInfo.addEventListener('darkerSystemColorsChanged', (value) => {
      contrastChanged = true;
      setIncreaseContrast(value);
    });
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => {
        if (active && !transparencyChanged) setReduceTransparency(value);
      })
      .catch(() => {});
    void AccessibilityInfo.isDarkerSystemColorsEnabled()
      .then((value) => {
        if (active && !contrastChanged) setIncreaseContrast(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      transparency.remove();
      contrast.remove();
    };
  }, [available]);

  return (
    <GlassEnabled.Provider value={available && !reduceTransparency && !increaseContrast}>
      {children}
    </GlassEnabled.Provider>
  );
}

/** Navigation/control material only — never use this for message or content cards. */
export function GlassSurface({
  children,
  style,
  radius = 28,
  ...props
}: ViewProps & { radius?: number }) {
  const c = useTheme();
  const enabled = useContext(GlassEnabled);
  return (
    <View {...props} style={[style, { borderRadius: radius }]}>
      {/* Keep the content tree stable so a preference change never remounts a
          focused TextInput. The material cannot intercept touches or VoiceOver. */}
      {enabled ? (
        <GlassView
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          glassEffectStyle="regular"
          style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
        />
      ) : (
        <View
          pointerEvents="none"
          accessible={false}
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: radius,
              backgroundColor: c.card,
              borderColor: c.border,
              borderWidth: StyleSheet.hairlineWidth,
            },
          ]}
        />
      )}
      {children}
    </View>
  );
}

export function GlassIconButton({
  icon,
  label,
  onPress,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <GlassSurface radius={24} style={styles.iconButton}>
        <Icon name={icon} size={22} />
      </GlassSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  iconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
});
