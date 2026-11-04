import { Stack } from 'expo-router';
import { FlatList } from 'react-native';
import { Card, Label } from '../src/components/ui';
import notices from '../src/legal/notices.json';
export default function Licenses() {
  return (
    <>
      <Stack.Screen options={{ title: 'License acknowledgements' }} />
      <FlatList
        data={notices}
        keyExtractor={(entry) => `${entry.name}@${entry.version}`}
        contentContainerStyle={{ padding: 22, gap: 18 }}
        renderItem={({ item }) => (
          <Card>
            <Label weight="600">
              {item.name} {item.version}
            </Label>
            <Label muted>{item.license}</Label>
            <Label size={12} selectable>
              {item.text}
            </Label>
          </Card>
        )}
      />
    </>
  );
}
