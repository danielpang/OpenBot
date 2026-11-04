import { Alert, Platform, Pressable, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { useMobile } from '../api/provider';
import { Button, Card, Icon, Label, Page, Section, row } from '../components/ui';
import { useTheme } from '../theme';
export function SettingsScreen() {
  const mobile = useMobile();
  const c = useTheme();
  const ios = Platform.OS === 'ios';
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
      <Section title="This device">
        <Card>
          <View style={row.base}>
            <Icon name="notifications-outline" />
            <View style={{ flex: 1 }}>
              <Label weight="600">Notifications</Label>
              <Label muted size={13}>
                {ios ? 'Manage alerts in iOS Settings.' : 'Manage alerts in system Settings.'}
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
                {ios
                  ? 'Require Face ID or your device passcode.'
                  : 'Require biometric or your device passcode.'}
              </Label>
            </View>
            <Switch
              accessibilityLabel={ios ? 'Require Face ID' : 'Require biometric or device passcode'}
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
          <Label weight="600">{ios ? 'OpenBots for iOS' : 'OpenBots for Android'}</Label>
          <Label muted>A native companion for your Bots.</Label>
          <Label muted size={13}>
            Your keys stay in this device’s Keychain. Your conversations stay on your server.
            OpenBots collects no telemetry.
          </Label>
        </Card>
        <Label size={13} muted>
          Models, Skills, Connectors, computer control and organization administration are available
          on your computer.
        </Label>
      </Section>
    </Page>
  );
}
