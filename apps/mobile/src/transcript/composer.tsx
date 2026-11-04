import { useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useMobile } from '../api/provider';
import { Button, Icon, Label, row } from '../components/ui';
import { useTheme } from '../theme';
import { activeMention, insertMention, type Attachment } from './model';
import type { Bot } from '../screens/data';

export function Composer({
  onSend,
  sending,
  bots = [],
  threadRootId,
}: {
  onSend: (body: {
    text?: string;
    attachments?: string[];
    threadRootId?: string;
  }) => Promise<unknown>;
  sending: boolean;
  bots?: Bot[];
  threadRootId?: string;
}) {
  const c = useTheme();
  const mobile = useMobile();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const input = useRef<TextInput>(null);
  const mention = activeMention(text, cursor);
  const suggestions = mention
    ? [{ id: 'everyone', name: 'Everyone', handle: 'everyone' }, ...bots]
        .filter((bot) => bot.handle.toLowerCase().startsWith(mention.query))
        .slice(0, 5)
    : [];
  async function photos() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 0.85,
      });
      if (!result.canceled)
        setAttachments((current) => [
          ...current,
          ...result.assets.map((asset) => ({
            uri: asset.uri,
            name: asset.fileName ?? `photo-${Date.now()}.jpg`,
            mime: asset.mimeType ?? 'image/jpeg',
          })),
        ]);
    } catch (error) {
      Alert.alert(
        'Could not select photos',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  async function files() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (!result.canceled)
        setAttachments((current) => [
          ...current,
          ...result.assets.map((asset) => ({
            uri: asset.uri,
            name: asset.name,
            mime: asset.mimeType ?? 'application/octet-stream',
          })),
        ]);
    } catch (error) {
      Alert.alert('Could not select files', error instanceof Error ? error.message : String(error));
    }
  }
  async function send() {
    const draft = text;
    const files = attachments;
    setUploading(true);
    try {
      const uploaded = [];
      for (const file of files) uploaded.push(await mobile.uploadAttachment(file));
      await onSend({
        ...(draft.trim() ? { text: draft.trim() } : {}),
        ...(uploaded.length ? { attachments: uploaded.map((file) => file.id) } : {}),
        ...(threadRootId ? { threadRootId } : {}),
      });
      setText('');
      setAttachments([]);
      setCursor(0);
    } catch (error) {
      Alert.alert('Message not sent', error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 10,
        gap: 8,
        borderTopWidth: 1,
        borderTopColor: c.border,
        backgroundColor: c.background,
      }}
    >
      {suggestions.length ? (
        <View
          style={{
            backgroundColor: c.card,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: c.border,
          }}
        >
          {suggestions.map((bot) => (
            <Pressable
              key={bot.id}
              accessibilityRole="button"
              accessibilityLabel={`Mention ${bot.name}`}
              onPress={() => {
                const next = insertMention(text, bot.handle, cursor);
                setText(next);
                setCursor(next.length);
                input.current?.focus();
              }}
              style={{ padding: 12 }}
            >
              <Label>
                @{bot.handle} <Label muted>{bot.name}</Label>
              </Label>
            </Pressable>
          ))}
        </View>
      ) : null}
      {attachments.length ? (
        <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
          {attachments.map((file, index) => (
            <Pressable
              key={`${file.uri}-${index}`}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${file.name}`}
              disabled={sending || uploading}
              onPress={() => setAttachments((current) => current.filter((_, i) => i !== index))}
              style={[row.base, { backgroundColor: c.muted, padding: 8, borderRadius: 10 }]}
            >
              <Icon name="document-outline" size={15} />
              <Label size={12}>{file.name}</Label>
              <Icon name="close-circle" size={16} />
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={{ backgroundColor: c.muted, borderRadius: 20, padding: 10, gap: 6 }}>
        <TextInput
          ref={input}
          accessibilityLabel="Message"
          placeholder={threadRootId ? 'Reply in thread…' : 'Message your Bot…'}
          placeholderTextColor={c.mutedForeground}
          multiline
          editable={!sending && !uploading}
          value={text}
          onChangeText={setText}
          onSelectionChange={(event) => setCursor(event.nativeEvent.selection.end)}
          style={{
            color: c.foreground,
            fontSize: 16,
            lineHeight: 23,
            minHeight: 42,
            maxHeight: 140,
            paddingHorizontal: 6,
            paddingVertical: 6,
          }}
        />
        <View style={row.between}>
          <View style={row.base}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Attach a photo"
              disabled={sending || uploading}
              onPress={() => void photos()}
              style={{ padding: 6 }}
            >
              <Icon name="image-outline" size={22} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Attach a file"
              disabled={sending || uploading}
              onPress={() => void files()}
              style={{ padding: 6 }}
            >
              <Icon name="attach-outline" size={22} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Mention a Bot"
              disabled={sending || uploading}
              onPress={() => {
                setText((value) => `${value}${value && !value.endsWith(' ') ? ' ' : ''}@`);
                input.current?.focus();
              }}
              style={{ padding: 6 }}
            >
              <Icon name="at-outline" size={22} />
            </Pressable>
          </View>
          <Button
            title={sending || uploading ? 'Sending' : 'Send'}
            icon="arrow-up"
            loading={sending || uploading}
            disabled={!text.trim() && !attachments.length}
            onPress={() => void send()}
          />
        </View>
      </View>
    </View>
  );
}
