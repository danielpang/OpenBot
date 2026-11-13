import { useEffect, useMemo, useRef } from 'react';
import { Modal, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassIconButton } from '../components/glass';
import type { Bot } from '../screens/data';
import { useThemeScheme } from '../theme/appearance';
import { officeHTML, scriptJSON } from './html';

/** The Mac app's office, with the user's Bots at their desks. Tapping a Bot opens it. */
export function OfficeSheet({
  visible,
  bots,
  onClose,
  onOpenBot,
}: {
  visible: boolean;
  bots: readonly Bot[];
  onClose: () => void;
  onOpenBot: (id: string) => void;
}) {
  const dark = useThemeScheme() === 'dark';
  const safe = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  // The page is built once per opening; later roster changes are sent to it live.
  const latest = useRef(bots);
  latest.current = bots;
  // Rebuilt when opened or the theme changes, not on every roster update.
  const html = useMemo(() => (visible ? officeHTML(latest.current, dark) : ''), [visible, dark]);
  useEffect(() => {
    web.current?.injectJavaScript(`window.__officeReceive?.(${scriptJSON(bots)});true;`);
  }, [bots]);
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1 }}>
        {visible ? (
          <WebView
            ref={web}
            testID="office"
            originWhitelist={['about:blank']}
            source={{ html }}
            javaScriptEnabled
            allowFileAccess={false}
            allowUniversalAccessFromFileURLs={false}
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            cacheEnabled={false}
            incognito
            setSupportMultipleWindows={false}
            allowsLinkPreview={false}
            scrollEnabled={false}
            bounces={false}
            // Only the inline page ever loads; nothing navigates away from it.
            onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
            onMessage={(event) => {
              try {
                const message = JSON.parse(event.nativeEvent.data) as {
                  type?: string;
                  botId?: unknown;
                };
                if (
                  message.type === 'open' &&
                  typeof message.botId === 'string' &&
                  latest.current.some((bot) => bot.id === message.botId)
                ) {
                  onOpenBot(message.botId);
                }
              } catch {
                // Not a message from the office page.
              }
            }}
            style={{ flex: 1, backgroundColor: dark ? '#0a0a0a' : '#ffffff' }}
          />
        ) : null}
        <View style={{ position: 'absolute', top: safe.top + 8, right: 16 }}>
          <GlassIconButton icon="close" label="Close the office" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
