import {
  EndpointMatchSchema,
  type EndpointMatch,
  type EventTrigger,
  type GithubEvent,
  type SlackEvent,
} from '@openbots/shared';

// Matching rules (plan 11, R2): each Routine trigger waits for one narrow
// kind of event. GitHub events are read from `X-GitHub-Event` plus the
// payload's `action`; Slack events from the Events API envelope; anything
// else (generic, Stripe) through conditions on dotted paths. Also the
// one-line description the default template and the delivery log use.

export interface IncomingEvent {
  /** Lowercased header names. */
  headers: Record<string, string>;
  payload: unknown;
}

type Json = Record<string, unknown>;

const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;

/** The value at a dotted path (`data.object.id`, `items.0.name`). */
export function valueAt(payload: unknown, path: string): unknown {
  let current: unknown = payload;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Json)[key];
  }
  return current;
}

/** `*` matches any run of characters; everything else is literal, case-insensitive. */
export function globMatches(glob: string, value: string): boolean {
  const source = glob
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 'i').test(value);
}

const contains = (haystack: string | undefined, needle: string) =>
  haystack !== undefined && haystack.toLowerCase().includes(needle.toLowerCase());

// GitHub

/** Which of the narrow GitHub events a delivery is, if any. */
export function githubEvents(event: IncomingEvent): GithubEvent[] {
  const type = event.headers['x-github-event'];
  const p = obj(event.payload);
  const action = str(p['action']);
  const out: GithubEvent[] = [];
  if (type === 'issues' && action === 'opened') out.push('issue_opened');
  if (type === 'issues' && action === 'closed') out.push('issue_closed');
  if (type === 'pull_request' && (action === 'opened' || action === 'reopened')) {
    out.push('pr_opened');
  }
  if (type === 'pull_request' && action === 'closed') {
    out.push(obj(p['pull_request'])['merged'] === true ? 'pr_merged' : 'pr_closed');
  }
  if ((type === 'issues' || type === 'pull_request') && action === 'labeled') {
    out.push('label_added');
  }
  if (
    (type === 'issue_comment' ||
      type === 'pull_request_review_comment' ||
      type === 'commit_comment') &&
    action === 'created'
  ) {
    out.push('comment_contains');
  }
  const failed = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
  const run =
    type === 'check_run'
      ? obj(p['check_run'])
      : type === 'check_suite'
        ? obj(p['check_suite'])
        : type === 'workflow_run'
          ? obj(p['workflow_run'])
          : null;
  if (run && action === 'completed' && failed.has(str(run['conclusion']) ?? '')) {
    out.push('check_failed');
  }
  return out;
}

function githubMatches(rule: Extract<EndpointMatch, { source: 'github' }>, event: IncomingEvent) {
  if (!githubEvents(event).includes(rule.event)) return false;
  const p = obj(event.payload);
  if (rule.repo) {
    const repo = str(obj(p['repository'])['full_name']);
    if (!repo || !globMatches(rule.repo, repo)) return false;
  }
  if (rule.label) {
    const label = str(obj(p['label'])['name']);
    if (!label || label.toLowerCase() !== rule.label.toLowerCase()) return false;
  }
  if (rule.text && !contains(str(obj(p['comment'])['body']), rule.text)) return false;
  return true;
}

// Slack (Events API)

/** The inner Slack event of an `event_callback` envelope. */
function slackEvent(event: IncomingEvent): Json | null {
  const p = obj(event.payload);
  return p['type'] === 'event_callback' ? obj(p['event']) : null;
}

function slackMatches(rule: Extract<EndpointMatch, { source: 'slack' }>, event: IncomingEvent) {
  const inner = slackEvent(event);
  if (!inner) return false;
  const kind = str(inner['type']) as SlackEvent | undefined;
  if (kind !== rule.event) return false;
  switch (rule.event) {
    case 'message': {
      // Plain messages only: edits, joins and other Bots' posts are not "a message in the channel".
      if (inner['subtype'] !== undefined || inner['bot_id'] !== undefined) return false;
      if (rule.channel && str(inner['channel']) !== rule.channel) return false;
      if (rule.text && !contains(str(inner['text']), rule.text)) return false;
      return true;
    }
    case 'reaction_added': {
      if (rule.channel && str(obj(inner['item'])['channel']) !== rule.channel) return false;
      if (rule.emoji && str(inner['reaction']) !== rule.emoji.replace(/^:|:$/g, '')) return false;
      return true;
    }
    case 'channel_created': {
      const name = str(obj(inner['channel'])['name']);
      return Boolean(name && rule.pattern && globMatches(rule.pattern, name));
    }
  }
}

// Generic

/** Longest string a `matches` condition is tested against, against slow patterns. */
const REGEX_INPUT_MAX = 10_000;

function genericMatches(rule: Extract<EndpointMatch, { source: 'webhook' }>, event: IncomingEvent) {
  return rule.conditions.every(({ path, op, value }) => {
    const found = valueAt(event.payload, path);
    const text = str(found) ?? (typeof found === 'boolean' ? String(found) : undefined);
    if (text === undefined) return false;
    if (op === 'equals') return text === value;
    if (op === 'contains') return contains(text, value);
    try {
      return new RegExp(value, 'i').test(text.slice(0, REGEX_INPUT_MAX));
    } catch {
      return false;
    }
  });
}

/** A rule whose every `matches` condition is a regular expression that compiles. */
const CheckedMatchSchema = EndpointMatchSchema.superRefine((rule, ctx) => {
  if (rule.source !== 'webhook') return;
  rule.conditions.forEach(({ op, value }, i) => {
    if (op !== 'matches') return;
    try {
      new RegExp(value, 'i');
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Not a valid regular expression',
        path: ['conditions', i, 'value'],
      });
    }
  });
});

/**
 * A Routine event trigger's stored `match` as a full rule, with the trigger's
 * source added back. Checked on every Routine write and again when a delivery
 * is matched, where a rule that fails matches nothing.
 */
export function parseTriggerRule(trigger: Pick<EventTrigger, 'source' | 'match'>) {
  return CheckedMatchSchema.safeParse({ ...trigger.match, source: trigger.source });
}

/** Whether a delivery passes the endpoint's rule; no rule matches everything. */
export function matchesRule(rule: EndpointMatch | null, event: IncomingEvent): boolean {
  if (!rule) return true;
  switch (rule.source) {
    case 'github':
      return githubMatches(rule, event);
    case 'slack':
      return slackMatches(rule, event);
    case 'webhook':
      return genericMatches(rule, event);
  }
}

/** One line saying what arrived: "GitHub pull_request opened in acme/api". */
export function describeEvent(event: IncomingEvent): string {
  const p = obj(event.payload);
  const github = event.headers['x-github-event'];
  if (github) {
    const action = str(p['action']);
    const repo = str(obj(p['repository'])['full_name']);
    return `GitHub ${github}${action ? ` ${action}` : ''}${repo ? ` in ${repo}` : ''}`;
  }
  const slack = slackEvent(event);
  if (slack) {
    const channel = str(slack['channel']) ?? str(obj(slack['item'])['channel']);
    return `Slack ${str(slack['type']) ?? 'event'}${channel ? ` in ${channel}` : ''}`;
  }
  if (event.headers['stripe-signature'] && str(p['type'])) return `Stripe ${str(p['type'])}`;
  const type = str(p['type']) ?? str(p['event']) ?? event.headers['x-event-type'];
  return type ? `Event ${type}` : 'Event';
}
