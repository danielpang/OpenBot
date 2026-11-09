import { ConnectionGate } from '../../src/components/connection-gate';
import { SkillsScreen } from '../../src/skills/screens';
export default function Screen() {
  return (
    <ConnectionGate>
      <SkillsScreen />
    </ConnectionGate>
  );
}
