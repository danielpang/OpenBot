import { ChatScreen } from '../../src/screens/conversation';
import { ConnectionGate } from '../../src/components/connection-gate';
export default function Screen() {
  return (
    <ConnectionGate>
      <ChatScreen />
    </ConnectionGate>
  );
}
