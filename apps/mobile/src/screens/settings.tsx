import { Alert, Pressable, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { useMobile } from '../api/provider';
import { Button, Card, Icon, Label, Page, Section, row } from '../components/ui';
import { useAppearance, useTheme } from '../theme';
export function SettingsScreen() {
  const mobile = useMobile();
  const c = useTheme();
  const appearance = useAppearance();
  function remove(id: string, name: string) {
    Alert.alert(
      `Remove ${name}?`,
      'This device will forget its stored credentials for this server.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () =>
            void mobile
              .removeHost(id)
              .catch((error) => Alert.alert('Could not remove host', error.message)),
        },
      ],
    );
  }
  return (
    <Page>
      <Label size={32} weight="700">
        Settings
      </Label>
      <Section title="Your servers">
        {mobile.hosts.map((host) => (
          <Card key={host.id}>
            <View style={row.between}>
              <View style={[row.base, { flex: 1 }]}>
                <Icon
                  name={
                    host.kind === 'paired'
                      ? 'laptop-outline'
                      : host.kind === 'account'
                        ? 'cloud-outline'
                        : 'server-outline'
                  }
                />
                <View style={{ flex: 1 }}>
                  <Label weight="600">{host.name}</Label>
                  <Label muted size={13}>
                    {host.kind === 'paired'
                      ? 'Paired computer'
                      : host.kind === 'account'
                        ? 'OpenBots account'
                        : 'Self-hosted server'}
                  </Label>
                </View>
                {host.id === mobile.host?.id ? (
                  <Icon name="checkmark-circle" color={c.success} />
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${host.name}`}
                onPress={() => remove(host.id, host.name)}
                style={{ padding: 7 }}
              >
                <Icon name="trash-outline" size={19} color={c.mutedForeground} />
              </Pressable>
            </View>
            <Label muted size={12}>
              {host.directUrls[0] ?? host.relayUrl ?? 'Relay connection'}
            </Label>
            {host.id === mobile.host?.id ? (
              <Label size={12} muted>
                {mobile.connected
                  ? `Connected · ${mobile.transport?.kind ?? 'direct'}`
                  : 'Reconnecting…'}
                {host.lastSeenAt
                  ? ` · Last seen ${new Date(host.lastSeenAt).toLocaleDateString()}`
                  : ''}
              </Label>
            ) : (
              <Button
                title="Switch to this server"
                variant="secondary"
                onPress={() =>
                  void mobile
                    .activateHost(host.id)
                    .catch((error) => Alert.alert('Could not connect', error.message))
                }
              />
            )}
          </Card>
        ))}
        <Button
          title="Add a server"
          icon="add"
          variant="secondary"
          onPress={() => router.push('/(onboarding)/welcome')}
        />
      </Section>
      <Section title="Appearance">
        <Card>
          {(
            [
              {
                mode: 'system',
                title: 'System',
                detail: 'Follow your device’s appearance.',
                icon: 'phone-portrait-outline',
              },
              { mode: 'light', title: 'Light', icon: 'sunny-outline' },
              { mode: 'dark', title: 'Dark', icon: 'moon-outline' },
            ] as const
          ).map((option) => (
            <Pressable
              key={option.mode}
              accessibilityRole="radio"
              accessibilityLabel={option.title}
              accessibilityState={{
                checked: appearance.mode === option.mode,
                disabled: !appearance.ready || appearance.saving,
              }}
              disabled={!appearance.ready || appearance.saving}
              onPress={() =>
                void appearance
                  .setMode(option.mode)
                  .catch((error) =>
                    Alert.alert(
                      'Could not save appearance',
                      error instanceof Error ? error.message : String(error),
                    ),
                  )
              }
              style={({ pressed }) => [
                row.base,
                {
                  minHeight: 48,
                  paddingVertical: 8,
                  opacity: pressed || appearance.saving ? 0.6 : 1,
                },
              ]}
            >
              <Icon name={option.icon} />
              <View style={{ flex: 1 }}>
                <Label weight="600">{option.title}</Label>
                {'detail' in option ? (
                  <Label muted size={13}>
                    {option.detail}
                  </Label>
                ) : null}
              </View>
              {appearance.mode === option.mode ? <Icon name="checkmark" /> : null}
            </Pressable>
          ))}
        </Card>
      </Section>
      <Section title="This device">
        <Card>
          <View style={row.base}>
            <Icon name="notifications-outline" />
            <View style={{ flex: 1 }}>
              <Label weight="600">Notifications</Label>
              <Label muted size={13}>
                Manage alerts in iOS Settings.
              </Label>
            </View>
            <Button
              title={mobile.notificationsEnabled ? 'Enabled' : 'Enable'}
              variant="ghost"
              onPress={() =>
                void mobile
                  .enableNotifications()
                  .catch((error) => Alert.alert('Could not enable notifications', error.message))
              }
            />
          </View>
        </Card>
        <Card>
          <View style={row.base}>
            <Icon name="finger-print-outline" />
            <View style={{ flex: 1 }}>
              <Label weight="600">App lock</Label>
              <Label muted size={13}>
                Require Face ID or your device passcode.
              </Label>
            </View>
            <Switch
              accessibilityLabel="Require Face ID"
              value={mobile.lockEnabled}
              onValueChange={(enabled) =>
                void mobile
                  .setLockEnabled(enabled)
                  .catch((error) => Alert.alert('Could not update app lock', error.message))
              }
            />
          </View>
        </Card>
      </Section>
      <Section title="About">
        <Button
          title="License acknowledgements"
          variant="ghost"
          onPress={() => router.push('/licenses')}
        />
        <Card>
          <Label weight="600">OpenBots for iOS</Label>
          <Label muted>A native companion for your Bots.</Label>
          <Label muted size={13}>
            Your keys stay in this device’s Keychain. Your conversations stay on your server.
            OpenBots collects no telemetry.
          </Label>
        </Card>
        <Label size={13} muted>
          Model provider setup, Skills, Connectors, computer control and organization
          administration are available on your computer. Change a Bot’s model in Bot details →
          About.
        </Label>
      </Section>
    </Page>
  );
}
