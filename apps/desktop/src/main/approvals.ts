import type { components } from '@openbots/api-client';
import type { WsEvent } from '@openbots/shared';
import type { DeepLink } from './deep-links.js';
import { linkFor, type ChatKind } from './notices.js';

// The tray's pending approvals (N2). Each (re)connect loads the list from
// `GET /approvals?status=pending`; between loads, `approval.requested` and
// `approval.resolved` keep it current. An event that arrives while a load is
// in flight wins over the load, so a request decided meanwhile stays gone.

export interface PendingApproval {
  id: string;
  botId: string;
  botName: string;
  /** The arguments in one readable line, or the tool name. */
  summary: string;
  link: DeepLink;
}

type ServerApproval = components['schemas']['PendingApproval'];

/** What the events said while one load was in flight. */
export interface ApprovalLoad {
  readonly seen: Map<string, 'requested' | 'gone'>;
}

export function createApprovalTracker(
  botName: (botId: string) => string | undefined,
  chatKind: (chatId: string) => ChatKind | undefined = () => undefined,
) {
  const pending = new Map<string, PendingApproval>();
  const loads = new Set<ApprovalLoad>();

  const note = (id: string, what: 'requested' | 'gone') => {
    for (const load of loads) load.seen.set(id, what);
  };

  function entry(input: {
    id: string;
    botId: string;
    chatId?: string | null | undefined;
    seq?: number | null | undefined;
    toolName: string;
    summary?: string | null | undefined;
  }): PendingApproval {
    const link = linkFor(
      {
        botId: input.botId,
        chatId: input.chatId ?? undefined,
        seq: input.seq != null && input.seq > 0 ? input.seq : undefined,
        threadRootId: undefined,
      },
      chatKind,
    );
    return {
      id: input.id,
      botId: input.botId,
      botName: botName(input.botId) ?? 'A Bot',
      summary: input.summary || input.toolName,
      link,
    };
  }

  function drop(id: string): boolean {
    note(id, 'gone');
    return pending.delete(id);
  }

  return {
    /** True when the list changed. */
    onEvent(event: WsEvent): boolean {
      if (event.type === 'approval.requested') {
        const approval = event.payload.approval as {
          id: string;
          toolName: string;
          summary?: string | null;
          status: string;
        };
        if (approval.status !== 'pending' || !event.bot_id) return false;
        pending.set(
          approval.id,
          entry({ ...approval, botId: event.bot_id, chatId: event.chat_id, seq: event.seq }),
        );
        note(approval.id, 'requested');
        return true;
      }
      if (event.type === 'approval.resolved') {
        return drop(event.payload.approval.id);
      }
      return false;
    },
    /** After a decision from the tray, before the server's event arrives. */
    remove(id: string): boolean {
      return drop(id);
    },
    /** Call before fetching the list; pass the result to `load`. */
    beginLoad(): ApprovalLoad {
      const load: ApprovalLoad = { seen: new Map() };
      loads.add(load);
      return load;
    },
    /**
     * Replaces the list with the server's, keeping what events said since
     * `beginLoad`. False when nothing was loaded (a failed fetch, or `clear`
     * came first).
     */
    load(load: ApprovalLoad, items: ServerApproval[] | null): boolean {
      if (!loads.delete(load) || !items) return false;
      const next = new Map<string, PendingApproval>();
      for (const item of items) {
        if (item.status === 'pending' && load.seen.get(item.id) !== 'gone') {
          next.set(item.id, entry(item));
        }
      }
      for (const [id, what] of load.seen) {
        const live = pending.get(id);
        if (what === 'requested' && live && !next.has(id)) next.set(id, live);
      }
      pending.clear();
      for (const [id, approval] of next) pending.set(id, approval);
      return true;
    },
    list(): PendingApproval[] {
      return [...pending.values()];
    },
    clear(): void {
      pending.clear();
      loads.clear();
    },
  };
}

/** A menu item as Electron's `Menu.buildFromTemplate` takes it, without Electron. */
export interface TrayItem {
  label?: string;
  type?: 'normal' | 'separator' | 'submenu';
  enabled?: boolean;
  accelerator?: string;
  submenu?: TrayItem[];
  click?: () => void;
}

export interface TrayActions {
  open(link?: DeepLink): void;
  decide(id: string, decision: 'approve' | 'deny'): void;
  quickAsk(): void;
  /** Opens Settings > Devices on the active connection. */
  pairPhone(): void;
  changeConnection(): void;
  checkForUpdates(): void;
  quit(): void;
}

export const QUICK_ASK_ACCELERATOR = 'CommandOrControl+Shift+Space';
const MAX_TRAY_APPROVALS = 10;

const ellipsize = (text: string, max = 60) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/**
 * The tray menu: how the app is connected, pending approvals with a quick
 * Approve, then the app's actions.
 */
export function trayMenu(input: {
  approvals: PendingApproval[];
  profileName: string;
  /** The header line, the connection's kind and host (./launcher.ts), or null before a window opens. */
  connection?: string | null;
  connected: boolean;
  update?: { label: string; enabled: boolean };
  actions: TrayActions;
}): TrayItem[] {
  const { approvals, actions } = input;
  const items: TrayItem[] = [];
  if (input.connection) {
    items.push({ label: input.connection, enabled: false }, { type: 'separator' });
  }
  if (approvals.length === 0) {
    items.push({ label: 'No pending approvals', enabled: false });
  } else {
    items.push({
      label:
        approvals.length === 1 ? '1 pending approval' : `${approvals.length} pending approvals`,
      enabled: false,
    });
    for (const approval of approvals.slice(0, MAX_TRAY_APPROVALS)) {
      items.push({
        label: ellipsize(`${approval.botName}: ${approval.summary}`),
        type: 'submenu',
        submenu: [
          { label: 'Approve', click: () => actions.decide(approval.id, 'approve') },
          { label: 'Deny', click: () => actions.decide(approval.id, 'deny') },
          { type: 'separator' },
          { label: 'Open', click: () => actions.open(approval.link) },
        ],
      });
    }
    if (approvals.length > MAX_TRAY_APPROVALS) {
      items.push({
        label: `${approvals.length - MAX_TRAY_APPROVALS} more…`,
        click: () => actions.open(),
      });
    }
  }
  items.push(
    { type: 'separator' },
    { label: `Open OpenBots (${input.profileName})`, click: () => actions.open() },
    {
      label: 'Quick Ask…',
      accelerator: QUICK_ASK_ACCELERATOR,
      enabled: input.connected,
      click: () => actions.quickAsk(),
    },
    { label: 'Pair your phone…', click: () => actions.pairPhone() },
    { label: 'Change connection…', click: () => actions.changeConnection() },
    { type: 'separator' },
    { label: 'Check for Updates…', ...input.update, click: () => actions.checkForUpdates() },
    { label: 'Quit OpenBots', accelerator: 'CommandOrControl+Q', click: () => actions.quit() },
  );
  return items;
}
