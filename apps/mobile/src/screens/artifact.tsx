import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@openbots/api-client';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Image } from 'expo-image';
import { WebView } from 'react-native-webview';
import Markdown from 'react-native-markdown-display';
import { useApi, useMobile } from '../api/provider';
import { Button, ErrorNote, Label, Page } from '../components/ui';
import { useTheme } from '../theme';
import { formatBytes } from '../transcript/model';

const textMime = (mime: string) =>
  mime.startsWith('text/') ||
  mime === 'application/json' ||
  mime === 'application/xml' ||
  mime === 'image/svg+xml';
const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
};
/** Interactive, self-contained HTML runs in an isolated origin with no credentials,
 * bridge, network, navigation, frames or file access. Its inline scripts can update
 * the document, but cannot reach a server API or the enclosing app. */
const isolatedHTML = (html: string) =>
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">${html}`;
export function ArtifactScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const mobile = useMobile();
  const c = useTheme();
  const [sharing, setSharing] = useState(false);
  const [pdfUri, setPdfUri] = useState<string>();
  const artifact = useQuery({
    queryKey: ['artifacts', id],
    queryFn: () => unwrap(api.GET('/api/v1/artifacts/{id}', { params: { path: { id } } })),
  });
  const version = artifact.data?.currentVersion;
  const content = useQuery({
    queryKey: ['artifacts', id, 'versions', version?.version, 'content'],
    enabled: !!version && !!mobile.transport,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const response = await mobile.transport!.fetch(
        `/api/v1/artifacts/${encodeURIComponent(id)}/versions/${version!.version}/content`,
        { signal },
      );
      if (!response.ok) throw new Error(`Could not load Artifact (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    },
  });
  const text = useMemo(
    () =>
      version && content.data && textMime(version.mime)
        ? new TextDecoder().decode(content.data)
        : undefined,
    [version, content.data],
  );
  const html = useMemo(
    () =>
      text && (version?.mime === 'text/html' || version?.mime === 'image/svg+xml')
        ? isolatedHTML(text)
        : undefined,
    [text, version?.mime],
  );
  const imageSource = useMemo(
    () =>
      content.data && version?.mime.startsWith('image/') && version.mime !== 'image/svg+xml'
        ? { uri: `data:${version.mime};base64,${toBase64(content.data)}` }
        : undefined,
    [content.data, version?.mime],
  );
  useEffect(() => {
    if (version?.mime !== 'application/pdf' || !content.data) {
      setPdfUri(undefined);
      return;
    }
    const file = new File(Paths.cache, `artifact-${id}-${version.version}-${Date.now()}.pdf`);
    file.create();
    file.write(content.data);
    setPdfUri(file.uri);
    return () => {
      if (file.exists) file.delete();
    };
  }, [id, version?.version, version?.mime, content.data]);
  async function share() {
    if (!content.data || !artifact.data || !version) return;
    setSharing(true);
    const filename = artifact.data.title.replace(/[^\w. -]/g, '_').slice(-100) || 'artifact';
    const file = new File(Paths.cache, `${Date.now()}-${filename}`);
    try {
      file.create();
      file.write(content.data);
      if (!(await Sharing.isAvailableAsync()))
        throw new Error('Sharing is unavailable on this device.');
      await Sharing.shareAsync(file.uri, {
        mimeType: version.mime,
        dialogTitle: artifact.data.title,
      });
    } catch (error) {
      Alert.alert(
        'Could not open Artifact',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (file.exists) file.delete();
      setSharing(false);
    }
  }
  return (
    <Page scroll={false}>
      <Stack.Screen
        options={{
          title: artifact.data?.title ?? 'Artifact',
          headerRight: () =>
            content.data ? (
              <Button
                title="Share"
                icon="share-outline"
                variant="ghost"
                loading={sharing}
                onPress={() => void share()}
              />
            ) : null,
        }}
      />
      {artifact.isLoading || content.isLoading ? (
        <ActivityIndicator style={{ margin: 30 }} />
      ) : null}
      <ErrorNote error={artifact.error || content.error} onRetry={() => void content.refetch()} />
      {html ? (
        <WebView
          key={`${id}-${version?.version}`}
          originWhitelist={['https://openbots-artifact.invalid']}
          source={{ html, baseUrl: 'https://openbots-artifact.invalid/' }}
          javaScriptEnabled
          allowFileAccess={false}
          allowUniversalAccessFromFileURLs={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          cacheEnabled={false}
          incognito
          setSupportMultipleWindows={false}
          allowsLinkPreview={false}
          onShouldStartLoadWithRequest={(request) =>
            request.url === 'about:blank' || request.url === 'https://openbots-artifact.invalid/'
          }
          style={{ flex: 1, backgroundColor: c.background }}
        />
      ) : imageSource ? (
        <Image
          accessibilityLabel={artifact.data?.title}
          source={imageSource}
          contentFit="contain"
          style={{ flex: 1 }}
        />
      ) : pdfUri ? (
        <WebView
          source={{ uri: pdfUri }}
          originWhitelist={['file://*']}
          javaScriptEnabled={false}
          allowFileAccess
          allowingReadAccessToURL={pdfUri}
          onShouldStartLoadWithRequest={(request) => request.url === pdfUri}
          style={{ flex: 1 }}
        />
      ) : text !== undefined ? (
        <ScrollView contentContainerStyle={{ padding: 22 }}>
          {version?.mime === 'text/markdown' ? (
            <Markdown style={{ body: { color: c.foreground, fontSize: 16 } }}>{text}</Markdown>
          ) : (
            <Label style={{ fontFamily: 'Menlo', fontSize: 13 }}>{text}</Label>
          )}
        </ScrollView>
      ) : content.data && version ? (
        <View style={{ padding: 24, gap: 18 }}>
          <Label size={24} weight="600">
            {artifact.data?.title}
          </Label>
          <Label muted>
            {version.mime} · {formatBytes(content.data.length)}
          </Label>
          <Button
            title="Open or share file"
            icon="share-outline"
            loading={sharing}
            onPress={() => void share()}
          />
        </View>
      ) : null}
    </Page>
  );
}
