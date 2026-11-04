import { memo, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { applyMessageDelta, MessagePartSchema } from '@openbots/shared';
import { Button, Label, row } from '../components/ui';
import { useTheme } from '../theme';
import { MessagePartView } from '../transcript/parts';
import { spikeMessages, spikeReplay } from '../transcript/spike-fixture';
import type { Message } from '../transcript/model';

export function TranscriptSpikeScreen() {
  const c = useTheme();
  const [messages, setMessages] = useState(spikeMessages);
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const played = useRef(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const delta = spikeReplay[played.current];
      if (!delta) {
        setRunning(false);
        return;
      }
      setMessages((current) => {
        const last = current[current.length - 1]!;
        const next = applyMessageDelta(
          last.parts.map((part) => MessagePartSchema.parse(part)),
          last.deltaSeq,
          delta,
        );
        return [
          ...current.slice(0, -1),
          {
            ...last,
            ...next,
            status: delta.deltaSeq === spikeReplay.length ? 'complete' : 'streaming',
          },
        ];
      });
      played.current++;
      setCount(played.current);
    }, 45);
    return () => clearInterval(timer);
  }, [running]);
  if (!__DEV__) return <Redirect href="/" />;
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen options={{ title: 'Transcript spike' }} />
      <View style={{ padding: 16, gap: 10, borderBottomWidth: 1, borderColor: c.border }}>
        <Label weight="600">
          500 messages · {count}/{spikeReplay.length} deltas
        </Label>
        <Label muted size={12}>
          Synthetic replay. Profile native scrolling with Instruments on a physical iPhone 12; this
          screen does not measure frame rate.
        </Label>
        <View style={row.base}>
          <Button
            title={
              running
                ? 'Pause replay'
                : count === spikeReplay.length
                  ? 'Replay complete'
                  : 'Start replay'
            }
            disabled={count === spikeReplay.length}
            onPress={() => setRunning((value) => !value)}
          />
          <Button
            title="Reset replay"
            variant="secondary"
            onPress={() => {
              setRunning(false);
              played.current = 0;
              setCount(0);
              setMessages(spikeMessages());
            }}
          />
        </View>
      </View>
      <FlashList
        data={messages}
        keyExtractor={(message) => message.id}
        getItemType={(message) => message.authorType}
        renderItem={({ item }) => <FixtureMessage message={item} />}
        maintainVisibleContentPosition={{
          startRenderingFromBottom: true,
          autoscrollToBottomThreshold: 0.2,
        }}
      />
    </View>
  );
}
const FixtureMessage = memo(function FixtureMessage({ message }: { message: Message }) {
  return (
    <View style={{ paddingHorizontal: 20, paddingVertical: 14, gap: 8 }}>
      <Label size={12} weight="600" muted>
        {message.authorType === 'user' ? 'You' : 'Fixture Bot'} · #{message.seq}
      </Label>
      {message.parts.map((part, index) => (
        <MessagePartView key={index} part={part} message={message} index={index} />
      ))}
    </View>
  );
});
