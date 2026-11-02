import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';

// Bots belong to the member who made them (U2). Every route under
// /bots/{id} in the OpenAPI document is tried by another member, the
// workspace admin included, against a Bot they do not own: each must refuse
// without echoing the Bot, and the Bot must stay out of their lists.

const spec = JSON.parse(
  readFileSync(new URL('../../../../packages/api-client/openapi.json', import.meta.url), 'utf8'),
) as { paths: Record<string, Record<string, unknown>> };

const botRoutes = Object.entries(spec.paths)
  .filter(([path]) => /^\/api\/v1\/bots\/\{id\}/.test(path))
  .flatMap(([path, ops]) => Object.keys(ops).map((method) => ({ method, path })));

const SAMPLE_BODIES: Record<string, unknown> = {
  'patch /api/v1/bots/{id}': { name: 'Taken' },
  'post /api/v1/bots/{id}/memories': { content: 'a fact', kind: 'fact' },
  'patch /api/v1/bots/{id}/memories/{memoryId}': { content: 'changed' },
  'put /api/v1/bots/{id}/connectors': { items: [] },
  'put /api/v1/bots/{id}/skills': { skillIds: [] },
  'post /api/v1/bots/{id}/screen/control': { action: 'take' },
  'post /api/v1/bots/{id}/routines': {
    name: 'Daily',
    prompt: 'Report',
    trigger: { type: 'schedule', preset: { kind: 'daily', time: '08:00' } },
  },
  'post /api/v1/bots/{id}/endpoints': {},
};

describe('Bots are visible only to their owner (U2)', () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  const bots: Record<'alice' | 'bob', { id: string; name: string; chatId: string }> = {} as never;

  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    t.app.request(path, {
      method: method.toUpperCase(),
      headers: {
        origin: ORIGIN,
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    alice = (await t.signUp('alice@example.com')).cookie!; // first user: the admin
    bob = (await t.signUp('bob@example.com')).cookie!;
    for (const [who, cookie, name] of [
      ['alice', alice, 'Alice Secret Bot'],
      ['bob', bob, 'Bob Secret Bot'],
    ] as const) {
      const res = await call(cookie, 'post', '/api/v1/bots', { name, modelConfig: null });
      expect(res.status, await res.clone().text()).toBe(201);
      const bot = (await res.json()) as { id: string; name: string; chatId: string };
      bots[who] = bot;
      await call(cookie, 'post', `/api/v1/bots/${bot.id}/memories`, {
        content: `${name} remembers this`,
        kind: 'fact',
      });
    }
  });
  afterAll(() => t.close());

  it('covers every per-Bot route in the API', () => {
    expect(botRoutes.length).toBeGreaterThan(20);
  });

  for (const [viewer, owner] of [
    ['bob', 'alice'],
    ['alice', 'bob'],
  ] as const) {
    it(`refuses every per-Bot route to ${viewer} on ${owner}'s Bot, without echoing it`, async () => {
      const cookie = viewer === 'alice' ? alice : bob;
      const target = bots[owner];
      const allowed: string[] = [];
      for (const { method, path } of botRoutes) {
        const url = path
          .replace('{id}', target.id)
          .replace('{memoryId}', '00000000-0000-4000-8000-000000000000');
        const res = await call(cookie, method, url, SAMPLE_BODIES[`${method} ${path}`]);
        const text = await res.text();
        if (![403, 404].includes(res.status)) allowed.push(`${method} ${path} -> ${res.status}`);
        expect(text, `${method} ${path}`).not.toContain(target.name);
        expect(text, `${method} ${path}`).not.toContain('remembers this');
      }
      expect(allowed).toEqual([]);
      // The owner still has the Bot, unchanged.
      const ownerCookie = owner === 'alice' ? alice : bob;
      const mine = await call(ownerCookie, 'get', `/api/v1/bots/${target.id}`);
      expect(mine.status).toBe(200);
      expect(((await mine.json()) as { name: string }).name).toBe(target.name);
    });

    it(`keeps ${owner}'s Bot and its transcript out of ${viewer}'s lists`, async () => {
      const cookie = viewer === 'alice' ? alice : bob;
      const target = bots[owner];
      for (const path of ['/api/v1/bots', '/api/v1/chats']) {
        const text = await (await call(cookie, 'get', path)).text();
        expect(text, path).not.toContain(target.id);
        expect(text, path).not.toContain(target.name);
      }
      const chat = await call(cookie, 'get', `/api/v1/chats/${target.chatId}/messages`);
      expect([403, 404]).toContain(chat.status);
    });
  }
});
