import { TINY_PNG } from '@openbots/computer/testing';
import { DEFAULT_LIMITS, EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { artifactServices, createArtifact, writeArtifact } from '../services/artifacts.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace, updateSettings } from '../workspace.js';

// Artifacts API (plan 12.1, 14.1; A1, A2, A4) over the service that the
// artifact tools also write through.

const Q3_V1 = '# Q3 summary\n\nRevenue grew.\nCosts fell.\n';
const PDF = Uint8Array.from([...new TextEncoder().encode('%PDF-1.7\n%'), 0xe2, 0xe3, 0xcf, 0xd3]);

interface Version {
  version: number;
  summary: string | null;
  createdBy: 'bot' | 'user';
  createdByRunId: string | null;
  createdByUserId: string | null;
  mime: string;
}

describe('Artifacts API', () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let owner: { id: string; workspaceId: string };
  let bot: { id: string; chatId: string };
  let runId: string;
  const events: WsEvent[] = [];

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    const a = await t.signUp('alice@example.com');
    alice = a.cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    bot = (await (await call(alice, 'POST', '/bots', { name: 'Writer' })).json()) as typeof bot;
    const [row] = await t.db.select().from(schema.bots);
    owner = { id: row!.ownerId, workspaceId: row!.workspaceId };
    const [run] = await t.db
      .insert(schema.runs)
      .values({
        workspaceId: owner.workspaceId,
        botId: bot.id,
        chatId: bot.chatId,
        trigger: 'message',
        status: 'running',
      })
      .returning();
    runId = run!.id;
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
  });
  afterAll(() => t.close());

  function call(cookie: string, method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const botWrite = (title = 'Q3 summary', content = Q3_V1) =>
    createArtifact(
      t.ownerDeps,
      owner,
      { title, kind: 'document', content, botId: bot.id, chatId: bot.chatId },
      { runId },
    );

  const versions = async (id: string) =>
    ((await (await call(alice, 'GET', `/artifacts/${id}/versions`)).json()) as { items: Version[] })
      .items;

  it('keeps a version chain and advances the current pointer', async () => {
    const created = await botWrite();
    const id = created.artifact.id;
    expect(created.artifact.currentVersionId).toBe(created.version.id);
    expect(created.version).toMatchObject({ version: 1, summary: '+4 −0', mime: 'text/markdown' });

    const second = await writeArtifact(
      t.ownerDeps,
      owner,
      id,
      { content: `${Q3_V1}Outlook: up.\n` },
      {
        runId,
      },
    );
    expect(second.version.version).toBe(2);
    const res = await call(alice, 'GET', `/artifacts/${id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      botId: bot.id,
      chatId: bot.chatId,
      kind: 'document',
      title: 'Q3 summary',
      currentVersion: { id: second.version.id, version: 2, summary: '+1 −0', createdBy: 'bot' },
    });
    expect((await versions(id)).map((v) => v.version)).toEqual([2, 1]);

    const payloads = events
      .filter((e) => e.type.startsWith('artifact.') && e.payload.artifactId === id)
      .map((e) => ({ type: e.type, chat: e.chat_id, bot: e.bot_id, ...e.payload }));
    expect(payloads).toEqual([
      expect.objectContaining({
        type: 'artifact.created',
        chat: bot.chatId,
        bot: bot.id,
        version: 1,
      }),
      expect.objectContaining({ type: 'artifact.updated', title: 'Q3 summary', version: 2 }),
    ]);
  });

  it('applies unified-diff patches and summarises the diff', async () => {
    const { artifact } = await botWrite();
    const patch =
      '@@ -3,2 +3,3 @@\n-Revenue grew.\n+Revenue grew 12%.\n+Margin improved.\n Costs fell.\n';
    const written = await writeArtifact(t.ownerDeps, owner, artifact.id, { patch }, { runId });
    expect(written).toMatchObject({ added: 2, removed: 1, version: { summary: '+2 −1' } });
    const content = await call(alice, 'GET', `/artifacts/${artifact.id}/versions/2/content`);
    expect(await content.text()).toBe(
      '# Q3 summary\n\nRevenue grew 12%.\nMargin improved.\nCosts fell.\n',
    );

    const stale = writeArtifact(t.ownerDeps, owner, artifact.id, { patch }, { runId });
    await expect(stale).rejects.toMatchObject({ status: 400, code: 'INVALID_PATCH' });
    expect((await versions(artifact.id)).map((v) => v.version)).toEqual([2, 1]);
  });

  it('attributes an owner edit to the user', async () => {
    const { artifact } = await botWrite();
    const edit = await call(alice, 'PUT', `/artifacts/${artifact.id}`, {
      content: Q3_V1.replace('Costs fell.', 'Costs fell 3%.'),
      baseVersion: 1,
    });
    expect(edit.status).toBe(200);
    const body = (await edit.json()) as { currentVersion: Version };
    expect(body.currentVersion).toMatchObject({
      version: 2,
      summary: '+1 −1',
      createdBy: 'user',
      createdByRunId: null,
      createdByUserId: owner.id,
    });
    expect(
      (await versions(artifact.id)).map((v) => [
        v.version,
        v.createdBy,
        v.createdByRunId,
        v.summary,
      ]),
    ).toEqual([
      [2, 'user', null, '+1 −1'],
      [1, 'bot', runId, '+4 −0'],
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'artifact.updated',
      payload: { artifactId: artifact.id, version: 2, createdBy: 'user' },
    });

    const conflict = await call(alice, 'PUT', `/artifacts/${artifact.id}`, {
      content: 'late',
      baseVersion: 1,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('downloads the current version or one by number', async () => {
    const { artifact } = await botWrite('Q3 summary');
    await writeArtifact(
      t.ownerDeps,
      owner,
      artifact.id,
      { content: '# Q3 summary\n\nv2\n' },
      { runId },
    );

    const current = await call(alice, 'GET', `/artifacts/${artifact.id}/download`);
    expect(current.status).toBe(200);
    expect(await current.text()).toBe('# Q3 summary\n\nv2\n');
    expect(current.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''Q3%20summary.md",
    );
    expect(current.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(current.headers.get('x-content-type-options')).toBe('nosniff');

    const first = await call(alice, 'GET', `/artifacts/${artifact.id}/download?version=1`);
    expect(await first.text()).toBe(Q3_V1);
    expect((await call(alice, 'GET', `/artifacts/${artifact.id}/download?version=9`)).status).toBe(
      404,
    );
  });

  it("lists a Bot's Artifacts, most recently updated first", async () => {
    const other = (await (await call(alice, 'POST', '/bots', { name: 'Coder' })).json()) as {
      id: string;
    };
    const res0 = await call(alice, 'GET', `/bots/${other.id}/artifacts`);
    expect(await res0.json()).toEqual({ items: [] });

    const older = await botWrite('Older');
    const newer = await botWrite('Newer');
    await writeArtifact(t.ownerDeps, owner, older.artifact.id, { content: 'touched\n' }, { runId });
    const res = await call(alice, 'GET', `/bots/${bot.id}/artifacts`);
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: { id: string; currentVersion: Version }[] })
      .items;
    const ids = items.map((i) => i.id);
    expect(ids.indexOf(older.artifact.id)).toBeLessThan(ids.indexOf(newer.artifact.id));
    expect(items[0]).toMatchObject({ id: older.artifact.id, currentVersion: { version: 2 } });
  });

  it("answers 404 for another user's Artifact or Bot", async () => {
    const { artifact } = await botWrite();
    for (const path of [
      `/artifacts/${artifact.id}`,
      `/artifacts/${artifact.id}/versions`,
      `/artifacts/${artifact.id}/versions/1/content`,
      `/artifacts/${artifact.id}/download`,
      `/bots/${bot.id}/artifacts`,
    ]) {
      expect((await call(bob, 'GET', path)).status, path).toBe(404);
    }
    expect((await call(bob, 'PUT', `/artifacts/${artifact.id}`, { content: 'x' })).status).toBe(
      404,
    );
    expect((await versions(artifact.id)).length).toBe(1);
  });
  const binaryWrite = (title: string, kind: 'design' | 'file', bytes: Uint8Array) =>
    createArtifact(
      t.ownerDeps,
      owner,
      { title, kind, bytes, botId: bot.id, chatId: bot.chatId },
      { runId },
    );

  it('stores binary versions as their bytes with the type they show (A1, A3)', async () => {
    const png = await binaryWrite('Logo.png', 'design', TINY_PNG);
    expect(png.version).toMatchObject({
      mime: 'image/png',
      size: TINY_PNG.byteLength,
      summary: null,
    });
    expect(png).toMatchObject({ added: null, removed: null });
    const content = await call(alice, 'GET', `/artifacts/${png.artifact.id}/versions/1/content`);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''Logo.png");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(TINY_PNG);

    const pdf = await binaryWrite('Q3 deck', 'file', PDF);
    expect(pdf.version.mime).toBe('application/pdf');
    const download = await call(alice, 'GET', `/artifacts/${pdf.artifact.id}/download`);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(download.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''Q3%20deck.pdf",
    );
    expect(download.headers.get('content-length')).toBe(String(PDF.byteLength));
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(PDF);

    // A title's extension is a claim the bytes must back up.
    const fake = await binaryWrite('photo.png', 'file', Uint8Array.from([1, 0, 2]));
    expect(fake.version.mime).toBe('application/octet-stream');
    const next = await writeArtifact(
      t.ownerDeps,
      owner,
      fake.artifact.id,
      { bytes: TINY_PNG },
      { runId },
    );
    expect(next.version).toMatchObject({ version: 2, mime: 'image/png', summary: null });
  });

  it('keeps SVG an attachment under a sandbox, viewed through <img>', async () => {
    const svg = await createArtifact(
      t.ownerDeps,
      owner,
      {
        title: 'Mark',
        kind: 'design',
        content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      },
      { runId },
    );
    expect(svg.version.mime).toBe('image/svg+xml');
    const res = await call(alice, 'GET', `/artifacts/${svg.artifact.id}/versions/1/content`);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps bytes out of the text kinds and patches off binary versions', async () => {
    await expect(
      createArtifact(
        t.ownerDeps,
        owner,
        { title: 'x.md', kind: 'document', bytes: PDF },
        { runId },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'NOT_TEXT' });
    const { artifact } = await botWrite();
    await expect(
      writeArtifact(t.ownerDeps, owner, artifact.id, { bytes: TINY_PNG }, { runId }),
    ).rejects.toMatchObject({ status: 409, code: 'NOT_TEXT' });

    const png = await binaryWrite('chart.png', 'design', TINY_PNG);
    await expect(
      writeArtifact(
        t.ownerDeps,
        owner,
        png.artifact.id,
        { patch: '@@ -1 +1 @@\n-a\n+b\n' },
        { runId },
      ),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_PATCH' });
  });

  it('lets the owner edit only document, code and data', async () => {
    const png = await binaryWrite('Logo.png', 'design', TINY_PNG);
    const svg = await createArtifact(
      t.ownerDeps,
      owner,
      { title: 'Mark', kind: 'design', content: '<svg></svg>' },
      { runId },
    );
    for (const id of [png.artifact.id, svg.artifact.id]) {
      const res = await call(alice, 'PUT', `/artifacts/${id}`, { content: '<svg/>' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'NOT_EDITABLE',
        title:
          'Only document, code and data Artifacts can be edited here. Download this design to change it.',
      });
      expect((await versions(id)).length).toBe(1);
    }
    const code = await createArtifact(
      t.ownerDeps,
      owner,
      { title: 'main.py', kind: 'code', content: 'print(1)\n' },
      { runId },
    );
    expect(
      (await call(alice, 'PUT', `/artifacts/${code.artifact.id}`, { content: 'print(2)\n' }))
        .status,
    ).toBe(200);
  });

  it('caps every version at the upload limit', async () => {
    const workspace = await ensureWorkspace(t.db);
    await updateSettings(t.db, workspace, { limits: { uploadBytes: 32 } });
    try {
      await expect(binaryWrite('big.png', 'design', new Uint8Array(33))).rejects.toMatchObject({
        status: 413,
        code: 'FILE_TOO_LARGE',
      });
      const { artifact } = await botWrite('Short', 'short\n');
      const res = await call(alice, 'PUT', `/artifacts/${artifact.id}`, {
        content: 'x'.repeat(33),
      });
      expect(res.status).toBe(413);
    } finally {
      await updateSettings(t.db, await ensureWorkspace(t.db), {
        limits: { uploadBytes: DEFAULT_LIMITS.uploadBytes },
      });
    }
  });

  it('gives the tools text, or bytes and a note for a binary version', async () => {
    const services = artifactServices(
      t.ownerDeps,
      { id: runId, chatId: bot.chatId },
      { id: bot.id, ownerId: owner.id, workspaceId: owner.workspaceId },
    );
    const written = await services.create({ title: 'shot.png', kind: 'design', bytes: TINY_PNG });
    const read = await services.read(written.artifact_id);
    expect(read).toMatchObject({ mime: 'image/png', size: TINY_PNG.byteLength });
    expect(read.content).toBeUndefined();
    expect(read.note).toMatch(/binary file/);
    const bytes = await services.readBytes(written.artifact_id);
    expect(bytes).toMatchObject({ mime: 'image/png', version: 1 });
    expect(bytes.bytes).toEqual(TINY_PNG);

    const doc = await services.create({ title: 'Notes', kind: 'document', content: '# Hi\n' });
    expect(await services.read(doc.artifact_id)).toMatchObject({ content: '# Hi\n', size: 5 });
    expect(new TextDecoder().decode((await services.readBytes(doc.artifact_id)).bytes)).toBe(
      '# Hi\n',
    );
    expect(await services.byteLimit?.()).toBe(DEFAULT_LIMITS.uploadBytes);
  });
});
