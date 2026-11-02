import { localEmbedder, localEmbedding, type Embedder } from '@openbots/agent';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';
import {
  contextMemories,
  MEMORIES_QUEUE,
  queueReembedIfStale,
  reembedHandler,
  reembedMemories,
  saveMemory,
  searchMemories,
  type ReembedJob,
} from './memories.js';

// Embedding sources (M1): each memory records what embedded it, a query is
// compared only with memories of its own source, and memories of another
// source are re-embedded in the background once the Bot's source changes.

const OPENAI = 'openai:text-embedding-3-small';

/** Embeds like the local source but reports `source`, as a model would. */
const tagged = (id: string, source = id): Embedder => ({
  id,
  embed: async (texts) => ({ source, vectors: texts.map((t) => localEmbedding(t)) }),
});

describe('memory embedding sources', () => {
  let t: TestApp;
  let botId: string;
  let workspaceId: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    const cookie = (await t.signUp('dana@example.com')).cookie!;
    const res = await t.app.request('/api/v1/bots', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mem' }),
    });
    const bot = (await res.json()) as { id: string };
    botId = bot.id;
    const [row] = await t.db.select().from(schema.bots).where(eq(schema.bots.id, botId));
    workspaceId = row!.workspaceId;
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.db.delete(schema.botMemories);
  });

  const save = (content: string, embedder: Embedder) =>
    saveMemory(t.ownerDeps, { botId, workspaceId, kind: 'fact', content }, embedder);

  const sources = async () =>
    Object.fromEntries(
      (await t.db.select().from(schema.botMemories)).map((m) => [m.content, m.embeddingModel]),
    );

  it('records the source and compares a query only with memories of that source', async () => {
    await save('Deploys on Thursdays', tagged(OPENAI));
    await save('Deploys on Fridays', localEmbedder);
    // A model call that fell back to the local embedding is recorded as local.
    await save('Deploys at noon', tagged(OPENAI, 'local'));
    expect(await sources()).toEqual({
      'Deploys on Thursdays': OPENAI,
      'Deploys on Fridays': 'local',
      'Deploys at noon': 'local',
    });

    const search = async (embedder: Embedder) =>
      (await searchMemories(t.ownerDeps, botId, 'deploys', 10, embedder))
        .map((m) => m.content)
        .sort();
    expect(await search(tagged(OPENAI))).toEqual(['Deploys on Thursdays']);
    expect(await search(localEmbedder)).toEqual(['Deploys at noon', 'Deploys on Fridays']);
    // The query fell back too, so it is compared with the local memories.
    expect(await search(tagged(OPENAI, 'local'))).toEqual([
      'Deploys at noon',
      'Deploys on Fridays',
    ]);
  });

  it('re-embeds stale memories, and stops when the model falls back', async () => {
    await save('Deploys on Thursdays', tagged(OPENAI));
    await save('Deploys on Fridays', localEmbedder);
    await t.db
      .insert(schema.botMemories)
      .values({ workspaceId, botId, kind: 'fact', content: 'From before sources' });

    expect(await reembedMemories(t.ownerDeps, botId, tagged(OPENAI, 'local'))).toBe(0);
    expect((await sources())['Deploys on Fridays']).toBe('local');

    expect(await reembedMemories(t.ownerDeps, botId, tagged(OPENAI))).toBe(2);
    const rows = await t.db.select().from(schema.botMemories);
    expect(rows.every((m) => m.embeddingModel === OPENAI)).toBe(true);
    const legacy = rows.find((m) => m.content === 'From before sources')!;
    expect(legacy.embedding).toHaveLength(1536);
    expect(await queueReembedIfStale(t.ownerDeps, botId, OPENAI)).toBe(false);
  });

  it('queues the re-embed from context assembly when the source changed', async () => {
    const jobs: ReembedJob[] = [];
    const handler = reembedHandler(t.deps, async () => tagged(OPENAI));
    await t.deps.infra.queue<ReembedJob>(MEMORIES_QUEUE).process(async (job) => {
      jobs.push(job.data);
      await handler(job);
    });
    await save('Deploys on Fridays', localEmbedder);

    // Still the old source: nothing is stale, nothing is queued.
    await contextMemories(t.ownerDeps, botId, 'deploys', localEmbedder);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(jobs).toEqual([]);

    // The Bot now embeds with OpenAI: its local memory is re-embedded in the background.
    await contextMemories(t.ownerDeps, botId, 'deploys', tagged(OPENAI));
    for (let i = 0; i < 100 && (await sources())['Deploys on Fridays'] !== OPENAI; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(jobs).toEqual([{ botId, source: OPENAI, workspaceId: expect.any(String) }]);
    expect(await sources()).toEqual({ 'Deploys on Fridays': OPENAI });
  });

  it("skips a job whose source is no longer the Bot's", async () => {
    await save('Deploys on Fridays', localEmbedder);
    const handler = reembedHandler(t.deps, async () => localEmbedder);
    await handler({ id: 'j', name: 'reembed', priority: 3, data: { botId, source: OPENAI } });
    expect(await sources()).toEqual({ 'Deploys on Fridays': 'local' });
  });
});
