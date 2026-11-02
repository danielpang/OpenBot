// Avatar uploads go through the files API (`POST /api/v1/files`) with
// `purpose=avatar`, which takes PNG, JPEG, WebP and GIF images only. Any
// failure, a 404 included, surfaces as the server's problem detail.

/** The raster types an avatar may be; the server refuses others (SVG included). */
export const AVATAR_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** Posts the image as multipart `file` and returns the stored file's id. */
export async function uploadAvatarImage(file: Blob, baseUrl = ''): Promise<string> {
  const body = new FormData();
  body.append('file', file);
  body.append('purpose', 'avatar');
  const res = await fetch(`${baseUrl}/api/v1/files`, {
    method: 'POST',
    body,
    credentials: 'include',
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as {
      detail?: string;
      title?: string;
    } | null;
    throw new Error(problem?.detail ?? problem?.title ?? `Upload failed (${res.status})`);
  }
  const { id } = (await res.json()) as { id: string };
  return id;
}
