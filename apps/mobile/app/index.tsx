import { ActivityIndicator, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useMobile } from '../src/api/provider';
import { useTheme } from '../src/theme';
export default function Index() {
  const mobile = useMobile();
  const c = useTheme();
  if (!mobile.ready)
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: c.background,
        }}
      >
        <ActivityIndicator />
      </View>
    );
  return <Redirect href={mobile.host ? '/(tabs)/bots' : '/(onboarding)/welcome'} />;
}
