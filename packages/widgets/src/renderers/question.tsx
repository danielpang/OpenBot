import { Button, Input } from '@openbots/ui';
import { useState, type FormEvent } from 'react';
import type { z } from 'zod';
import type { QuestionPropsSchema, QuestionState } from '../kinds/question.js';
import type { WidgetRendererProps } from './types.js';

// A question with option buttons and, unless `allow_text` is false, a typed
// answer (plan 12.2). Answering posts `{type: 'answer', option_id | text}`;
// once answered the widget is disabled and shows the chosen answer.

type QuestionProps = z.infer<typeof QuestionPropsSchema>;

export function QuestionWidget({
  props,
  state,
  onAction,
}: WidgetRendererProps<QuestionProps, QuestionState>) {
  const [local, setLocal] = useState<QuestionState | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');

  const current = state?.status === 'answered' ? state : (local ?? state);
  const answer = current?.status === 'answered' ? current.answer : undefined;
  const answered = current?.status === 'answered';
  const disabled = answered || busy || !onAction;
  const options = props.options ?? [];
  const allowText = props.allow_text !== false || options.length === 0;

  async function send(action: { type: 'answer'; option_id?: string; text?: string }) {
    if (!onAction) return;
    setBusy(true);
    setError(null);
    try {
      const next = (await onAction(action)) as QuestionState | undefined;
      setLocal(next?.status === 'answered' ? next : answeredLocally(action, options));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the answer');
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (value) void send({ type: 'answer', text: value });
  }

  return (
    <div className="flex max-w-lg flex-col gap-2 rounded-lg border bg-card p-3 text-sm">
      <p className="whitespace-pre-wrap">{props.question}</p>
      {options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => {
            const chosen = answer?.option_id === option.id;
            return (
              <Button
                key={option.id}
                type="button"
                size="sm"
                variant={chosen ? 'default' : 'outline'}
                aria-pressed={chosen}
                disabled={disabled}
                onClick={() => void send({ type: 'answer', option_id: option.id })}
              >
                {option.label}
              </Button>
            );
          })}
        </div>
      )}
      {answered
        ? answer?.text && <p className="text-muted-foreground">Answered: {answer.text}</p>
        : allowText && (
            <form className="flex gap-2" onSubmit={submit}>
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type an answer"
                aria-label="Answer"
                disabled={disabled}
              />
              <Button type="submit" size="sm" variant="outline" disabled={disabled || !text.trim()}>
                Send
              </Button>
            </form>
          )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function answeredLocally(
  action: { option_id?: string; text?: string },
  options: { id: string; label: string }[],
): QuestionState {
  const option = options.find((o) => o.id === action.option_id);
  return {
    status: 'answered',
    answer: option ? { option_id: option.id, label: option.label } : { text: action.text },
  };
}
