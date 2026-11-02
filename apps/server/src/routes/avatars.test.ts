import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';

const FILE = '00000000-0000-4000-8000-000000000001';

describe('GET /api/v1/bots/{id}/avatar.png', () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let botId: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    const res = await t.app.request('/api/v1/bots', {
      method: 'POST',
      headers: { cookie: alice, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', avatar: { kind: 'generated', seed: 'ada' } }),
    });
    botId = ((await res.json()) as { id: string }).id;
  });
  afterAll(() => t.close());

  const get = (cookie: string | undefined, query = '') =>
    t.app.request(`/api/v1/bots/${botId}/avatar.png${query}`, {
      headers: cookie ? { cookie } : {},
    });

  it('renders the generated avatar at the requested size', async () => {
    const res = await get(alice, '?size=64');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(64);
  });

  it('defaults to 128 px and rejects sizes out of range', async () => {
    const png = Buffer.from(await (await get(alice)).arrayBuffer());
    expect(png.readUInt32BE(16)).toBe(128);
    expect((await get(alice, '?size=4096')).status).toBe(400);
  });

  it("answers 404 for another user's Bot and 401 without a session", async () => {
    expect((await get(bob)).status).toBe(404);
    expect((await get(undefined)).status).toBe(401);
  });

  it('redirects an uploaded avatar to its file', async () => {
    await t.db
      .update(schema.bots)
      .set({ avatar: { kind: 'upload', file_id: FILE } })
      .where(eq(schema.bots.id, botId));
    const res = await get(alice);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/api/v1/files/${FILE}`);
  });
});
