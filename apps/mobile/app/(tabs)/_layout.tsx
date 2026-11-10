import { ActivityIndicator } from 'react-native';
import { Redirect, Slot, useSegments, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTabletLayout } from '../../src/components/adaptive-layout';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useMobile } from '../../src/api/provider';
import { Button, Page } from '../../src/components/ui';
import { useTheme } from '../../src/theme';
import { useInbox } from '../../src/screens/inbox-data';
export default function TabsLayout() {
  const c = useTheme();
  const wide = useTabletLayout();
  const mobile = useMobile();
  const segments = useSegments();
  const inbox = useInbox();
  if (!mobile.ready)
    return (
      <Page>
        <ActivityIndicator />
      </Page>
    );
  if (!mobile.host) return <Redirect href="/(onboarding)/welcome" />;
  if (!mobile.client && segments.at(-1) !== 'settings')
    return (
      <Page>
        <ActivityIndicator />
        <Button
          title="Manage servers"
          variant="secondary"
          onPress={() => router.replace('/(tabs)/settings')}
        />
      </Page>
    );
  if (wide)
    return (
      <SafeAreaView
        edges={['top', 'bottom', 'right']}
        style={{ flex: 1, backgroundColor: c.background }}
      >
        <Slot />
      </SafeAreaView>
    );
  return (
    // UIKit owns the material, safe-area insets and accessibility adaptations.
    // No opaque bar background: iOS 26 gets Liquid Glass, iOS 17–18 its native bar.
    <NativeTabs tintColor={c.foreground} minimizeBehavior="never" disableTransparentOnScrollEdge>
      <NativeTabs.Trigger name="bots" contentStyle={{ backgroundColor: c.background }}>
        <NativeTabs.Trigger.Label>OpenBots</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'bubble.left.and.bubble.right',
            selected: 'bubble.left.and.bubble.right.fill',
          }}
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="inbox" contentStyle={{ backgroundColor: c.background }}>
        <NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'tray', selected: 'tray.fill' }} />
        {inbox.count > 0 ? (
          <NativeTabs.Trigger.Badge>{String(inbox.count)}</NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="coding" contentStyle={{ backgroundColor: c.background }}>
        <NativeTabs.Trigger.Label>Code</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="chevron.left.forwardslash.chevron.right" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" contentStyle={{ backgroundColor: c.background }}>
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
