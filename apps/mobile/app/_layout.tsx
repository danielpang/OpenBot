import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MobileProvider } from '../src/api/provider';
import { AppearanceProvider, useTheme, useThemeScheme } from '../src/theme';
import { ServerCompatibility } from '../src/components/server-compatibility';
import { GlassProvider } from '../src/components/glass';

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
  return (
    <>
      <ServerCompatibility />
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
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
        <Stack.Screen name="(onboarding)/pair" options={{ title: 'Pair your phone' }} />
        <Stack.Screen name="(onboarding)/connect" options={{ title: 'Connect' }} />
      </Stack>
    </>
  );
}
