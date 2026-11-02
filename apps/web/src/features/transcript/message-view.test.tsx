import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { catalogQuery, connectorsQuery } from '../tools/api.js';
import { ActivityList } from './activity-log.js';
import type { Message, Run } from './api.js';
import { MessageView } from './message-view.js';

const bot = { id: 'bot-1', name: 'Ada', avatar: { kind: 'generated' as const, seed: 'ada' } };
const owner = 'user-1';

const message = (over: Partial<Message>): Message => ({
  id: 'm1',
  chatId: 'c',
  seq: 1,
  threadRootId: null,
  authorType: 'bot',
  authorId: bot.id,
  parts: [{ type: 'text', text: 'Hello **there**' }],
  mentions: [],
  mentionEveryone: false,
  runId: 'run-1',
  status: 'complete',
  deltaSeq: 0,
  updatedSeq: 1,
  createdAt: '2026-10-16T00:00:00.000Z',
  ...over,
});

// The owner's connectors and the catalog, as the activity line reads them for its icon.
const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
queryClient.setQueryData(connectorsQuery.queryKey, {
  items: [{ id: 'k1', slug: 'github', name: 'GitHub', catalogId: 'github' }],
} as never);
queryClient.setQueryData(catalogQuery.queryKey, {
  items: [{ id: 'github', icon: 'github' }],
} as never);

const render = (m: Message) =>
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MessageView message={m} bot={bot} ownerId={owner} onOpenActivity={() => {}} />
    </QueryClientProvider>,
  );

describe('<MessageView>', () => {
  it('renders an event-only system message as a compact row, not a bubble', () => {
    const html = render(
      message({
        authorType: 'system',
        authorId: null,
        runId: null,
        parts: [
          {
            type: 'event',
            kind: 'blocked',
            text: 'No model is set for this Bot.',
            data: { fix: 'Pick one in Settings.' },
          },
        ],
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('data-event="blocked"');
    expect(html).toContain('No model is set for this Bot.');
    expect(html).toContain('Pick one in Settings.');
    expect(html).not.toContain('data-author');
    expect(html).not.toContain('rounded-2xl');
  });

  it('renders "Computer started" as a compact row with a quiet dot (W3)', () => {
    const html = render(
      message({
        authorType: 'system',
        authorId: null,
        parts: [
          {
            type: 'event',
            kind: 'computer_started',
            text: 'Computer started 4.2s',
            data: { runId: 'run-1', durationMs: 4200 },
          },
        ],
      }),
    );
    expect(html).toContain('data-event="computer_started"');
    expect(html).toContain('Computer started 4.2s');
    expect(html).not.toContain('bg-destructive');
    expect(html).not.toContain('data-author');
    expect(html).not.toContain('>Activity</button>');
  });

  it('renders the Bot as prose beside its avatar with no author prefix, and offers Activity', () => {
    const html = render(message({}));
    expect(html).toContain('data-author="bot"');
    expect(html).toContain('<strong>there</strong>');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('>Activity</button>');
    expect(html).not.toContain('font-medium text-muted-foreground');
  });

  it('shows no Activity control while the reply streams, and the live state on its avatar', () => {
    const html = renderToStaticMarkup(
      <MessageView
        message={message({ status: 'streaming', parts: [] })}
        bot={bot}
        ownerId={owner}
        liveState="working"
        currentAction="Running npm test"
        onOpenActivity={() => {}}
      />,
    );
    expect(html).toContain('data-state="working"');
    expect(html).toContain('title="Running npm test"');
    expect(html).not.toContain('>Activity</button>');
  });

  it('renders the owner as a bubble and other authors with a prefix', () => {
    const mine = render(message({ authorType: 'user', authorId: owner }));
    expect(mine).toContain('data-author="owner"');
    expect(mine).toContain('rounded-2xl');
    expect(mine).not.toContain('Member');

    expect(render(message({ authorType: 'webhook', authorId: null }))).toContain('>Webhook</div>');
    expect(render(message({ authorType: 'routine', authorId: null }))).toContain('>Routine</div>');
    const other = renderToStaticMarkup(
      <MessageView
        message={message({ authorId: 'bot-2' })}
        bot={bot}
        ownerId={owner}
        authorName={() => '@grace'}
      />,
    );
    expect(other).toContain('>@grace</div>');
  });

  it('folds tool activity into one line and reasoning behind a toggle', () => {
    const html = render(
      message({
        parts: [
          { type: 'reasoning', text: 'Let me check.' },
          { type: 'tool_call', tool_call_id: 'a', tool_name: 'edit_file', args: {} },
          {
            type: 'tool_result',
            tool_call_id: 'a',
            tool_name: 'edit_file',
            result: {},
            label: 'Edited math.ts +14 −10',
          },
          { type: 'text', text: 'Fixed.' },
        ],
      }),
    );
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Thought<\/summary>/);
    expect(html).toContain('Edited math.ts +14 −10');
    expect(html).not.toContain('edit_file');
  });

  it("puts the connector's icon before a connector tool's activity line", () => {
    const call = (tool: string, label: string) =>
      render(
        message({
          parts: [{ type: 'tool_call', tool_call_id: 'a', tool_name: tool, args: {}, label }],
        }),
      );
    const github = call('github__create_issue', 'GitHub: Create issue');
    expect(github).toContain('data-icon="github"');
    expect(github).toContain('GitHub: Create issue');
    // A built-in tool, or a connector the owner no longer has, gets no icon.
    expect(call('edit_file', 'Editing math.ts')).not.toContain('data-icon');
    expect(call('gone__search', 'Gone: Search')).not.toContain('data-icon');
  });

  it('renders widgets through the registry, with the fallback for unknown kinds', () => {
    const html = render(
      message({
        parts: [
          {
            type: 'widget',
            kind: 'question',
            props: { question: 'Ship it?' },
            state: { status: 'pending' },
          },
          { type: 'widget', kind: 'sparkline', props: {} },
          { type: 'file', file_id: 'f1', name: 'notes.txt', mime: 'text/plain', size: 10 },
          { type: 'image', file_id: 'f2', name: 'cat.png', mime: 'image/png' },
        ],
      }),
    );
    expect(html).toContain('Ship it?');
    expect(html).toContain('Unknown widget <code>sparkline</code>');
    expect(html).toContain('download="notes.txt"');
    expect(html).toContain('src="/api/v1/files/f2"');
  });
});

describe('<ActivityList>', () => {
  const run: Run = {
    id: 'run-1',
    botId: bot.id,
    chatId: 'c',
    trigger: 'message',
    priority: 1,
    status: 'completed',
    parentRunId: null,
    depth: 0,
    model: 'claude-opus-5-5',
    usage: {
      inputTokens: 1204,
      outputTokens: 318,
      cachedInputTokens: 0,
      steps: 2,
      costUsd: 0.0042,
    },
    error: null,
    waiting: null,
    createdAt: '2026-10-16T00:00:00.000Z',
    startedAt: '2026-10-16T00:00:00.000Z',
    finishedAt: '2026-10-16T00:00:04.000Z',
  };
  const step = (idx: number, type: 'llm' | 'tool_call', label: string, durationMs: number) => ({
    id: `s${idx}`,
    runId: run.id,
    idx,
    type,
    label,
    tokensIn: null,
    tokensOut: null,
    durationMs,
    createdAt: run.createdAt,
  });

  it('lists entries with durations and ends with the time and cost, not the model or tokens', () => {
    const html = renderToStaticMarkup(
      <ActivityList
        run={run}
        steps={[
          step(0, 'tool_call', 'Environment ready', 387),
          step(1, 'llm', 'Thought briefly', 1200),
          step(2, 'tool_call', 'Edited math.ts +14 −10', 40),
        ]}
      />,
    );
    const text = html.replace(/<[^>]+>/g, '|');
    expect(text).toMatch(
      /Environment ready\|+387ms.*Thought briefly\|+Edited math.ts \+14 −10\|+40ms/,
    );
    expect(html).toContain('4.0s · $0.0042');
    expect(html).not.toContain('claude-opus-5-5');
    expect(html).not.toContain('1,204');
    expect(html.indexOf('$0.0042')).toBeGreaterThan(html.indexOf('Edited math.ts'));
  });
});
