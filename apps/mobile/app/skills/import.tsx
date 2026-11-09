import { ConnectionGate } from '../../src/components/connection-gate';
import { SkillImportScreen } from '../../src/skills/screens';
export default function Screen() {
  return (
    <ConnectionGate>
      <SkillImportScreen />
    </ConnectionGate>
  );
}
