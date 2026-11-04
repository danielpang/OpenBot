import type { PropsWithChildren, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
  type StyleProp,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme';

export function Label({
  children,
  muted = false,
  size = 16,
  weight = '400',
  selectable,
  style,
}: PropsWithChildren<{
  muted?: boolean;
  size?: number;
  weight?: '400' | '500' | '600' | '700' | '800';
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
}>) {
  const c = useTheme();
  return (
    <Text
      selectable={selectable}
      style={[
        {
          color: muted ? c.mutedForeground : c.foreground,
          fontSize: size,
          fontWeight: weight,
          lineHeight: size * 1.4,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
export function Icon({
  name,
  size = 22,
  color,
}: {
  name: React.ComponentProps<typeof Ionicons>['name'];
  size?: number;
  color?: string;
}) {
  const c = useTheme();
  return <Ionicons name={name} size={size} color={color ?? c.foreground} />;
}
export function Button({
  title,
  onPress,
  disabled,
  loading = false,
  variant = 'primary',
  icon,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  accessibilityLabel?: string;
}) {
  const c = useTheme();
  const color =
    variant === 'primary' ? c.primaryForeground : variant === 'danger' ? c.danger : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled || loading, busy: loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          minHeight: 48,
          borderRadius: 14,
          paddingHorizontal: 16,
          paddingVertical: 12,
          flexDirection: 'row',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor:
            variant === 'primary' ? c.primary : variant === 'ghost' ? 'transparent' : c.muted,
          opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={color} />
      ) : icon ? (
        <Icon name={icon} color={color} size={20} />
      ) : null}
      <Text style={{ color, fontSize: 16, fontWeight: '600' }}>{title}</Text>
    </Pressable>
  );
}
export function Field(props: TextInputProps) {
  const c = useTheme();
  return (
    <TextInput
      placeholderTextColor={c.mutedForeground}
      {...props}
      style={[
        {
          color: c.foreground,
          backgroundColor: c.muted,
          borderRadius: 13,
          minHeight: 50,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 16,
        },
        props.style,
      ]}
    />
  );
}
export function Card({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const c = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 18,
          padding: 18,
          gap: 12,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
export function Section({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <View style={{ gap: 12 }}>
      <Label size={13} weight="600" muted style={{ letterSpacing: 1, textTransform: 'uppercase' }}>
        {title}
      </Label>
      {children}
    </View>
  );
}
export function Page({
  children,
  scroll = true,
  style,
}: PropsWithChildren<{ scroll?: boolean; style?: StyleProp<ViewStyle> }>) {
  const c = useTheme();
  return scroll ? (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[{ padding: 22, gap: 28, paddingBottom: 48 }, style]}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1, backgroundColor: c.background }, style]}>{children}</View>
  );
}
export function Empty({
  icon = 'chatbubble-ellipses-outline',
  title,
  detail,
  action,
}: {
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  const c = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 52, paddingHorizontal: 26, gap: 14 }}>
      <View style={{ backgroundColor: c.muted, padding: 18, borderRadius: 24 }}>
        <Icon name={icon} size={32} />
      </View>
      <Label size={21} weight="600">
        {title}
      </Label>
      <Label muted style={{ textAlign: 'center' }}>
        {detail}
      </Label>
      {action}
    </View>
  );
}
export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <Card>
      <Label>{error instanceof Error ? error.message : String(error)}</Label>
      {onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} /> : null}
    </Card>
  );
}
export const row = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
});
