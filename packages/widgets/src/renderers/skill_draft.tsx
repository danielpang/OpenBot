import { SKILL_CONTENT_MAX, SKILL_NAME_MAX } from '@openbots/shared';
import { Button, Input, Textarea } from '@openbots/ui';
import { useState } from 'react';
import type { SkillDraftAction, SkillDraftProps, SkillDraftState } from '../kinds/skill_draft.js';
import type { WidgetRendererProps } from './types.js';

// A Skill draft (S3): the name and content a Bot drafted from a finished run,
// editable, with Save, which writes through to the Skill. Once saved the
// widget is read only and points to the Skills library.

export function SkillDraftWidget({
  props,
  state,
  onAction,
}: WidgetRendererProps<SkillDraftProps, SkillDraftState>) {
  const [local, setLocal] = useState<SkillDraftState | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = local ?? state;
  const [name, setName] = useState(start?.name ?? props.name);
  const [content, setContent] = useState(start?.content ?? props.content);

  const saved = (local?.status ?? state?.status ?? 'draft') !== 'draft';
  const disabled = saved || !onAction || busy;

  async function save() {
    if (!onAction) return;
    if (!name.trim()) {
      setError('Give the Skill a name');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const action: SkillDraftAction = { type: 'save', name: name.trim(), content };
      const next = (await onAction(action)) as SkillDraftState | undefined;
      setLocal(next ?? { status: 'saved', name, content });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the Skill');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex max-w-xl flex-col gap-3 rounded-lg border bg-card p-3 text-sm"
      data-widget="skill_draft"
      data-status={saved ? 'saved' : 'draft'}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Skill</span>
        <Input
          className="h-8 text-sm font-medium"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Skill name"
          maxLength={SKILL_NAME_MAX}
          disabled={disabled}
        />
      </div>
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        aria-label="Skill content"
        maxLength={SKILL_CONTENT_MAX}
        disabled={disabled}
        className="max-h-96 min-h-32 font-mono"
      />
      <div className="flex items-center gap-2">
        {!saved && onAction && (
          <Button type="submit" size="sm" disabled={disabled}>
            Save
          </Button>
        )}
        {saved && (
          <p role="status" className="text-xs text-muted-foreground">
            Saved. Edit it in the Skills library.
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
