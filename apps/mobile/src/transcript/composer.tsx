import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useMobile } from '../api/provider';
import { Icon, Label, row } from '../components/ui';
import { GlassSurface } from '../components/glass';
import { useTheme } from '../theme';
import { activeMention, insertMention, type Attachment } from './model';
import type { Bot } from '../screens/data';

export function Composer({
  onSend,
  sending,
  bots = [],
  threadRootId,
  textOnly = false,
  sendDisabled = false,
  maxLength,
  onFocusChange,
}: {
  onSend: (body: {
    text?: string;
    attachments?: string[];
    threadRootId?: string;
  }) => Promise<unknown>;
  sending: boolean;
  bots?: Bot[];
  threadRootId?: string;
  /** Text-only agents do not accept chat attachments or Bot mentions. */
  textOnly?: boolean;
  sendDisabled?: boolean;
  maxLength?: number;
  onFocusChange?: (focused: boolean) => void;
}) {
  const c = useTheme();
  const mobile = useMobile();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [actionsOpen, setActionsOpen] = useState(false);
  const sendInFlight = useRef(false);
  const busy = sending || uploading;
  const canSend = Boolean(text.trim() || attachments.length) && !busy && !sendDisabled;
  const input = useRef<TextInput>(null);
  const mention = textOnly ? null : activeMention(text, cursor);
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
  function mentionBot() {
    setText((value) => `${value}${value && !value.endsWith(' ') ? ' ' : ''}@`);
    input.current?.focus();
  }
  function showActions() {
    if (!busy) setActionsOpen((open) => !open);
  }
  async function send() {
    if (!canSend || sendInFlight.current) return;
    sendInFlight.current = true;
    setActionsOpen(false);
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
      sendInFlight.current = false;
      setUploading(false);
    }
  }
  return (
    <View style={styles.dock}>
      {actionsOpen && !busy ? (
        <GlassSurface
          radius={24}
          accessibilityLabel="Attachment options"
          onAccessibilityEscape={() => setActionsOpen(false)}
          style={styles.actions}
        >
          {(
            [
              { label: 'Photos', icon: 'images-outline', action: photos },
              { label: 'Files', icon: 'folder-outline', action: files },
              { label: 'Mention a Bot', icon: 'at-outline', action: mentionBot },
            ] as const
          ).map(({ label, icon, action }) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityLabel={label}
              onPress={() => {
                setActionsOpen(false);
                void action();
              }}
              style={({ pressed }) => [
                styles.action,
                { backgroundColor: pressed ? c.muted : 'transparent' },
              ]}
            >
              <Icon name={icon} size={23} />
              <Label size={17}>{label}</Label>
            </Pressable>
          ))}
        </GlassSurface>
      ) : null}
      {!actionsOpen && suggestions.length ? (
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
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
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
      <GlassSurface style={styles.capsule}>
        {!textOnly && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={actionsOpen ? 'Close attachment options' : 'Add to message'}
            accessibilityHint="Choose a photo, file, or Bot mention"
            accessibilityState={{ disabled: busy, expanded: actionsOpen }}
            disabled={busy}
            onPress={showActions}
            style={({ pressed }) => [
              styles.iconButton,
              { opacity: busy ? 0.4 : pressed ? 0.6 : 1 },
            ]}
          >
            <Icon name={actionsOpen ? 'close' : 'add'} size={25} color={c.foreground} />
          </Pressable>
        )}
        <TextInput
          ref={input}
          accessibilityLabel="Message"
          placeholder={threadRootId ? 'Reply in thread…' : 'Message…'}
          placeholderTextColor={c.mutedForeground}
          multiline
          maxLength={maxLength}
          editable={!sending && !uploading}
          value={text}
          onChangeText={setText}
          onFocus={() => {
            setActionsOpen(false);
            onFocusChange?.(true);
          }}
          onBlur={() => onFocusChange?.(false)}
          onPressIn={() => setActionsOpen(false)}
          onSelectionChange={(event) => setCursor(event.nativeEvent.selection.end)}
          style={[styles.input, textOnly && styles.textOnlyInput, { color: c.foreground }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={busy ? 'Sending message' : 'Send'}
          accessibilityState={{ disabled: !canSend, busy }}
          disabled={!canSend}
          onPress={() => void send()}
          style={({ pressed }) => [
            styles.iconButton,
            styles.send,
            {
              backgroundColor: canSend || busy ? c.primary : c.muted,
              opacity: pressed ? 0.65 : 1,
            },
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={c.primaryForeground} />
          ) : (
            <Icon
              name="arrow-up"
              size={22}
              color={canSend ? c.primaryForeground : c.mutedForeground}
            />
          )}
        </Pressable>
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, gap: 8 },
  actions: {
    alignSelf: 'flex-start',
    width: 252,
    maxWidth: '100%',
    padding: 6,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 18,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    padding: 5,
  },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  send: { borderRadius: 22 },
  textOnlyInput: { paddingLeft: 14 },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 23,
    minHeight: 44,
    maxHeight: 144,
    paddingHorizontal: 2,
    paddingTop: 10,
    paddingBottom: 10,
  },
});
