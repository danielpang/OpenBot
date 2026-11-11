import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MobileProvider } from '../src/api/provider';
import { AppearanceProvider, useTheme, useThemeScheme } from '../src/theme';
import { ServerCompatibility } from '../src/components/server-compatibility';
import { GlassProvider } from '../src/components/glass';
import { useConversationHeader } from '../src/components/conversation-header';
import { TabletWorkspace } from '../src/components/tablet-workspace';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppearanceProvider>
        <GlassProvider>
          <MobileProvider>
            <Navigator />
          </MobileProvider>
        </GlassProvider>
      </AppearanceProvider>
    </SafeAreaProvider>
  );
}
function Navigator() {
  const c = useTheme();
  const scheme = useThemeScheme();
  const conversationHeader = useConversationHeader();
  return (
    <>
      <ServerCompatibility />
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <TabletWorkspace>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: c.background },
            headerTintColor: c.foreground,
            contentStyle: { backgroundColor: c.background },
            headerShadowVisible: false,
            headerBackButtonDisplayMode: 'minimal',
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="(onboarding)/welcome" options={{ title: 'Welcome' }} />
          <Stack.Screen name="(onboarding)/pair" options={{ title: 'Pair your device' }} />
          <Stack.Screen name="(onboarding)/connect" options={{ title: 'Connect' }} />
          {/* A conversation's transparent header has to be in place before its screen
              first appears. Set from inside the screen it arrives after the push has
              begun: the content starts below an opaque header, then moves up under it. */}
          <Stack.Screen name="bot/[id]/index" options={conversationHeader} />
          <Stack.Screen name="chat/[id]" options={conversationHeader} />
        </Stack>
      </TabletWorkspace>
    </>
  );
}
