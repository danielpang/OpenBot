import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  CODER_AGENT_LABELS,
  CODING_SESSION_ENDED,
  type CodingSessionStatus,
} from '@openbots/shared';
import {
  approvalStatusWords,
  sessionErrorWords,
  sessionStatusWords,
  usageWords,
  type CoderLoginProps,
  type CoderLoginWidgetState,
  type CodingSessionProps,
  type CodingSessionState,
} from '@openbots/widgets';
import { Button, Field, Icon, Label, row } from '../components/ui';
import { useTheme, type Theme } from '../theme';

// Compact session previews link to the full interactive coding conversation.
// Approvals, Stop and sign-in remain available directly in the Bot's chat.

/** Sends a widget action; resolves false when it failed. */
type Act = (action: Record<string, unknown>) => Promise<boolean | void>;
type Decide = (approvalId: string, decision: 'approve' | 'deny') => Promise<boolean | void>;

/** How many feed lines the phone shows. */
export const PHONE_FEED_LINES = 8;

function statusColor(status: CodingSessionStatus, c: Theme) {
  if (status === 'running' || status === 'starting' || status === 'settled') return c.success;
  if (status === 'waiting') return c.warning;
  if (status === 'failed') return c.danger;
  return c.mutedForeground;
}

function openLink(url: string) {
  void Linking.openURL(url).catch(() => undefined);
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

export function CodingSessionBody({
  props,
  state: raw,
  busy,
  act,
  decide,
}: {
  props: CodingSessionProps;
  state: Record<string, unknown>;
  busy: boolean;
  act: Act;
  decide: Decide;
}) {
  const c = useTheme();
  const state = raw as Partial<CodingSessionState>;
  const status: CodingSessionStatus = state.status ?? 'queued';
  const ended = CODING_SESSION_ENDED.includes(status);
  const feed = (state.feed ?? []).slice(-PHONE_FEED_LINES);
  const approvals = state.approvals ?? [];
  const result = state.result;
  const added = result?.changed_files.reduce((sum, file) => sum + file.added, 0) ?? 0;
  const removed = result?.changed_files.reduce((sum, file) => sum + file.removed, 0) ?? 0;
  const diffId = (result as { diff_artifact_id?: unknown } | undefined)?.diff_artifact_id;
  return (
    <>
      <View style={row.base}>
        <Icon name="code-slash-outline" />
        <View style={{ flex: 1 }}>
          <Label weight="600">
            {CODER_AGENT_LABELS[props.agent]} on {props.repo}
          </Label>
          <Label muted size={14} selectable>
            Branch {props.branch}
          </Label>
        </View>
      </View>
      <View
        style={[row.base, { gap: 8 }]}
        accessible
        accessibilityLabel={`Status: ${sessionStatusWords[status]}`}
      >
        <View
          testID="coding-session-status-dot"
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: statusColor(status, c),
          }}
        />
        <Label size={14}>{sessionStatusWords[status]}</Label>
      </View>
      <Button
        title="Open Code"
        variant="secondary"
        icon="code-slash-outline"
        onPress={() => router.push(`/coding-session/${props.session_id}`)}
      />
      {feed.length ? (
        <View
          testID="coding-session-feed"
          style={{ backgroundColor: c.muted, borderRadius: 12, padding: 10, gap: 2 }}
        >
          {feed.map((line, i) => (
            <Text
              key={`${line.t}-${i}`}
              numberOfLines={2}
              style={{
                color: c.mutedForeground,
                fontFamily: 'Menlo',
                fontSize: 12,
                lineHeight: 17,
              }}
            >
              {line.text}
            </Text>
          ))}
        </View>
      ) : null}
      {approvals.map((approval) =>
        approval.status === 'pending' ? (
          <View
            key={approval.id}
            style={{ borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 12, gap: 8 }}
          >
            <View style={row.base}>
              <Icon name="hand-left-outline" size={18} />
              <Label weight="600">{approval.title}</Label>
            </View>
            {approval.detail ? (
              <Label muted size={14} selectable>
                {approval.detail}
              </Label>
            ) : null}
            <View style={row.base}>
              <View style={{ flex: 1 }}>
                <Button
                  title="Deny"
                  variant="secondary"
                  disabled={busy}
                  onPress={() => void decide(approval.id, 'deny')}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  title="Approve"
                  loading={busy}
                  onPress={() => void decide(approval.id, 'approve')}
                />
              </View>
            </View>
          </View>
        ) : (
          <Label key={approval.id} muted size={14}>
            {approval.title}: {approvalStatusWords[approval.status]}
          </Label>
        ),
      )}
      {result ? (
        <View style={{ gap: 6 }}>
          {result.summary ? <Label>{result.summary}</Label> : null}
          <Label muted size={14}>
            {plural(result.changed_files.length, 'file changed', 'files changed')} (+{added}, -
            {removed}), {plural(result.commits.length, 'commit', 'commits')}
          </Label>
          {result.usage && usageWords(result.usage) ? (
            <Label muted size={14}>
              {usageWords(result.usage)}
            </Label>
          ) : null}
          {typeof diffId === 'string' && diffId ? (
            <View style={{ gap: 4 }}>
              <Label muted size={14}>
                Diff saved as an Artifact
              </Label>
              <Button
                title="View diff"
                variant="secondary"
                icon="document-text-outline"
                onPress={() => router.push(`/artifact/${diffId}`)}
              />
            </View>
          ) : null}
          {result.pr_url ? (
            <Button
              title="Open pull request"
              variant="secondary"
              icon="open-outline"
              onPress={() => openLink(result.pr_url!)}
            />
          ) : null}
        </View>
      ) : null}
      {state.error ? <Label size={14}>{sessionErrorWords(state.error)}</Label> : null}
      {!ended ? (
        <Button
          title="Stop"
          variant="danger"
          disabled={busy || state.control === 'stop'}
          onPress={() => void act({ type: 'stop' })}
        />
      ) : (
        <Label muted size={14}>
          Open Code to message the agent directly, or reply in this thread.
        </Label>
      )}
    </>
  );
}

export function CoderLoginBody({
  props,
  state: raw,
  busy,
  act,
}: {
  props: CoderLoginProps;
  state: Record<string, unknown>;
  busy: boolean;
  act: Act;
}) {
  const [code, setCode] = useState('');
  // Set once the owner sends a code, with the error showing then; "Checking
  // the code" shows until the status moves on or a new error comes back.
  const [submitted, setSubmitted] = useState<{ error: string | null } | null>(null);
  const state = raw as Partial<CoderLoginWidgetState>;
  const status = state.status ?? 'pending';
  const label = CODER_AGENT_LABELS[props.agent];
  const url = props.url ?? state.url;
  const deviceCode = props.device_code ?? state.device_code;
  // The Claude CLI asks for the code as soon as it prints the link, so the
  // login is often awaiting_code before the owner has done anything.
  const checking =
    status === 'awaiting_code' && !!submitted && submitted.error === (state.error ?? null);
  const open = (status === 'pending' || status === 'awaiting_code') && !checking;

  async function sendCode() {
    const before = state.error ?? null;
    if ((await act({ type: 'code', code: code.trim() })) !== false) {
      setSubmitted({ error: before });
    }
  }
  return (
    <>
      <View style={row.base}>
        <Icon name="key-outline" />
        <Label weight="600">Sign in to {label}</Label>
      </View>
      <Label>{props.instructions}</Label>
      {open && url ? (
        <>
          <Label muted size={14} selectable>
            {url}
          </Label>
          <Button
            title="Open in browser"
            variant="secondary"
            icon="open-outline"
            onPress={() => openLink(url)}
          />
        </>
      ) : null}
      {open && deviceCode ? (
        <View style={{ gap: 4 }}>
          <Label muted size={14}>
            Code to enter
          </Label>
          <Label size={28} weight="700" selectable style={{ fontFamily: 'Menlo' }}>
            {deviceCode}
          </Label>
          <Label muted size={14}>
            Enter this code on the sign-in page. There is nothing to paste back here.
          </Label>
        </View>
      ) : null}
      {props.waiting?.length ? (
        <Label muted size={14}>
          Also waiting: {props.waiting.map((bot) => bot.name).join(', ')}
        </Label>
      ) : null}
      {open && !deviceCode ? (
        <>
          <Field
            accessibilityLabel="Code from the sign-in page"
            placeholder="Paste the code here"
            value={code}
            onChangeText={setCode}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button
            title="Done"
            loading={busy}
            disabled={code.trim().length < 4}
            onPress={() => void sendCode()}
          />
        </>
      ) : null}
      {open ? (
        <>
          <Button
            title="Can’t sign in"
            variant="secondary"
            disabled={busy}
            onPress={() => void act({ type: 'cant' })}
          />
        </>
      ) : (
        <Label muted>{checking ? 'Checking the code.' : loginStatusText(state, label)}</Label>
      )}
      {!checking && state.error ? <Label size={14}>{state.error}</Label> : null}
    </>
  );
}

function loginStatusText(state: Partial<CoderLoginWidgetState>, label: string) {
  switch (state.status) {
    case 'signed_in':
      return state.account_label
        ? `Signed in to ${label} as ${state.account_label}.`
        : `Signed in to ${label}.`;
    case 'expired':
      return 'This sign-in expired.';
    case 'cancelled':
      return state.wants_api_key
        ? 'Using an API key instead. Add it in Settings on your computer.'
        : 'This sign-in was cancelled.';
    default:
      return 'Sign-in did not finish.';
  }
}
