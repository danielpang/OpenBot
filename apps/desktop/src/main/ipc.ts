import {
  DESKTOP_CHANNELS,
  type ConnectionInfo,
  type ConnectOptions,
  type ProfilesView,
  type QuickAskBot,
  type QuickAskResult,
  type ServerCheckResult,
  type ServerProfile,
} from '../ipc.js';
import type { IpcInvokeEvent, IpcMainLike } from '../stack/bridge.js';

// The main-process side of the app pages' bridge (../preload/bridge.ts).
// Every channel here is for the app's own pages only; `isTrusted` refuses the
// rest, as the stack manager's channels do. The connection channels the web
// app's indicator uses also answer the active server's own page in the main
// window (`isConnectionCaller`); they reveal only which server that page is
// already on, and Start, Stop and Show logs work only for This Mac. That page
// may also open a connector's sign-in in the default browser and, once it
// finishes, bring the window back (./oauth.ts).

export interface DesktopHandlers {
  listProfiles(): Promise<ProfilesView>;
  addProfile(input: { name?: string; url: string }): Promise<ServerProfile>;
  removeProfile(id: string): Promise<ProfilesView>;
  openProfile(id: string): Promise<void>;
  connectOptions(): Promise<ConnectOptions>;
  connectCloud(): Promise<void>;
  checkServer(url: string): Promise<ServerCheckResult>;
  connectServer(url: string): Promise<void>;
  connectLocal(): Promise<void>;
  connectionInfo(): Promise<ConnectionInfo>;
  changeConnection(): Promise<void>;
  startLocal(): Promise<ConnectionInfo>;
  stopLocal(): Promise<void>;
  showLocalLogs(): Promise<void>;
  openOAuth(url: string): Promise<void>;
  oauthFinished(): void;
  quickAskBots(): Promise<QuickAskBot[]>;
  quickAsk(botId: string, text: string): Promise<QuickAskResult>;
  closeQuickAsk(): void;
}

export const MAX_QUICK_ASK_LENGTH = 100_000;

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new Error(`${what} must be text.`);
  return value;
};

export function registerDesktopIpc(
  ipcMain: IpcMainLike,
  handlers: DesktopHandlers,
  isTrusted: (event: IpcInvokeEvent) => boolean,
  isConnectionCaller: (event: IpcInvokeEvent) => boolean = isTrusted,
): void {
  const guarded =
    (allowed: (event: IpcInvokeEvent) => boolean) =>
    (channel: string, fn: (...args: unknown[]) => unknown) =>
      ipcMain.handle(channel, async (event, ...args) => {
        if (!allowed(event)) throw new Error('This window may not use the app bridge.');
        return fn(...args);
      });
  const handle = guarded(isTrusted);
  const handleConnection = guarded((event) => isTrusted(event) || isConnectionCaller(event));

  handle(DESKTOP_CHANNELS.profilesList, () => handlers.listProfiles());
  handle(DESKTOP_CHANNELS.profilesAdd, (input) => {
    const { name, url } = (input ?? {}) as { name?: unknown; url?: unknown };
    return handlers.addProfile({
      ...(typeof name === 'string' ? { name } : {}),
      url: text(url, 'The server URL'),
    });
  });
  handle(DESKTOP_CHANNELS.profilesRemove, (id) => handlers.removeProfile(text(id, 'The profile')));
  handle(DESKTOP_CHANNELS.profilesOpen, (id) => handlers.openProfile(text(id, 'The profile')));
  handle(DESKTOP_CHANNELS.connectOptions, () => handlers.connectOptions());
  handle(DESKTOP_CHANNELS.connectCloud, () => handlers.connectCloud());
  handle(DESKTOP_CHANNELS.connectCheck, (url) =>
    handlers.checkServer(text(url, 'The server address')),
  );
  handle(DESKTOP_CHANNELS.connectServer, (url) =>
    handlers.connectServer(text(url, 'The server address')),
  );
  handle(DESKTOP_CHANNELS.connectLocal, () => handlers.connectLocal());
  handleConnection(DESKTOP_CHANNELS.connectionInfo, () => handlers.connectionInfo());
  handleConnection(DESKTOP_CHANNELS.connectionChange, () => handlers.changeConnection());
  handleConnection(DESKTOP_CHANNELS.connectionStart, () => handlers.startLocal());
  handleConnection(DESKTOP_CHANNELS.connectionStop, () => handlers.stopLocal());
  handleConnection(DESKTOP_CHANNELS.connectionLogs, () => handlers.showLocalLogs());
  handleConnection(DESKTOP_CHANNELS.oauthOpen, (url) =>
    handlers.openOAuth(text(url, 'The sign-in address')),
  );
  handleConnection(DESKTOP_CHANNELS.oauthFinished, () => handlers.oauthFinished());
  handle(DESKTOP_CHANNELS.quickAskBots, () => handlers.quickAskBots());
  handle(DESKTOP_CHANNELS.quickAskSend, (botId, message) => {
    const body = text(message, 'The message').trim();
    if (body === '') throw new Error('Type a message first.');
    if (body.length > MAX_QUICK_ASK_LENGTH) throw new Error('The message is too long.');
    return handlers.quickAsk(text(botId, 'The Bot'), body);
  });
  handle(DESKTOP_CHANNELS.quickAskClose, () => handlers.closeQuickAsk());
}
