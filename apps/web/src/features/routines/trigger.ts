import {
  EndpointMatchSchema,
  type EventTrigger,
  type GithubEvent,
  type SlackEvent,
} from '@openbots/shared';

// The event trigger's model (R2): a draft with a field for every source and
// event, so switching keeps what was typed, turned into the narrow matching
// rule the Routine stores (or a sentence saying what is wrong) on save. The
// rule is stored without its `source`, which the trigger already names; the
// server joins the two when a delivery arrives (hooks/endpoints.ts ruleFor).

export type EventSource = EventTrigger['source'];
export type ConditionOp = 'equals' | 'contains' | 'matches';

export interface ConditionDraft {
  path: string;
  op: ConditionOp;
  value: string;
}

export interface EventDraft {
  source: EventSource;
  github: GithubEvent;
  slack: SlackEvent;
  repo: string;
  label: string;
  text: string;
  channel: string;
  emoji: string;
  pattern: string;
  conditions: ConditionDraft[];
}

export const EVENT_SOURCES: { source: EventSource; label: string }[] = [
  { source: 'webhook', label: 'Webhook POST' },
  { source: 'github', label: 'GitHub' },
  { source: 'slack', label: 'Slack' },
];

export const GITHUB_EVENTS: { event: GithubEvent; label: string }[] = [
  { event: 'issue_opened', label: 'Issue opened' },
  { event: 'issue_closed', label: 'Issue closed' },
  { event: 'pr_opened', label: 'Pull request opened' },
  { event: 'pr_merged', label: 'Pull request merged' },
  { event: 'pr_closed', label: 'Pull request closed' },
  { event: 'check_failed', label: 'Check failed' },
  { event: 'label_added', label: 'Label added' },
  { event: 'comment_contains', label: 'Comment contains text' },
];

export const SLACK_EVENTS: { event: SlackEvent; label: string }[] = [
  { event: 'message', label: 'Message in a channel' },
  { event: 'reaction_added', label: 'Reaction added' },
  { event: 'channel_created', label: 'Channel created' },
];

export const CONDITION_OPS: { op: ConditionOp; label: string }[] = [
  { op: 'equals', label: 'equals' },
  { op: 'contains', label: 'contains' },
  { op: 'matches', label: 'matches (regex)' },
];

export const DEFAULT_EVENT_DRAFT: EventDraft = {
  source: 'webhook',
  github: 'pr_opened',
  slack: 'message',
  repo: '',
  label: '',
  text: '',
  channel: '',
  emoji: '',
  pattern: '',
  conditions: [],
};

/** Which optional fields each event's rule reads; the rest are not sent. */
export function eventFields(draft: Pick<EventDraft, 'source' | 'github' | 'slack'>) {
  if (draft.source === 'github') {
    return {
      repo: true,
      label: draft.github === 'label_added',
      text: draft.github === 'comment_contains',
    };
  }
  if (draft.source === 'slack') {
    return {
      channel: draft.slack !== 'channel_created',
      text: draft.slack === 'message',
      emoji: draft.slack === 'reaction_added',
      pattern: draft.slack === 'channel_created',
    };
  }
  return {};
}

export function draftFromTrigger(trigger: Pick<EventTrigger, 'source' | 'match'>): EventDraft {
  const match = (trigger.match ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof match[key] === 'string' ? (match[key] as string) : '');
  const draft: EventDraft = {
    ...DEFAULT_EVENT_DRAFT,
    source: trigger.source,
    repo: text('repo'),
    label: text('label'),
    text: text('text'),
    channel: text('channel'),
    emoji: text('emoji'),
    pattern: text('pattern'),
    conditions: Array.isArray(match.conditions) ? (match.conditions as ConditionDraft[]) : [],
  };
  if (trigger.source === 'github' && match.event) draft.github = match.event as GithubEvent;
  if (trigger.source === 'slack' && match.event) draft.slack = match.event as SlackEvent;
  return draft;
}

export type MatchCheck =
  { ok: true; match: Record<string, unknown> | undefined } | { ok: false; error: string };

/**
 * The rule to store, without `source`. A webhook Routine with no conditions
 * has no rule: every delivery to its endpoint starts it.
 */
export function matchFromDraft(draft: EventDraft): MatchCheck {
  const fields = eventFields(draft) as Record<string, boolean | undefined>;
  const given = (key: keyof EventDraft) => {
    const value = (draft[key] as string).trim();
    return fields[key] && value ? { [key]: value } : {};
  };
  const candidate = (() => {
    switch (draft.source) {
      case 'github':
        return {
          source: 'github',
          event: draft.github,
          ...given('repo'),
          ...given('label'),
          ...given('text'),
        };
      case 'slack':
        return {
          source: 'slack',
          event: draft.slack,
          ...given('channel'),
          ...given('text'),
          ...given('emoji'),
          ...given('pattern'),
        };
      case 'webhook': {
        const conditions = draft.conditions
          .map((c) => ({ ...c, path: c.path.trim() }))
          .filter((c) => c.path);
        return conditions.length ? { source: 'webhook', conditions } : null;
      }
    }
  })();
  if (!candidate) return { ok: true, match: undefined };
  const parsed = EndpointMatchSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid matching rule' };
  }
  if (parsed.data.source === 'webhook') {
    for (const condition of parsed.data.conditions) {
      if (condition.op !== 'matches') continue;
      try {
        new RegExp(condition.value, 'i');
      } catch {
        return { ok: false, error: `“${condition.value}” is not a regular expression` };
      }
    }
  }
  const { source: _source, ...match } = parsed.data;
  return { ok: true, match };
}
