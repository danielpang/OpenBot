import type { EmailMessage, InboxMessage } from '@openbots/agent';
import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { checkedAddress, type NetOptions } from './net.js';
import { htmlToMarkdown } from './web.js';

// The email built-in (plan 5.4, T2): one mailbox per Email connector
// (kind builtin), sending over SMTP with nodemailer and reading over IMAP with
// imapflow. Host, port, username and From live in the connector's params; the
// password is the connector's sealed `PASSWORD` secret. Both servers must be
// on public addresses, like every outbound request (S-8): the host is resolved
// and checked once and the client connects to that address, with the name
// kept for TLS.

export interface EmailSettings {
  smtpHost: string;
  smtpPort: number;
  imapHost: string | null;
  imapPort: number;
  username: string;
  password: string;
  from: string;
}

/** Reads the newest messages of a mailbox; the IMAP client, or a fake in tests. */
export type InboxReader = (
  settings: EmailSettings,
  query: { limit: number; unreadOnly: boolean },
  net?: NetOptions,
) => Promise<InboxMessage[]>;

export interface EmailOptions {
  readInbox?: InboxReader;
  /** Plain SMTP without TLS (local fakes in tests). */
  insecure?: boolean;
  net?: NetOptions;
}

const MAX_TEXT = 4_000;

const port = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : fallback;
};

/** The settings from the connector's params and secrets; null when incomplete. */
export function emailSettings(
  params: Record<string, string>,
  secrets: Record<string, string>,
): EmailSettings | null {
  const username = params.username?.trim();
  if (!params.smtp_host || !username || !secrets.PASSWORD) return null;
  return {
    smtpHost: params.smtp_host.trim(),
    smtpPort: port(params.smtp_port, 587),
    imapHost: params.imap_host?.trim() || null,
    imapPort: port(params.imap_port, 993),
    username,
    password: secrets.PASSWORD,
    from: params.from?.trim() || username,
  };
}

export async function sendEmail(
  settings: EmailSettings,
  message: EmailMessage,
  options: EmailOptions = {},
) {
  const host = await checkedAddress(settings.smtpHost, options.net);
  const transport = createTransport({
    host,
    servername: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpPort === 465,
    auth: { user: settings.username, pass: settings.password },
    ...(options.insecure ? { ignoreTLS: true } : { requireTLS: settings.smtpPort !== 465 }),
    connectionTimeout: 20_000,
    socketTimeout: 60_000,
  });
  try {
    const info = await transport.sendMail({
      from: message.from ?? settings.from,
      to: message.to,
      ...(message.cc?.length ? { cc: message.cc } : {}),
      subject: message.subject,
      text: message.body,
    });
    return {
      messageId: info.messageId,
      accepted: (info.accepted as (string | { address: string })[]).map((a) =>
        typeof a === 'string' ? a : a.address,
      ),
    };
  } finally {
    transport.close();
  }
}

interface BodyNode {
  part?: string;
  type: string;
  childNodes?: BodyNode[];
}

function findPart(node: BodyNode | undefined, type: string): BodyNode | undefined {
  if (!node) return undefined;
  if (node.type === type) return node;
  for (const child of node.childNodes ?? []) {
    const found = findPart(child, type);
    if (found) return found;
  }
  return undefined;
}

async function readStream(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** The newest messages of INBOX over IMAP, read-only (nothing is marked as read). */
export const imapInbox: InboxReader = async (settings, { limit, unreadOnly }, net) => {
  if (!settings.imapHost) {
    throw new Error(
      'This mailbox has no IMAP server; add one to the Email connector to read mail.',
    );
  }
  const client = new ImapFlow({
    host: await checkedAddress(settings.imapHost, net),
    servername: settings.imapHost,
    port: settings.imapPort,
    secure: settings.imapPort === 993,
    auth: { user: settings.username, pass: settings.password },
    logger: false,
  });
  await client.connect();
  try {
    const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
    let uids: number[];
    if (unreadOnly) {
      uids = ((await client.search({ seen: false }, { uid: true })) || []).slice(-limit);
    } else {
      const first = Math.max(1, mailbox.exists - limit + 1);
      uids = [];
      if (mailbox.exists > 0) {
        for await (const m of client.fetch(`${first}:*`, { uid: true })) uids.push(m.uid);
      }
    }
    if (!uids.length) return [];
    const messages: InboxMessage[] = [];
    for await (const m of client.fetch(
      uids.join(','),
      { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true },
      { uid: true },
    )) {
      const structure = m.bodyStructure as BodyNode | undefined;
      const plain = findPart(structure, 'text/plain');
      const html = plain ? undefined : findPart(structure, 'text/html');
      let text = '';
      const node = plain ?? html;
      if (node) {
        const { content } = await client.download(String(m.uid), node.part ?? '1', {
          uid: true,
          maxBytes: 64_000,
        });
        const raw = content ? await readStream(content) : '';
        text = html ? htmlToMarkdown(raw).markdown : raw;
      }
      const envelope = m.envelope;
      const addr = (a?: { name?: string; address?: string }) =>
        a ? (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')) : '';
      const date = m.internalDate;
      messages.push({
        uid: m.uid,
        from: addr(envelope?.from?.[0]),
        to: (envelope?.to ?? []).map(addr),
        subject: envelope?.subject ?? '',
        date: date ? new Date(date).toISOString() : null,
        unread: !m.flags?.has('\\Seen'),
        text: text.trim().slice(0, MAX_TEXT),
      });
    }
    return messages.sort((a, b) => b.uid - a.uid);
  } finally {
    await client.logout().catch(() => {});
  }
};
