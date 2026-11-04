import { ApiError, type components } from '@openbots/api-client';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { MobileTransport } from '../transport';

export interface Attachment {
  uri: string;
  name: string;
  mime: string;
}
const MAX_UPLOAD = 15 * 1024 * 1024; // Leaves room for multipart framing in the tunnel's 16MiB cap.

/** Bytes are explicit so direct and relay requests serialize identically on Hermes. */
export async function uploadAttachment(
  transport: MobileTransport,
  attachment: Attachment,
): Promise<components['schemas']['File']> {
  const file = new File(attachment.uri);
  if (file.size > MAX_UPLOAD) throw new Error('Choose a file smaller than 15 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_UPLOAD) throw new Error('Choose a file smaller than 15 MB.');
  const boundary = `openbots-${crypto.randomUUID()}`;
  const filename = attachment.name.replace(/[\r\n"\\]/g, '_');
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.mime)
    ? attachment.mime
    : 'application/octet-stream';
  const encode = new TextEncoder();
  const start = encode.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const end = encode.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(start.length + bytes.length + end.length);
  body.set(start);
  body.set(bytes, start.length);
  body.set(end, start.length + bytes.length);
  const response = await transport.fetch('/api/v1/files', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const value = await response.json();
  if (!response.ok) throw new ApiError(response.status, value);
  return value as components['schemas']['File'];
}

export async function fileBytes(transport: MobileTransport, fileId: string) {
  const response = await transport.fetch(`/api/v1/files/${encodeURIComponent(fileId)}`);
  if (!response.ok)
    throw new ApiError(response.status, { detail: 'Could not download this file.' });
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mime: response.headers.get('content-type') ?? 'application/octet-stream',
  };
}

export async function openFile(
  transport: MobileTransport,
  fileId: string,
  name: string,
): Promise<void> {
  const { bytes, mime } = await fileBytes(transport, fileId);
  const file = new File(
    Paths.cache,
    `${crypto.randomUUID()}-${name.replace(/[^\w. -]/g, '_').slice(-100) || 'attachment'}`,
  );
  file.create();
  file.write(bytes);
  try {
    if (!(await Sharing.isAvailableAsync()))
      throw new Error('Sharing is unavailable on this device.');
    await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: name });
  } finally {
    if (file.exists) file.delete();
  }
}
