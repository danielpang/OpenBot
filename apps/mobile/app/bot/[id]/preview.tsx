import { PreviewScreen } from '../../../src/screens/preview';
import { ConnectionGate } from '../../../src/components/connection-gate';
export default function Screen() {
  return (
    <ConnectionGate>
      <PreviewScreen />
    </ConnectionGate>
  );
}
