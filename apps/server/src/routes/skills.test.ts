import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace, updateSettings } from '../workspace.js';

interface Skill {
  id: string;
  name: string;
  slug: string;
  summary: string;
  content: string;
  source: string;
  usedBy: { id: string; name: string; handle: string }[];
}

describe('Skills API', () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let bot: { id: string; handle: string };
  let other: { id: string };

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    bot = (await (await call(alice, 'POST', '/bots', { name: 'Ada' })).json()) as typeof bot;
    other = (await (await call(bob, 'POST', '/bots', { name: 'Bo' })).json()) as typeof other;
  });
  afterAll(() => t.close());

  function call(cookie: string, method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const json = async <T = Skill>(res: Response) => (await res.json()) as T;

  it('writes a Skill with a name and content', async () => {
    const res = await call(alice, 'POST', '/skills', {
      name: ' Weekly report ',
      content: '# Weekly report\n\nEvery Friday\nafternoon.\n\n1. List merged PRs',
    });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({
      name: 'Weekly report',
      slug: 'weekly-report',
      summary: 'Every Friday',
      content: '# Weekly report\n\nEvery Friday\nafternoon.\n\n1. List merged PRs',
      source: 'manual',
      // On for every one of the owner's Bots.
      usedBy: [{ id: bot.id, name: 'Ada', handle: bot.handle }],
    });

    // Content is optional, and slugs stay unique per library.
    const twin = await json(await call(alice, 'POST', '/skills', { name: 'Weekly report' }));
    expect(twin).toMatchObject({ slug: 'weekly-report-2', content: '', summary: '' });
    // Another account has its own library (S2).
    expect((await json(await call(bob, 'POST', '/skills', { name: 'Weekly report' }))).slug).toBe(
      'weekly-report',
    );
    expect((await call(alice, 'DELETE', `/skills/${twin.id}`)).status).toBe(204);
  });

  it('edits the name and content, and deletes', async () => {
    const skill = await json(
      await call(alice, 'POST', '/skills', { name: 'Triage', content: 'New issues.' }),
    );
    const renamed = await json(
      await call(alice, 'PATCH', `/skills/${skill.id}`, { name: 'Issue triage' }),
    );
    // Content not sent keeps its text.
    expect(renamed).toMatchObject({
      name: 'Issue triage',
      slug: 'issue-triage',
      content: 'New issues.',
    });
    const edited = await json(
      await call(alice, 'PATCH', `/skills/${skill.id}`, { content: '1. Label\n2. Assign' }),
    );
    expect(edited).toMatchObject({ content: '1. Label\n2. Assign', summary: '1. Label' });

    expect((await call(alice, 'PATCH', `/skills/${skill.id}`, { status: 'ready' })).status).toBe(
      400,
    );
    expect(
      (await call(alice, 'PATCH', `/skills/${skill.id}`, { content: 'x'.repeat(100_001) })).status,
    ).toBe(400);
    expect((await call(bob, 'GET', `/skills/${skill.id}`)).status).toBe(404);
    expect((await call(bob, 'PATCH', `/skills/${skill.id}`, { name: 'Mine' })).status).toBe(404);
    expect((await call(bob, 'DELETE', `/skills/${skill.id}`)).status).toBe(404);
    expect((await call(alice, 'DELETE', `/skills/${skill.id}`)).status).toBe(204);
    expect((await call(alice, 'GET', `/skills/${skill.id}`)).status).toBe(404);
  });

  it("is on for every one of the owner's Bots, including Bots made later", async () => {
    const skill = await json(await call(alice, 'POST', '/skills', { name: 'Everywhere' }));
    expect(skill).toMatchObject({
      usedBy: [{ id: bot.id, name: 'Ada', handle: bot.handle }],
      blockedBotIds: [],
    });
    const later = await json<{ id: string; handle: string }>(
      await call(alice, 'POST', '/bots', { name: 'Zed' }),
    );
    expect((await json(await call(alice, 'GET', `/skills/${skill.id}`))).usedBy).toEqual([
      { id: bot.id, name: 'Ada', handle: bot.handle },
      { id: later.id, name: 'Zed', handle: later.handle },
    ]);
    // Another account neither sees it nor gets it.
    const theirs = await json<{ items: Skill[] }>(await call(bob, 'GET', '/skills'));
    expect(theirs.items.some((s) => s.id === skill.id)).toBe(false);

    expect((await call(alice, 'DELETE', `/skills/${skill.id}`)).status).toBe(204);
    expect((await call(alice, 'DELETE', `/bots/${later.id}`)).status).toBeLessThan(300);
  });

  it('turns a Skill off per Bot with its blocklist', async () => {
    const zed = await json<{ id: string; handle: string }>(
      await call(alice, 'POST', '/bots', { name: 'Zed' }),
    );
    const skill = await json(await call(alice, 'POST', '/skills', { name: 'Alpha' }));
    const beta = await json(await call(alice, 'POST', '/skills', { name: 'Beta' }));
    const theirs = await json(await call(bob, 'POST', '/skills', { name: 'Theirs' }));

    const blocked = await call(alice, 'PUT', `/skills/${skill.id}/blocked-bots`, {
      botIds: [bot.id, bot.id],
    });
    expect(blocked.status).toBe(200);
    expect(await json(blocked)).toMatchObject({
      usedBy: [{ id: zed.id, name: 'Zed', handle: zed.handle }],
      blockedBotIds: [bot.id],
    });
    // Only that Skill: the others stay on for Ada.
    const list = await json<{ items: (Skill & { blockedBotIds: string[] })[] }>(
      await call(alice, 'GET', '/skills'),
    );
    expect(list.items.find((s) => s.id === beta.id)!.blockedBotIds).toEqual([]);

    // Replacing the list turns Ada back on and Zed off; an empty list turns all back on.
    const swapped = await json(
      await call(alice, 'PUT', `/skills/${skill.id}/blocked-bots`, { botIds: [zed.id] }),
    );
    expect(swapped).toMatchObject({
      usedBy: [{ id: bot.id, name: 'Ada', handle: bot.handle }],
      blockedBotIds: [zed.id],
    });
    const cleared = await json(
      await call(alice, 'PUT', `/skills/${skill.id}/blocked-bots`, { botIds: [] }),
    );
    expect(cleared.usedBy.map((b) => b.id)).toEqual([bot.id, zed.id]);

    // Someone else's Bot or Skill is not found, and changes nothing.
    expect(
      (await call(alice, 'PUT', `/skills/${skill.id}/blocked-bots`, { botIds: [other.id] })).status,
    ).toBe(404);
    expect(
      (await call(alice, 'PUT', `/skills/${theirs.id}/blocked-bots`, { botIds: [] })).status,
    ).toBe(404);
    expect(
      (await call(bob, 'PUT', `/skills/${skill.id}/blocked-bots`, { botIds: [] })).status,
    ).toBe(404);
    expect((await json(await call(alice, 'GET', `/skills/${skill.id}`))).usedBy).toHaveLength(2);

    for (const id of [skill.id, beta.id]) {
      expect((await call(alice, 'DELETE', `/skills/${id}`)).status).toBe(204);
    }
    expect((await call(alice, 'DELETE', `/bots/${zed.id}`)).status).toBeLessThan(300);
  });

  it('caps the library at the Skills-per-account limit', async () => {
    const carol = (await t.signUp('carol@example.com')).cookie!;
    const limit = async (skillsPerAccount: number) =>
      updateSettings(t.db, await ensureWorkspace(t.db), { limits: { skillsPerAccount } });
    await limit(3);
    try {
      for (const name of ['One', 'Two', 'Three']) {
        expect((await call(carol, 'POST', '/skills', { name })).status).toBe(201);
      }
      const res = await call(carol, 'POST', '/skills', { name: 'Four' });
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ code: 'SKILL_LIMIT_REACHED' });
      // The limit is per account: Bob, with two Skills, still has room.
      expect((await call(bob, 'POST', '/skills', { name: 'Third' })).status).toBe(201);
    } finally {
      await limit(200);
    }
  });
});
