import { ApiError, unwrap, type components } from '@openbots/api-client';
import { COMPUTER_OFF, type WsEventOf } from '@openbots/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../app/api.js';

// The account's computer (plan 9, 14.1; K1, K3, K7): its state and its Bots'
// screens, start and restart, its idle setting, the file browser under
// /home/bot, taking a Bot's screen over, and the URLs of the terminal and
// screen sockets the server proxies to the computer's control agent.

export type ComputerState = components['schemas']['ComputerState'];
// The schema is nullable because `ComputerState.computer` is.
export type Computer = NonNullable<components['schemas']['Computer']>;
export type Screen = components['schemas']['Screen'];
export type DirListing = components['schemas']['ComputerDirListing'];
export type DirEntry = components['schemas']['ComputerDirEntry'];

export const HOME = '/home/bot';

export const computerQuery = queryOptions({
  queryKey: ['computer'],
  queryFn: () => unwrap(api.GET('/api/v1/computer')),
});

export const filesQuery = (path: string) =>
  queryOptions({
    queryKey: ['computer', 'files', path],
    queryFn: () => unwrap(api.GET('/api/v1/computer/files', { params: { query: { path } } })),
  });

export const startComputer = () => unwrap(api.POST('/api/v1/computer/start'));

/** Stops the computer if it runs, then starts it again; its files are kept. */
export const restartComputer = () => unwrap(api.POST('/api/v1/computer/restart'));

export type ComputerSettings = components['schemas']['ComputerSettings'];

/** Keeps the computer on, or sets how many idle minutes it waits before it stops (plan 9.5). */
export const updateComputerSettings = (body: ComputerSettings) =>
  unwrap(api.PATCH('/api/v1/computer', { body }));

/** The file routes answer this while the computer is off; they never start it. */
export const isComputerOff = (error: unknown) =>
  error instanceof ApiError && error.status === 409 && error.code === COMPUTER_OFF;

/** Takes or hands back a Bot's screen; a take with `url` opens that page first (K8). */
export const setScreenControl = (botId: string, action: 'take' | 'release', url?: string) =>
  unwrap(
    api.POST('/api/v1/bots/{id}/screen/control', {
      params: { path: { id: botId } },
      body: { action, ...(url ? { url } : {}) },
    }),
  );

/** `/home/bot/a b/c.txt` to `a%20b/c.txt`: the route takes the path relative to home. */
function relativeHome(path: string) {
  const rel = path.startsWith(`${HOME}/`) ? path.slice(HOME.length + 1) : path.replace(/^\/+/, '');
  return rel.split('/').map(encodeURIComponent).join('/');
}

/** The download URL of a file under /home/bot; the response is an attachment. */
export const computerFileUrl = (path: string) => `/api/v1/computer/files/${relativeHome(path)}`;

/** Uploads a file as the raw body, replacing one at the same path. */
export async function uploadComputerFile(path: string, file: Blob) {
  const response = await fetch(computerFileUrl(path), {
    method: 'PUT',
    body: file,
    credentials: 'include',
    headers: { 'content-type': 'application/octet-stream' },
  });
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) throw new ApiError(response.status, body as never);
  return body as { path: string; size: number };
}

export const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;

/** A WebSocket URL on the page's origin (`ws:` or `wss:` by its protocol). */
export function socketUrl(path: string, base = window.location.origin) {
  const url = new URL(path, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** Where a terminal opens: a directory, as another user (`coder`), with a command typed (I15). */
export interface PtyAttach {
  cwd?: string;
  user?: string;
  preset?: string;
}

/**
 * The terminal: a login shell on the computer, sized in character cells, in
 * `cwd` as `user` with `preset` typed and ready when given (the server checks
 * them against a coding session or a repository the owner has).
 */
export function ptyUrl(cols: number, rows: number, attach: PtyAttach = {}) {
  const query = new URLSearchParams({ cols: String(cols), rows: String(rows) });
  for (const key of ['cwd', 'user', 'preset'] as const) {
    if (attach[key]) query.set(key, attach[key]);
  }
  return socketUrl(`/api/v1/computer/pty?${query.toString()}`);
}

/**
 * The Bot's screen as RFB over WebSocket (websockify on its display).
 * Takeover's is a `control` socket: when it closes for good, the server hands
 * the screen back after a grace period, so a closed tab does not keep the Bot
 * waiting (K3).
 */
export const vncUrl = (botId: string, control = false) =>
  socketUrl(`/api/v1/bots/${encodeURIComponent(botId)}/screen/vnc${control ? '?control=1' : ''}`);

/** The Bot's screen from the cached computer, if it has one yet. */
export const screenOf = (state: ComputerState | undefined, botId: string) =>
  state?.computer?.screens.find((screen) => screen.botId === botId);

/** Applies `computer.status`; undefined when the cache cannot hold it and must refetch. */
export function applyComputerStatus(
  state: ComputerState | undefined,
  event: WsEventOf<'computer.status'>,
): ComputerState | undefined {
  const computer = state?.computer;
  if (!state || !computer || computer.id !== event.payload.computerId) return undefined;
  const status = event.payload.status as Computer['status'];
  return { ...state, computer: { ...computer, status } };
}

/** Applies `screen.control`; undefined when the screen is not cached yet. */
export function applyScreenControl(
  state: ComputerState | undefined,
  event: WsEventOf<'screen.control'>,
): ComputerState | undefined {
  const computer = state?.computer;
  const { screenId, controller, userId } = event.payload;
  if (!state || !computer?.screens.some((screen) => screen.id === screenId)) return undefined;
  const screens = computer.screens.map((screen) =>
    screen.id === screenId
      ? {
          ...screen,
          controlledByUserId: controller === 'user' ? (userId ?? screen.controlledByUserId) : null,
          controlledSince: controller === 'user' ? new Date(event.ts).toISOString() : null,
        }
      : screen,
  );
  return { ...state, computer: { ...computer, screens } };
}
