import type { DockerApp } from './docker.js';
import type { LogTail, StackManager, StackPhase, StackProgress, StackStatus } from './manager.js';
import { StackError } from './manager.js';

export { errorParts, NETWORK_CLASH } from './error-parts.js';

// The stack manager behind the preload bridge (plan 14.4). The main process
// registers `registerStackIpc`; the preload exposes `createStackBridge` with
// contextBridge, so the sandboxed renderer only ever sees these few calls.
// Electron's ipcMain and ipcRenderer satisfy the structural types below, which
// keeps this module importable without Electron.

export const STACK_CHANNELS = {
  status: 'openbots:stack:status',
  start: 'openbots:stack:start',
  stop: 'openbots:stack:stop',
  upgrade: 'openbots:stack:upgrade',
  changePort: 'openbots:stack:change-port',
  useOwnNetwork: 'openbots:stack:use-own-network',
  startRuntime: 'openbots:stack:start-runtime',
  logsStart: 'openbots:stack:logs:start',
  logsStop: 'openbots:stack:logs:stop',
  logsLine: 'openbots:stack:logs:line',
  logsExit: 'openbots:stack:logs:exit',
  /** main → renderer: the step a start or update has reached. */
  progress: 'openbots:stack:progress',
} as const;

export const MAX_LOG_TAIL = 5000;

/** What the renderer gets as `window.openbots.stack`. */
export interface StackBridge {
  status(): Promise<StackStatus>;
  start(): Promise<StackStatus>;
  stop(): Promise<StackStatus>;
  /** Pulls the app's release (or newer images) and restarts the stack on it. */
  upgrade(): Promise<StackStatus>;
  /** Moves a stack that is not running to a free port, when another app took its own. */
  changePort(): Promise<StackStatus>;
  /**
   * Moves a stack that is not running to a sandbox network of its own, when
   * another OpenBots stack on this Mac holds its network.
   */
  useOwnNetwork(): Promise<StackStatus>;
  /**
   * Hears the steps of a start or update this page asked for; returns the
   * unsubscribe. While the images come from the GitHub Release instead of the
   * registry, `pulling` arrives again and again with `progress`.
   */
  onProgress(listener: (phase: StackPhase, progress?: StackProgress) => void): () => void;
  startRuntime(runtime?: DockerApp): Promise<void>;
  /** Follows the stack's logs until the returned function is called. */
  tailLogs(
    options: { tail?: number },
    onLine: (line: string) => void,
    onExit?: (code: number | null) => void,
  ): Promise<() => void>;
}

export interface IpcSender {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface IpcInvokeEvent {
  sender: IpcSender;
}

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown,
  ): void;
}

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

function clampTail(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 200;
  return Math.min(Math.max(n, 0), MAX_LOG_TAIL);
}

const RELEASE_IMAGE_NAMES = new Set(['server', 'sandbox-firewall', 'computer']);

/** A StackProgress from IPC, or undefined for anything else. */
export function parseProgress(value: unknown): StackProgress | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const int = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  if (
    v.source !== 'release' ||
    typeof v.image !== 'string' ||
    !RELEASE_IMAGE_NAMES.has(v.image) ||
    !int(v.index) ||
    !int(v.count) ||
    (v.step !== 'downloading' && v.step !== 'loading') ||
    !(v.percent === null || (int(v.percent) && (v.percent as number) <= 100))
  ) {
    return undefined;
  }
  return {
    source: 'release',
    image: v.image as StackProgress['image'],
    index: v.index as number,
    count: v.count as number,
    step: v.step,
    percent: v.percent as number | null,
  };
}

function parseRuntime(value: unknown): DockerApp | undefined {
  return value === 'orbstack' || value === 'docker-desktop' ? value : undefined;
}

/**
 * Wires the stack manager to IPC. `isTrusted` decides which renderers may
 * drive the local stack: only the app's own UI, never a remote server profile's
 * page. Untrusted calls reject.
 */
export function registerStackIpc(
  ipcMain: IpcMainLike,
  manager: StackManager,
  isTrusted: (event: IpcInvokeEvent) => boolean,
): void {
  const tails = new Map<string, LogTail>();
  let nextTail = 1;

  const handle = (channel: string, fn: (event: IpcInvokeEvent, ...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrusted(event)) throw new Error('This window may not manage the local stack.');
      try {
        return await fn(event, ...args);
      } catch (error) {
        // Errors cross IPC as their message only; keep the detail readable.
        if (error instanceof StackError && error.detail !== '') {
          throw new Error(`${error.message}\n${error.detail}`, { cause: error });
        }
        throw error;
      }
    });

  handle(STACK_CHANNELS.status, () => manager.status());
  const progress = (sender: IpcSender) => (phase: StackPhase, detail?: StackProgress) => {
    if (sender.isDestroyed()) return;
    if (detail) sender.send(STACK_CHANNELS.progress, phase, detail);
    else sender.send(STACK_CHANNELS.progress, phase);
  };
  handle(STACK_CHANNELS.start, (event) => manager.start(progress(event.sender)));
  handle(STACK_CHANNELS.stop, () => manager.stop());
  handle(STACK_CHANNELS.upgrade, (event) => manager.upgrade(progress(event.sender)));
  handle(STACK_CHANNELS.changePort, () => manager.changePort());
  handle(STACK_CHANNELS.useOwnNetwork, () => manager.useOwnNetwork());
  handle(STACK_CHANNELS.startRuntime, (_event, runtime) =>
    manager.startRuntime(parseRuntime(runtime)),
  );

  handle(STACK_CHANNELS.logsStart, async (event, tail) => {
    const id = `tail-${nextTail++}`;
    const { sender } = event;
    const send = (channel: string, ...args: unknown[]) => {
      if (!sender.isDestroyed()) sender.send(channel, ...args);
    };
    const logTail = await manager.tailLogs(
      { tail: clampTail(tail) },
      (line) => send(STACK_CHANNELS.logsLine, id, line),
      (code) => {
        tails.delete(id);
        send(STACK_CHANNELS.logsExit, id, code);
      },
    );
    tails.set(id, logTail);
    // A closed window must not leave `docker compose logs -f` running.
    sender.once('destroyed', () => {
      tails.get(id)?.stop();
      tails.delete(id);
    });
    return id;
  });

  handle(STACK_CHANNELS.logsStop, (_event, id) => {
    if (typeof id !== 'string') return;
    tails.get(id)?.stop();
    tails.delete(id);
  });
}

/** The renderer-facing API, built in the preload from ipcRenderer. */
export function createStackBridge(ipcRenderer: IpcRendererLike): StackBridge {
  return {
    status: () => ipcRenderer.invoke(STACK_CHANNELS.status) as Promise<StackStatus>,
    start: () => ipcRenderer.invoke(STACK_CHANNELS.start) as Promise<StackStatus>,
    stop: () => ipcRenderer.invoke(STACK_CHANNELS.stop) as Promise<StackStatus>,
    upgrade: () => ipcRenderer.invoke(STACK_CHANNELS.upgrade) as Promise<StackStatus>,
    changePort: () => ipcRenderer.invoke(STACK_CHANNELS.changePort) as Promise<StackStatus>,
    useOwnNetwork: () => ipcRenderer.invoke(STACK_CHANNELS.useOwnNetwork) as Promise<StackStatus>,
    onProgress(listener) {
      const handler = (_event: unknown, ...args: unknown[]) => {
        const [phase, detail] = args;
        if (phase !== 'pulling' && phase !== 'starting') return;
        const progress = parseProgress(detail);
        if (progress) listener(phase, progress);
        else listener(phase);
      };
      ipcRenderer.on(STACK_CHANNELS.progress, handler);
      return () => void ipcRenderer.removeListener(STACK_CHANNELS.progress, handler);
    },
    startRuntime: (runtime) =>
      ipcRenderer.invoke(STACK_CHANNELS.startRuntime, runtime) as Promise<void>,

    async tailLogs(options, onLine, onExit) {
      // Lines, and even the exit, can arrive before invoke resolves with the
      // id; buffer them until then.
      let id: string | undefined;
      let exited = false;
      const early: (() => void)[] = [];
      const lineListener = (event: unknown, ...args: unknown[]) => {
        const [tailId, line] = args as [string, string];
        if (id == null) early.push(() => lineListener(event, tailId, line));
        else if (tailId === id) onLine(line);
      };
      const exitListener = (event: unknown, ...args: unknown[]) => {
        const [tailId, code] = args as [string, number | null];
        if (id == null) early.push(() => exitListener(event, tailId, code));
        else if (tailId === id) {
          exited = true;
          cleanup();
          onExit?.(code);
        }
      };
      const cleanup = () => {
        ipcRenderer.removeListener(STACK_CHANNELS.logsLine, lineListener);
        ipcRenderer.removeListener(STACK_CHANNELS.logsExit, exitListener);
      };
      ipcRenderer.on(STACK_CHANNELS.logsLine, lineListener);
      ipcRenderer.on(STACK_CHANNELS.logsExit, exitListener);
      try {
        id = (await ipcRenderer.invoke(STACK_CHANNELS.logsStart, options.tail)) as string;
      } catch (error) {
        cleanup();
        throw error;
      }
      for (const replay of early) replay();
      return () => {
        cleanup();
        if (!exited) void ipcRenderer.invoke(STACK_CHANNELS.logsStop, id);
      };
    },
  };
}
