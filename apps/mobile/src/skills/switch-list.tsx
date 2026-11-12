import { Switch, View } from 'react-native';
import { Card, Label, row } from '../components/ui';

// A card of rows that each save at once with a switch: a Bot's Skills
// (bot-skills.tsx) and a Skill's Bots (skill-bots.tsx).

export interface SwitchItem {
  id: string;
  title: string;
  detail?: string | null;
  /** The switch's accessible name. */
  label: string;
}

export function SwitchList({
  items,
  on,
  disabled,
  onChange,
}: {
  items: readonly SwitchItem[];
  on: ReadonlySet<string>;
  disabled?: boolean;
  /** The ids that are on after the change. */
  onChange(ids: string[]): void;
}) {
  function toggle(id: string, value: boolean) {
    const next = new Set(on);
    if (value) next.add(id);
    else next.delete(id);
    onChange([...next]);
  }
  return (
    <Card style={{ gap: 4, paddingVertical: 8 }}>
      {items.map((item) => (
        <View key={item.id} style={[row.between, { minHeight: 52, paddingVertical: 6 }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <Label weight="600">{item.title}</Label>
            {item.detail ? (
              <Label muted size={13} style={{ maxHeight: 38 }}>
                {item.detail}
              </Label>
            ) : null}
          </View>
          <Switch
            accessibilityLabel={item.label}
            value={on.has(item.id)}
            disabled={disabled}
            onValueChange={(value) => toggle(item.id, value)}
          />
        </View>
      ))}
    </Card>
  );
}
