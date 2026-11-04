import { ActivityIndicator } from 'react-native';
import type { PropsWithChildren } from 'react';
import { Redirect, router } from 'expo-router';
import { useMobile } from '../api/provider';
import { Button, ErrorNote, Label, Page } from './ui';
export function ConnectionGate({ children }: PropsWithChildren) {
  const mobile = useMobile();
  if (!mobile.ready)
    return (
      <Page>
        <ActivityIndicator />
      </Page>
    );
  if (!mobile.host) return <Redirect href="/(onboarding)/welcome" />;
  if (!mobile.client)
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
  return children;
}
