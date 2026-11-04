import { ArtifactScreen } from '../../src/screens/artifact';
import { ConnectionGate } from '../../src/components/connection-gate';
export default function Screen() {
  return (
    <ConnectionGate>
      <ArtifactScreen />
    </ConnectionGate>
  );
}
