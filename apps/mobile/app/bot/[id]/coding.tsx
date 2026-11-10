import { useLocalSearchParams } from 'expo-router';
import { ConnectionGate } from '../../../src/components/connection-gate';
import { CodingSessionsScreen } from '../../../src/coding/screens';
export default function Screen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ConnectionGate>
      <CodingSessionsScreen botId={id} />
    </ConnectionGate>
  );
}
