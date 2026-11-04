import { useState } from 'react';
import { View } from 'react-native';
import { unwrap } from '@openbots/api-client';
import {
  validateWidgetAction,
  validateWidgetProps,
  QuestionPropsSchema,
  ApprovalPropsSchema,
  LoginRequestPropsSchema,
  RoutineRunPropsSchema,
} from '@openbots/widgets';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api/provider';
import { Button, Card, ErrorNote, Field, Icon, Label, row } from '../components/ui';
import type { Message } from './model';

export function NativeWidget({
  part,
  messageId,
  index,
  onUpdated,
}: {
  part: Extract<Message['parts'][number], { type: 'widget' }>;
  messageId: string;
  index: number;
  onUpdated?: () => void;
}) {
  const api = useApi();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [answer, setAnswer] = useState('');
  const state = (part.state ?? {}) as Record<string, unknown>;
  const pending = !state.status || state.status === 'pending';
  async function act(action: Record<string, unknown>) {
    const valid = validateWidgetAction(part.kind, action);
    if (!valid.ok) {
      setError(new Error(valid.error));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST('/api/v1/messages/{id}/widgets/{part}/action', {
          params: { path: { id: messageId, part: index } },
          body: { action },
        }),
      );
      await cache.invalidateQueries({ queryKey: ['approvals'] });
      await cache.invalidateQueries({ queryKey: ['inbox'] });
      await cache.invalidateQueries({ queryKey: ['messages'] });
      onUpdated?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const valid = validateWidgetProps(part.kind, part.props);
  if (!valid.ok)
    return (
      <Card>
        <Label weight="600">{part.kind.replaceAll('_', ' ')}</Label>
        <Label muted>This widget is available on your computer.</Label>
      </Card>
    );
  let body;
  if (part.kind === 'question') {
    const props = QuestionPropsSchema.parse(part.props);
    body = (
      <>
        <View style={row.base}>
          <Icon name="help-circle-outline" />
          <Label weight="600">A question for you</Label>
        </View>
        <Label>{props.question}</Label>
        {pending ? (
          <>
            {props.options?.map((option) => (
              <Button
                key={option.id}
                title={option.label}
                variant="secondary"
                disabled={busy}
                onPress={() => void act({ type: 'answer', option_id: option.id })}
              />
            ))}
            {props.allow_text !== false || !props.options?.length ? (
              <>
                <Field
                  accessibilityLabel="Your answer"
                  placeholder="Your answer…"
                  value={answer}
                  onChangeText={setAnswer}
                  multiline
                />
                <Button
                  title="Send answer"
                  loading={busy}
                  disabled={!answer.trim()}
                  onPress={() => void act({ type: 'answer', text: answer.trim() })}
                />
              </>
            ) : null}
          </>
        ) : (
          <Label muted>
            Answered
            {state.answer
              ? `: ${Object.values(state.answer as object)
                  .filter((value) => typeof value === 'string')
                  .join(' · ')}`
              : ''}
          </Label>
        )}
      </>
    );
  } else if (part.kind === 'approval') {
    const props = ApprovalPropsSchema.parse(part.props);
    body = (
      <>
        <View style={row.base}>
          <Icon name="hand-left-outline" />
          <Label weight="600">Approval needed</Label>
        </View>
        <Label weight="600">{props.tool_name}</Label>
        <Label>{props.summary || JSON.stringify(props.args, null, 2)}</Label>
        {props.reason ? (
          <Label muted size={14}>
            {props.reason}
          </Label>
        ) : null}
        {pending ? (
          <View style={row.base}>
            <View style={{ flex: 1 }}>
              <Button
                title="Deny"
                variant="secondary"
                disabled={busy}
                onPress={() => void act({ type: 'deny' })}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Approve"
                loading={busy}
                onPress={() => void act({ type: 'approve' })}
              />
            </View>
          </View>
        ) : (
          <Label muted>{String(state.status)}</Label>
        )}
      </>
    );
  } else if (part.kind === 'login_request') {
    const props = LoginRequestPropsSchema.parse(part.props);
    body = (
      <>
        <View style={row.base}>
          <Icon name="key-outline" />
          <Label weight="600">Sign in to {props.site}</Label>
        </View>
        <Label>{props.reason}</Label>
        <Label muted>Sign in on your computer, then let your Bot know.</Label>
        {pending ? (
          <>
            <Button
              title="I’ve signed in"
              loading={busy}
              onPress={() => void act({ type: 'done' })}
            />
            <Button
              title="Can’t sign in"
              variant="secondary"
              disabled={busy}
              onPress={() => void act({ type: 'cant' })}
            />
          </>
        ) : (
          <Label muted>{String(state.status).replaceAll('_', ' ')}</Label>
        )}
      </>
    );
  } else if (part.kind === 'routine_run') {
    const props = RoutineRunPropsSchema.parse(part.props);
    body = (
      <>
        <Label weight="600">{props.name}</Label>
        <Label muted>Routine {props.outcome}</Label>
        {props.exception ? <Label>{props.exception}</Label> : null}
        {props.outcome !== 'completed' && !state.rerun_run_id ? (
          <Button
            title="Run again"
            loading={busy}
            onPress={() => void act({ type: 'run_again' })}
          />
        ) : null}
        {!state.paused ? (
          <Button
            title="Pause routine"
            variant="secondary"
            disabled={busy}
            onPress={() => void act({ type: 'pause' })}
          />
        ) : (
          <Label muted>Routine paused</Label>
        )}
      </>
    );
  } else {
    const props = part.props as Record<string, unknown>;
    body = (
      <>
        <Label weight="600">
          {String(props.title ?? props.name ?? part.kind.replaceAll('_', ' '))}
        </Label>
        <Label muted>Open this widget on your computer.</Label>
      </>
    );
  }
  return (
    <Card>
      {body}
      <ErrorNote error={error} />
    </Card>
  );
}
