import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Crypto from 'expo-crypto';
import { useMobile } from '../api/provider';
import { Button, Empty, Label } from '../components/ui';
import { createPreviewBridge, type PreviewStatus } from '../preview/bridge';
import { previewHTML } from '../preview/html';
import { useTheme } from '../theme';
import { useBots } from './data';

export function PreviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const mobile = useMobile();
  const bots = useBots();
  const c = useTheme();
  const bot = bots.data?.find((bot) => bot.id === id);
  const [attempt, setAttempt] = useState(0);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [status, setStatus] = useState<PreviewStatus>('connecting');
  const webview = useRef<WebView>(null);
  const session = useMemo(() => Crypto.randomUUID(), [id, mobile.host?.id, attempt, foreground]);
  const bridge = useMemo(() => {
    if (!mobile.transport || !foreground) return null;
    try {
      return createPreviewBridge({
        botId: id,
        session,
        createSocket: (path) => mobile.transport!.createBinarySocket(path),
        sendToBrowser: (event) =>
          webview.current?.injectJavaScript(
            `window.__openbotsPreviewReceive?.(${JSON.stringify(event)});true;`,
          ),
        onStatus: setStatus,
      });
    } catch {
      return null;
    }
  }, [id, mobile.transport, session, foreground]);
  useEffect(() => () => bridge?.dispose(), [bridge]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') bridge?.dispose();
      setForeground(state === 'active');
    });
    return () => subscription.remove();
  }, [bridge]);
  const html = useMemo(() => (bridge ? previewHTML(id, session) : ''), [bridge, id, session]);
  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: `${bot?.name ?? 'Bot'} · Preview` }} />
      <View style={styles.header}>
        <Label muted size={13}>
          View only · screen control is available on your computer.
        </Label>
      </View>
      {bridge ? (
        <WebView
          key={session}
          ref={webview}
          source={{ html, baseUrl: 'https://openbots-preview.invalid/' }}
          style={styles.webview}
          originWhitelist={['https://openbots-preview.invalid']}
          javaScriptEnabled
          onMessage={(event) => bridge.handleMessage(event.nativeEvent.data)}
          onShouldStartLoadWithRequest={(request) =>
            request.url === 'about:blank' || request.url === 'https://openbots-preview.invalid/'
          }
          onError={() => setStatus('error')}
          onContentProcessDidTerminate={() => {
            bridge.dispose();
            setStatus('error');
          }}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          cacheEnabled={false}
          incognito
          allowsInlineMediaPlayback={false}
          allowsLinkPreview={false}
          allowFileAccess={false}
          allowUniversalAccessFromFileURLs={false}
          setSupportMultipleWindows={false}
        />
      ) : (
        <Empty
          icon="desktop-outline"
          title="Screen unavailable"
          detail="Connect to this server to view the Bot’s running screen."
        />
      )}
      {bridge && status !== 'connected' ? (
        <View style={styles.status}>
          <Label muted>
            {status === 'connecting'
              ? 'Connecting to the Bot’s screen…'
              : 'The screen is unavailable. Start the computer on your desktop, then reconnect.'}
          </Label>
          {status !== 'connecting' ? (
            <Button
              title="Reconnect preview"
              variant="secondary"
              onPress={() => {
                setStatus('connecting');
                setAttempt((value) => value + 1);
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingVertical: 12 },
  webview: { flex: 1, backgroundColor: '#111' },
  status: { padding: 20, gap: 12 },
});
