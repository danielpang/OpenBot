import { ActivityIndicator } from 'react-native';
import { Redirect, Tabs, useSegments, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMobile } from '../../src/api/provider';
import { Button, ErrorNote, Icon, Label, Page } from '../../src/components/ui';
import { useTheme } from '../../src/theme';
import { useInbox } from '../../src/screens/inbox-data';
export default function TabsLayout() {
  const c = useTheme();
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
        <Label size={26} weight="600">
          {mobile.connecting ? 'Connecting…' : 'You’re offline'}
        </Label>
        <ErrorNote error={mobile.error} />
        {mobile.connecting ? (
          <ActivityIndicator />
        ) : (
          <Button title="Reconnect" onPress={mobile.refresh} />
        )}
        <Button
          title="Manage servers"
          variant="secondary"
          onPress={() => router.replace('/(tabs)/settings')}
        />
      </Page>
    );
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.background }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: c.foreground,
          tabBarInactiveTintColor: c.mutedForeground,
          tabBarStyle: { backgroundColor: c.background, borderTopColor: c.border },
          sceneStyle: { backgroundColor: c.background },
        }}
      >
        <Tabs.Screen
          name="bots"
          options={{
            title: 'Bots',
            tabBarIcon: ({ color, size }) => (
              <Icon name="chatbubbles-outline" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="inbox"
          options={{
            title: 'Inbox',
            tabBarBadge: inbox.count || undefined,
            tabBarIcon: ({ color, size }) => (
              <Icon name="file-tray-outline" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarIcon: ({ color, size }) => (
              <Icon name="settings-outline" color={color} size={size} />
            ),
          }}
        />
      </Tabs>
    </SafeAreaView>
  );
}
