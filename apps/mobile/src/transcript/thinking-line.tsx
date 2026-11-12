import { THINKING_PHRASE_MS, thinkingPhrase } from '@openbots/shared';
import { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import { OrbGlyph } from '../coding/agent-orb';
import { Label, row } from '../components/ui';

/**
 * A Bot working on a reply with no text yet: the thinking orb and a line of
 * office slang that changes every few seconds. VoiceOver hears one steady
 * "is replying" instead of each phrase.
 */
export function ThinkingLine({ seed, who }: { seed: string; who: string }) {
  const [step, setStep] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const timer = setInterval(() => setStep((s) => s + 1), THINKING_PHRASE_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (step === 0) return;
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 300, useNativeDriver: true }).start();
  }, [fade, step]);
  return (
    <View
      testID="chat-thinking"
      style={row.base}
      accessible
      accessibilityLabel={`${who} is replying`}
    >
      <OrbGlyph size={22} />
      <Animated.View style={{ opacity: fade, flexShrink: 1 }}>
        <Label muted size={14}>
          {thinkingPhrase(seed, step)}
        </Label>
      </Animated.View>
    </View>
  );
}
