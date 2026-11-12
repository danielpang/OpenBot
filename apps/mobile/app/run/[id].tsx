import { RunActivityScreen } from '../../src/screens/run-activity';
import { ConnectionGate } from '../../src/components/connection-gate';
export default function Screen() {
  return (
    <ConnectionGate>
      <RunActivityScreen />
    </ConnectionGate>
  );
}
