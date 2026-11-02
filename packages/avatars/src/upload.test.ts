import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadAvatarImage } from './upload.js';

afterEach(() => vi.unstubAllGlobals());

describe('uploadAvatarImage', () => {
  it('posts multipart to the files API as an avatar and returns the file id', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ id: 'f1' }, { status: 201 }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(uploadAvatarImage(new Blob(['x'], { type: 'image/png' }))).resolves.toBe('f1');
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/files',
      expect.objectContaining({ method: 'POST' }),
    );
    expect((fetch.mock.calls[0]![1].body as FormData).get('purpose')).toBe('avatar');
  });

  it('reports a 404 as the failure it is', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    await expect(uploadAvatarImage(new Blob(['x']))).rejects.toThrow('Upload failed (404)');
    vi.stubGlobal('fetch', async () =>
      Response.json({ title: 'Not found', status: 404, detail: 'No such route' }, { status: 404 }),
    );
    await expect(uploadAvatarImage(new Blob(['x']))).rejects.toThrow('No such route');
  });

  it('surfaces a problem detail', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ title: 'Too large', status: 413, detail: 'Max 10 MB' }, { status: 413 }),
    );
    await expect(uploadAvatarImage(new Blob(['x']))).rejects.toThrow('Max 10 MB');
  });
});
