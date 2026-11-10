import { useLocalSearchParams } from 'expo-router';
import { ConnectionGate } from '../../../src/components/connection-gate';
import { CodingSessionDetailsScreen } from '../../../src/coding/session-details';
import { useMobile } from '../../../src/api/provider';

export default function Screen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { host } = useMobile();
  return (
    <ConnectionGate>
      <CodingSessionDetailsScreen key={`${host?.id}:${id}`} id={id} />
    </ConnectionGate>
  );
}
