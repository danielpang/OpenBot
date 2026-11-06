import { View } from 'react-native';
import { BotsScreen } from '../../src/screens/bots';
import { Empty } from '../../src/components/ui';
import { useTabletLayout } from '../../src/components/adaptive-layout';

export default function BotsRoute() {
  const wide = useTabletLayout();
  return wide ? (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Empty
        title="Choose a conversation"
        detail="Choose a Bot or group in the sidebar to open a conversation, or create a new one with +."
      />
    </View>
  ) : (
    <BotsScreen />
  );
}
