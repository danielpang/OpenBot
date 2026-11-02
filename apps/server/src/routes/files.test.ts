import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { sniffMime, storeFile } from '../services/files.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace } from '../workspace.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe('/api/v1/files', () => {
  let t: TestApp;
  let dir: string;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'openbots-files-'));
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
      OPENBOTS_FILES_DIR: dir,
      OPENBOTS_LIMITS_UPLOAD_BYTES: '1024',
    });
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
  });
  afterAll(async () => {
    await t.close();
    await rm(dir, { recursive: true, force: true });
  });

  const upload = (
    cookie: string,
    bytes: Uint8Array,
    name: string,
    type: string,
    purpose?: string,
  ) => {
    const form = new FormData();
    form.set('file', new File([bytes], name, { type }));
    if (purpose) form.set('purpose', purpose);
    return t.app.request('/api/v1/files', { method: 'POST', headers: { cookie }, body: form });
  };

  interface FileBody {
    id: string;
    name: string;
    mime: string;
    size: number;
    sha256: string;
  }

  it('stores an upload with its sha256 and sniffed type, and serves it to the owner', async () => {
    const res = await upload(alice, PNG, 'cat.png', 'image/png');
    expect(res.status).toBe(201);
    const file = (await res.json()) as FileBody;
    expect(file).toMatchObject({
      name: 'cat.png',
      mime: 'image/png',
      size: PNG.byteLength,
      sha256: createHash('sha256').update(PNG).digest('hex'),
    });
    const shards = await readdir(dir);
    expect(shards).toHaveLength(1);

    const got = await t.app.request(`/api/v1/files/${file.id}`, { headers: { cookie: alice } });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
  });

  it("answers 404 for another user's file and 401 without a caller", async () => {
    const file = (await (await upload(alice, PNG, 'a.png', 'image/png')).json()) as FileBody;
    expect(
      (await t.app.request(`/api/v1/files/${file.id}`, { headers: { cookie: bob } })).status,
    ).toBe(404);
    expect((await t.app.request(`/api/v1/files/${file.id}`)).status).toBe(401);
  });

  it('does not trust a declared type the bytes contradict', async () => {
    const html = new TextEncoder().encode('<script>alert(1)</script>');
    const file = (await (await upload(alice, html, 'x.png', 'image/png')).json()) as FileBody;
    expect(file.mime).toBe('text/plain');
    const got = await t.app.request(`/api/v1/files/${file.id}`, { headers: { cookie: alice } });
    // The route's own CSP, not the app-wide one (app.ts securityHeaders).
    expect(got.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('serves non-inline types as downloads and cleans the name', async () => {
    const bytes = new TextEncoder().encode('<h1>hi</h1>');
    const res = await upload(alice, bytes, '../../etc/page.html', 'text/html');
    const file = (await res.json()) as FileBody;
    expect(file).toMatchObject({ name: 'page.html', mime: 'text/html' });
    const got = await t.app.request(`/api/v1/files/${file.id}`, { headers: { cookie: alice } });
    expect(got.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('refuses files over the upload limit and requests without a file', async () => {
    const res = await upload(alice, new Uint8Array(2048), 'big.bin', 'application/octet-stream');
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe('FILE_TOO_LARGE');
    const empty = await t.app.request('/api/v1/files', {
      method: 'POST',
      headers: { cookie: alice },
      body: new FormData(),
    });
    expect(empty.status).toBe(400);
  });

  it('takes avatar uploads as raster images only', async () => {
    const png = await upload(alice, PNG, 'face.png', 'image/png', 'avatar');
    expect(png.status).toBe(201);
    const pdf = new TextEncoder().encode('%PDF-1.7');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    for (const [bytes, name, type] of [
      [pdf, 'face.pdf', 'application/pdf'],
      [svg, 'face.svg', 'image/svg+xml'],
    ] as const) {
      const res = await upload(alice, bytes, name, type, 'avatar');
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_AVATAR');
    }
    expect((await upload(alice, PNG, 'x.png', 'image/png', 'artifact')).status).toBe(400);
  });

  describe('GET /files', () => {
    interface Page {
      items: (FileBody & { createdAt: string; chat: Record<string, unknown> | null })[];
      nextCursor: string | null;
    }
    const list = async (cookie: string, query = '') => {
      const res = await t.app.request(`/api/v1/files${query}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      return (await res.json()) as Page;
    };

    it("lists the caller's attachments with their chat, and no internal blobs", async () => {
      const carol = (await t.signUp('carol@example.com')).cookie!;
      const json = { cookie: carol, 'content-type': 'application/json' };
      const bot = (await (
        await t.app.request('/api/v1/bots', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ name: 'Ada' }),
        })
      ).json()) as { id: string; chatId: string };
      const sent = (await (await upload(carol, PNG, 'sent.png', 'image/png')).json()) as FileBody;
      const unsent = (await (
        await upload(carol, new TextEncoder().encode('draft'), 'draft.txt', 'text/plain')
      ).json()) as FileBody;
      await upload(carol, PNG, 'face.png', 'image/png', 'avatar');
      const carolUser = (await t.db.select().from(schema.users)).find(
        (u) => u.email === 'carol@example.com',
      )!;
      const owner = { id: carolUser.id, workspaceId: (await ensureWorkspace(t.db)).id };
      for (const purpose of ['artifact', 'webhook_body'] as const) {
        await storeFile(t.ownerDeps, owner, { name: purpose, bytes: PNG, purpose });
      }
      const res = await t.app.request(`/api/v1/chats/${bot.chatId}/messages`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ attachments: [sent.id] }),
      });
      expect(res.status).toBe(201);

      const page = await list(carol);
      expect(page.nextCursor).toBeNull();
      expect(page.items.map((f) => f.name)).toEqual(['draft.txt', 'sent.png']);
      expect(page.items[0]).toMatchObject({ id: unsent.id, size: 5, chat: null });
      expect(page.items[1]!.chat).toEqual({
        id: bot.chatId,
        type: 'bot_dm',
        botId: bot.id,
        name: 'Ada',
      });

      const first = await list(carol, '?limit=1');
      expect(first.items.map((f) => f.id)).toEqual([unsent.id]);
      expect(first.nextCursor).toBe(unsent.id);
      const second = await list(carol, `?limit=1&cursor=${first.nextCursor}`);
      expect(second.items.map((f) => f.id)).toEqual([sent.id]);
      expect(second.nextCursor).toBeNull();

      expect((await list(bob)).items.map((f) => f.name)).not.toContain('sent.png');
      expect((await t.app.request('/api/v1/files')).status).toBe(401);
    });
  });
});

describe('sniffMime', () => {
  it('reads magic bytes and keeps a specific declared zip type', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(new TextEncoder().encode('%PDF-1.7'), 'text/plain')).toBe('application/pdf');
    expect(sniffMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
    expect(sniffMime(zip)).toBe('application/zip');
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(sniffMime(zip, docx)).toBe(docx);
  });

  it('falls back to text or binary', () => {
    expect(sniffMime(new TextEncoder().encode('a,b\n1,2'), 'text/csv; charset=utf-8')).toBe(
      'text/csv',
    );
    expect(sniffMime(new Uint8Array([1, 0, 2]), 'text/plain')).toBe('application/octet-stream');
    expect(sniffMime(new Uint8Array([1, 0, 2]))).toBe('application/octet-stream');
    expect(sniffMime(new TextEncoder().encode('hello'))).toBe('text/plain');
  });
});
