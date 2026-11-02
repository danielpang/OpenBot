import { describe, expect, it } from 'vitest';
import { labelFor } from '../activity/labels.js';
import { ATTACHMENT_LIMITS } from '../context/attachments.js';
import { createPolicy } from '../policy/index.js';
import { readAttachment, type AttachmentFile, type AttachmentServices } from './attachments.js';
import { toolFacts, toolsFor } from './index.js';
import type { ToolContext } from './types.js';

// read_attachment and attachment_to_computer (C1, C9): text a page at a time,
// an image to a model that sees it, a description otherwise; offered with the
// server's backend and run without asking.

const run = { id: 'run-1', botId: 'bot-1', chatId: 'chat-1', trigger: 'message' };
const memory = {
  remember: async () => ({ id: 'm', kind: 'fact' as const, content: '' }),
  search: async () => [],
};

function fakeAttachments(
  files: Record<string, { mime: string; bytes: Uint8Array }>,
  vision = true,
) {
  const info = (fileId: string): AttachmentFile => {
    const f = files[fileId];
    if (!f) throw new Error(`No attachment ${fileId} in this chat`);
    return { file_id: fileId, name: `${fileId}.file`, mime: f.mime, size: f.bytes.byteLength };
  };
  const services: AttachmentServices = {
    vision,
    info: async (fileId) => info(fileId),
    read: async (fileId, range) => {
      info(fileId);
      const bytes = files[fileId]!.bytes;
      return range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
    },
  };
  return services;
}

const ctx = (attachments?: AttachmentServices): ToolContext => ({
  run,
  memory,
  ...(attachments ? { attachments } : {}),
});
const read = (args: { file_id: string; offset?: number }, c: ToolContext) =>
  readAttachment.execute(args, c) as Promise<Record<string, unknown>>;

describe('attachment tools', () => {
  it('are offered with the backend, in the artifacts group, and run without asking', () => {
    expect(Object.keys(toolsFor(ctx()))).not.toContain('read_attachment');
    const c = ctx(fakeAttachments({}));
    expect(Object.keys(toolsFor(c))).toEqual(
      expect.arrayContaining(['read_attachment', 'attachment_to_computer']),
    );
    const facts = toolFacts(c);
    const policy = createPolicy({ facts: (n) => facts.get(n) });
    for (const tool of ['read_attachment', 'attachment_to_computer']) {
      expect(facts.get(tool)?.group).toBe('artifacts');
      expect((policy.evaluate(run, tool, {}) as { decision: string }).decision).toBe('auto');
    }
  });

  it('reads a text file a page at a time, on whole characters', async () => {
    const page = ATTACHMENT_LIMITS.textBytes;
    // "é" is two bytes and straddles the end of the first page.
    const text = `${'a'.repeat(page - 1)}é${'b'.repeat(10)}`;
    const c = ctx(
      fakeAttachments({ f1: { mime: 'text/plain', bytes: new TextEncoder().encode(text) } }),
    );
    const first = await read({ file_id: 'f1' }, c);
    expect(first).toMatchObject({ offset: 0, next_offset: page - 1, size: page + 11 });
    expect(first.content).toBe('a'.repeat(page - 1));
    const second = await read({ file_id: 'f1', offset: page - 1 }, c);
    expect(second.content).toBe(`é${'b'.repeat(10)}`);
    expect(second).not.toHaveProperty('next_offset');
    expect(await read({ file_id: 'f1', offset: page + 11 }, c)).toMatchObject({
      content: '',
      note: 'Past the end of the file.',
    });
    expect(labelFor('read_attachment', { file_id: 'f1' }, second)).toBe('Read f1.file');
  });

  it('shows an image to a model with vision, keeping no bytes in the transcript', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const files = { img: { mime: 'image/png', bytes: png } };
    const output = await read({ file_id: 'img' }, ctx(fakeAttachments(files)));
    expect(readAttachment.toModelOutput!(output)).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'Attachment img.file (image/png), file img' },
        {
          type: 'file',
          mediaType: 'image/png',
          data: { type: 'data', data: Buffer.from(png).toString('base64') },
        },
      ],
    });
    expect(readAttachment.transcript!(output)).toEqual({
      file_id: 'img',
      name: 'img.file',
      mime: 'image/png',
      size: 4,
      shown: 'image',
    });
    const blind = await read({ file_id: 'img' }, ctx(fakeAttachments(files, false)));
    expect(blind.note).toBe('Your model cannot see images, so this one cannot be shown.');
    expect(readAttachment.toModelOutput!(blind)).toBeUndefined();
  });

  it('describes a binary file and points at the computer', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n\0\0');
    const out = await read(
      { file_id: 'doc' },
      ctx(fakeAttachments({ doc: { mime: 'application/pdf', bytes: pdf } })),
    );
    expect(out).toEqual({
      file_id: 'doc',
      name: 'doc.file',
      mime: 'application/pdf',
      size: pdf.byteLength,
      note: 'A binary file (application/pdf, 11 bytes); its content is not text. Copy it to your computer with attachment_to_computer and open it with the tools there.',
    });
  });

  it('refuses a file the backend does not find', async () => {
    await expect(read({ file_id: 'nope' }, ctx(fakeAttachments({})))).rejects.toThrow(
      'No attachment nope in this chat',
    );
  });
});
