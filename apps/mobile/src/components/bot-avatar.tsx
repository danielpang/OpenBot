import { memo, useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { Image } from 'expo-image';
import { SvgXml } from 'react-native-svg';
import { generate } from '@openbots/avatars';
import type { components } from '@openbots/api-client';
import { useTheme } from '../theme';
import { useFileSource } from '../api/use-file-source';

type Bot = components['schemas']['Bot'];
export const BotAvatar = memo(function BotAvatar({
  bot,
  size = 54,
  status = true,
}: {
  bot: Pick<Bot, 'avatar' | 'state' | 'name'>;
  size?: number;
  /** The working-state dot. Off where the avatar is decoration, as in a loader. */
  status?: boolean;
}) {
  const c = useTheme();
  const source = useFileSource(bot.avatar.kind === 'upload' ? bot.avatar.file_id : undefined);
  const pulse = useRef(new Animated.Value(1)).current;
  const active = status && ['working', 'thinking'].includes(bot.state.state);
  useEffect(() => {
    if (!active) {
      pulse.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.65, duration: 950, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 950, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [active, pulse]);
  return (
    <View
      accessibilityLabel={status ? `${bot.name}, ${bot.state.state}` : bot.name}
      style={{ width: size, height: size }}
    >
      {bot.avatar.kind === 'generated' ? (
        <SvgXml xml={generate(bot.avatar).svg} width={size} height={size} />
      ) : (
        <Image source={source} style={{ width: size, height: size, borderRadius: size / 3 }} />
      )}
      {status ? (
        <Animated.View
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 11,
            height: 11,
            borderRadius: 6,
            borderWidth: 2,
            borderColor: c.background,
            backgroundColor: active
              ? c.success
              : bot.state.state === 'waiting'
                ? '#d89c36'
                : c.mutedForeground,
            opacity: pulse,
          }}
        />
      ) : null}
    </View>
  );
});
