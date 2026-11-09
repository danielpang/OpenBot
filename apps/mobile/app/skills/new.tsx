import { ConnectionGate } from '../../src/components/connection-gate';
import { SkillEditorScreen } from '../../src/skills/screens';
export default function Screen() {
  return (
    <ConnectionGate>
      <SkillEditorScreen isNew />
    </ConnectionGate>
  );
}
