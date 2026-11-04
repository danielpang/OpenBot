import { BotDetailsScreen } from '../../../src/screens/bot-details';
import { ConnectionGate } from '../../../src/components/connection-gate';
export default function Screen() {
  return (
    <ConnectionGate>
      <BotDetailsScreen />
    </ConnectionGate>
  );
}
