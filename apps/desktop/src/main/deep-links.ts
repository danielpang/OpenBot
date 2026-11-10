// Deep links (plan 14.4, N1): `openbots://bot/{id}/message/{seq}` opens one
// message of a Bot's transcript, and `openbots://chat/{id}/message/{seq}` one of
// a group chat. A reply in a thread adds `?thread={root id}`, which opens the
// thread at the reply. A message in one of the Bot's chats with another Bot
// (C6), which the web app shows under the Bot's transcript, adds
// `?chat={that chat's id}` to the Bot's link; its seq is that chat's. The app registers the scheme with setAsDefaultProtocolClient;
// notifications carry these links, and macOS hands them back through
// `open-url` when one is clicked or opened from elsewhere. `openbots://connectors`
// opens the Connectors page: a connector's OAuth sign-in, finished in the
// default browser, links back with it. `openbots://devices` opens Settings >
// Devices, where the menus' "Pair your phone…" goes. `openbots://pair#...`
// is another server's pairing link (docs/RELAY_PROTOCOL.md 6.1): opened on a
// Mac, it offers to pair this Mac with that server (./pair-link.ts reads it).

export const PROTOCOL = 'openbots';

/**
 * `thread` is the root message of the thread the message is in. `chat` on a
 * Bot's link is the Bot to Bot chat the message is in, under that Bot.
 */
export type MessageLink =
  | { kind: 'bot'; botId: string; chat?: string; seq?: number; thread?: string }
  | { kind: 'chat'; chatId: string; seq?: number; thread?: string };

export type DeepLink =
  | MessageLink
  | { kind: 'connectors' }
  | { kind: 'devices' }
  /** Another server's pairing link, as it came; ./pair-link.ts checks it before anything uses it. */
  | { kind: 'pair'; link: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The link for a message, or for the chat when `seq` is missing. */
export function formatDeepLink(link: DeepLink): string {
  if (link.kind === 'connectors') return `${PROTOCOL}://connectors`;
  if (link.kind === 'devices') return `${PROTOCOL}://devices`;
  if (link.kind === 'pair') return link.link;
  const [kind, id] = link.kind === 'bot' ? ['bot', link.botId] : ['chat', link.chatId];
  const base = `${PROTOCOL}://${kind}/${encodeURIComponent(id)}`;
  const path = link.seq != null ? `${base}/message/${link.seq}` : base;
  const query = new URLSearchParams();
  if (link.kind === 'bot' && link.chat) query.set('chat', link.chat);
  if (link.thread) query.set('thread', link.thread);
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

/**
 * Parses an `openbots://` URL. Anything else, or a malformed id or seq,
 * is null: a link from outside the app must never open an arbitrary path.
 */
export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL}:`) return null;
  if (url.hostname === 'pair') {
    // The fragment is the link; it never names a path of the web app.
    const bare = url.pathname === '' && url.search === '' && url.username === '';
    return bare && url.hash.length > 1 && raw.length <= 4096 ? { kind: 'pair', link: raw } : null;
  }
  // `openbots://bot/<id>/...` parses with the kind as the host.
  const segments = [url.hostname, ...url.pathname.split('/')].filter((s) => s !== '');
  if (segments.length === 1 && !url.search) {
    if (segments[0] === 'connectors') return { kind: 'connectors' };
    if (segments[0] === 'devices') return { kind: 'devices' };
  }
  const [kind, id, message, seqText, ...rest] = segments;
  if (rest.length > 0 || id == null || !UUID.test(id)) return null;
  let seq: number | undefined;
  if (message != null) {
    if (message !== 'message' || seqText == null || !/^\d{1,15}$/.test(seqText)) return null;
    seq = Number(seqText);
    if (seq < 1) return null;
  }
  const thread = url.searchParams.get('thread');
  if (thread != null && !UUID.test(thread)) return null;
  const chat = url.searchParams.get('chat');
  if (chat != null && (kind !== 'bot' || !UUID.test(chat))) return null;
  const lower = id.toLowerCase();
  const extra = {
    ...(seq != null ? { seq } : {}),
    ...(thread != null ? { thread: thread.toLowerCase() } : {}),
  };
  if (kind === 'bot') {
    return {
      kind: 'bot',
      botId: lower,
      ...(chat != null ? { chat: chat.toLowerCase() } : {}),
      ...extra,
    };
  }
  if (kind === 'chat') return { kind: 'chat', chatId: lower, ...extra };
  return null;
}

/**
 * The web app path a link opens: the transcript (with `?chat=`, one of its
 * Bot to Bot chats) or the group, at `seq` and `thread`.
 */
export function deepLinkPath(link: DeepLink): string {
  if (link.kind === 'connectors') return '/connectors';
  if (link.kind === 'devices') return '/settings/devices';
  // A pairing link opens the welcome screen, never a page of the current server.
  if (link.kind === 'pair') return '/';
  const base = link.kind === 'bot' ? `/bots/${link.botId}` : `/groups/${link.chatId}`;
  const query = new URLSearchParams();
  if (link.kind === 'bot' && link.chat) query.set('chat', link.chat);
  if (link.seq != null) query.set('seq', String(link.seq));
  if (link.thread) query.set('thread', link.thread);
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

/** The deep link among a process's arguments (Windows and Linux pass it there). */
export function deepLinkFromArgv(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
}
