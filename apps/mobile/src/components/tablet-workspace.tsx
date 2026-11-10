import type { PropsWithChildren } from 'react';
import { Pressable, View } from 'react-native';
import { router, useGlobalSearchParams, usePathname, useSegments } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMobile } from '../api/provider';
import { BotsScreen } from '../screens/bots';
import { useInbox } from '../screens/inbox-data';
import { useTheme } from '../theme';
import { Icon, Label } from './ui';
import { TABLET_SIDEBAR_WIDTH, useTabletLayout } from './adaptive-layout';

/** Keep the navigator mounted when resizing; only the companion pane changes. */
export function TabletWorkspace({ children }: PropsWithChildren) {
  const wide = useTabletLayout();
  const mobile = useMobile();
  const segments = useSegments();
  const workspaceRoute = [
    '(tabs)',
    'bot',
    'chat',
    'artifact',
    'licenses',
    'coding-session',
    'skills',
  ].includes(segments[0] ?? '');
  const sidebar = wide && mobile.ready && !!mobile.host && workspaceRoute;
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      {sidebar ? <TabletSidebar key={mobile.host!.id} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  );
}

function TabletSidebar() {
  const c = useTheme();
  const pathname = usePathname();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const mobile = useMobile();
  const inbox = useInbox();
  const selected = pathname.startsWith('/bot/')
    ? { kind: 'bot' as const, id }
    : pathname.startsWith('/chat/')
      ? { kind: 'chat' as const, id }
      : undefined;
  return (
    <SafeAreaView
      testID="tablet-sidebar"
      edges={['top', 'bottom', 'left']}
      style={{
        width: TABLET_SIDEBAR_WIDTH,
        backgroundColor: c.background,
        borderRightWidth: 1,
        borderRightColor: c.border,
      }}
    >
      <View style={{ padding: 12, gap: 4 }}>
        {(
          [
            ['bots', 'Bots', 'chatbubbles-outline'],
            ['inbox', 'Inbox', 'file-tray-outline'],
            ['coding', 'Code', 'code-slash-outline'],
            ['settings', 'Settings', 'settings-outline'],
          ] as const
        ).map(([route, label, icon]) => {
          const active =
            route === 'bots' ? pathname === '/bots' || !!selected : pathname === `/${route}`;
          return (
            <Pressable
              key={route}
              accessibilityRole="button"
              accessibilityLabel={
                route === 'inbox' && inbox.count ? `Inbox, ${inbox.count} pending` : label
              }
              accessibilityState={{ selected: active }}
              onPress={() => router.replace(`/(tabs)/${route}`)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                minHeight: 48,
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: 12,
                backgroundColor: active ? c.accent : pressed ? c.muted : 'transparent',
              })}
            >
              <Icon name={icon} size={21} />
              <Label weight={active ? '600' : '400'} style={{ flex: 1 }}>
                {label}
              </Label>
              {route === 'inbox' && inbox.count > 0 ? (
                <Label size={13} weight="600">
                  {inbox.count}
                </Label>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {/* Match the existing connection gate. Do not mount API-bound creation
          controls before there is a client; server management stays reachable. */}
      {mobile.client ? (
        <BotsScreen sidebar selected={selected} />
      ) : (
        <View style={{ padding: 22, gap: 10 }}>
          <Label weight="600">{mobile.host?.name ?? 'OpenBots'}</Label>
          <Label muted>
            {mobile.connecting ? 'Connecting…' : 'Reconnect to browse your Bots.'}
          </Label>
        </View>
      )}
    </SafeAreaView>
  );
}
