import { memo, useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import Markdown from 'react-native-markdown-display';
import { useMobile } from '../api/provider';
import { useFileSource } from '../api/use-file-source';
import { Card, Icon, Label, row } from '../components/ui';
import { useTheme } from '../theme';
import { NativeWidget } from './widget';
import { formatBytes, type Message } from './model';
import type { ActivityStep } from './blocks';

const listContent = { flex: 0, flexGrow: 1, flexShrink: 1 } as const;

// The markdown library gives every node a fresh key each time it parses, so a re-render
// that reaches it unmounts and rebuilds the whole message: a visible flicker, and a
// re-measure that shifts the transcript. Its memo only holds for an unchanged text and
// a stable style, so both are kept stable here.
const MessageText = memo(function MessageText({ text }: { text: string }) {
  const c = useTheme();
  const style = useMemo(
    () => ({
      body: { color: c.foreground, fontSize: 16, lineHeight: 24 },
      paragraph: { marginTop: 0, marginBottom: 10 },
      link: { color: c.foreground, textDecorationLine: 'underline' as const },
      // The library's `flex: 1` (a zero flex-basis) makes list text measure
      // wrongly inside content-sized containers such as the user's message
      // bubble, so long list items spill outside it. Styles are merged over
      // the defaults, so `flex: 0` is needed to restore the auto basis.
      bullet_list_content: listContent,
      ordered_list_content: listContent,
      code_inline: { backgroundColor: c.muted, color: c.foreground, fontFamily: 'Menlo' },
      fence: {
        backgroundColor: c.muted,
        color: c.foreground,
        borderColor: c.border,
        borderRadius: 12,
        padding: 12,
      },
      blockquote: { backgroundColor: c.muted, borderColor: c.border },
      table: { borderColor: c.border },
      tr: { borderColor: c.border },
      th: { color: c.foreground },
      td: { color: c.foreground },
    }),
    [c],
  );
  return <Markdown style={style}>{text}</Markdown>;
});

/** One tool step: its label, and on a tap what the tool was given and returned. */
function StepRow({ step }: { step: ActivityStep }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={row.base}
      >
        <StepIcon step={step} />
        <Label muted size={14} style={{ flex: 1 }}>
          {step.label}
          {step.done ? '' : '…'}
        </Label>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} />
      </Pressable>
      {expanded ? (
        <Card>
          <Label size={12} style={{ fontFamily: 'Menlo' }}>
            {JSON.stringify(step.result === undefined ? step.args : step.result, null, 2)}
          </Label>
        </Card>
      ) : null}
    </View>
  );
}

function StepIcon({ step }: { step: ActivityStep }) {
  const c = useTheme();
  return (
    <Icon
      name={
        !step.done
          ? 'construct-outline'
          : step.error
            ? 'alert-circle-outline'
            : 'checkmark-circle-outline'
      }
      size={16}
      color={c.mutedForeground}
    />
  );
}

/**
 * A run of tool steps as one line: the latest step and how many there were. A long
 * research reply would otherwise be a screen of "Reading…" rows before its answer.
 */
export const ActivityView = memo(function ActivityView({ steps }: { steps: ActivityStep[] }) {
  const c = useTheme();
  const [expanded, setExpanded] = useState(false);
  const last = steps.at(-1);
  if (!last) return null;
  if (steps.length === 1) return <StepRow step={last} />;
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        testID="message-activity"
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${last.label}, ${steps.length} steps`}
        onPress={() => setExpanded(!expanded)}
        style={row.base}
      >
        <StepIcon step={last} />
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: c.mutedForeground }}>
          {last.label}
          {last.done ? '' : '…'} · {steps.length} steps
        </Text>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} />
      </Pressable>
      {expanded ? (
        <View style={{ gap: 8, paddingLeft: 12, borderLeftWidth: 1, borderColor: c.border }}>
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </View>
      ) : null}
    </View>
  );
});

export const MessagePartView = memo(function MessagePartView({
  part,
  message,
  index,
  onUpdated,
}: {
  part: Message['parts'][number];
  message: Message;
  index: number;
  onUpdated?: () => void;
}) {
  const c = useTheme();
  const mobile = useMobile();
  const [expanded, setExpanded] = useState(false);
  const imageSource = useFileSource(part.type === 'image' ? part.file_id : undefined);
  switch (part.type) {
    case 'text':
      return <MessageText text={part.text} />;
    case 'image':
      return (
        <Image
          accessibilityLabel={part.name}
          source={imageSource}
          style={{ width: '100%', height: 230, borderRadius: 14, backgroundColor: c.muted }}
          contentFit="contain"
        />
      );
    case 'file':
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${part.name}`}
          onPress={() =>
            void mobile
              .openFile(part.file_id, part.name)
              .catch((e) => Alert.alert('Could not open file', e.message))
          }
        >
          <Card>
            <View style={row.base}>
              <Icon name="document-outline" />
              <View style={{ flex: 1 }}>
                <Label weight="600">{part.name}</Label>
                <Label size={12} muted>
                  {part.mime}
                  {typeof part.size === 'number' ? ` · ${formatBytes(part.size)}` : ''}
                </Label>
              </View>
              <Icon name="arrow-down-outline" size={18} />
            </View>
          </Card>
        </Pressable>
      );
    case 'widget':
      return (
        <NativeWidget
          part={part}
          messageId={message.id}
          index={index}
          onUpdated={onUpdated}
          botId={message.authorType === 'bot' ? (message.authorId ?? undefined) : undefined}
        />
      );
    case 'reasoning':
      return (
        <View style={{ gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
            style={row.base}
          >
            <Icon name="sparkles-outline" size={16} color={c.mutedForeground} />
            <Label muted size={14}>
              Reasoning
            </Label>
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} />
          </Pressable>
          {expanded ? (
            <Label muted size={14}>
              {part.text}
            </Label>
          ) : null}
        </View>
      );
    case 'tool_call':
    case 'tool_result':
      return (
        <View style={{ gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
            style={row.base}
          >
            <Icon
              name={
                part.type === 'tool_result'
                  ? part.is_error
                    ? 'alert-circle-outline'
                    : 'checkmark-circle-outline'
                  : 'construct-outline'
              }
              size={16}
              color={c.mutedForeground}
            />
            <Label muted size={14} style={{ flex: 1 }}>
              {part.label || part.tool_name}
            </Label>
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} />
          </Pressable>
          {expanded ? (
            <Card>
              <Label size={12} style={{ fontFamily: 'Menlo' }}>
                {JSON.stringify(part.type === 'tool_call' ? part.args : part.result, null, 2)}
              </Label>
            </Card>
          ) : null}
        </View>
      );
    case 'event':
      return (
        <View style={[row.base, { paddingVertical: 8 }]}>
          <Icon name="ellipse" size={5} color={c.mutedForeground} />
          <Label muted size={13}>
            {part.text}
          </Label>
        </View>
      );
    case 'artifact':
      return (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push(`/artifact/${part.artifact_id}`)}
        >
          <Card>
            <View style={row.base}>
              <Icon name="layers-outline" />
              <View style={{ flex: 1 }}>
                <Label weight="600">{part.title}</Label>
                <Label muted size={13}>
                  {part.kind ?? 'Artifact'}
                  {part.version ? ` · Version ${part.version}` : ''}
                </Label>
              </View>
              <Icon name="chevron-forward" size={16} />
            </View>
          </Card>
        </Pressable>
      );
    case 'skill_ref':
      return (
        <View style={row.base}>
          <Icon name="flash-outline" size={16} />
          <Label size={14}>/{part.name ?? 'Skill'}</Label>
        </View>
      );
    default:
      return <Label muted>Open this message on your computer.</Label>;
  }
});
