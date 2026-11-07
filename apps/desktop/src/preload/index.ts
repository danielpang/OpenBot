import { contextBridge, ipcRenderer } from 'electron';
import type { PlatformInfo } from '../ipc.js';
import { createAppBridge, createWebBridge, isAppPage } from './bridge.js';
import { installUpdateToast } from './update-toast.js';

// The preload of every window (plan 14.4). It runs sandboxed with
// contextIsolation on, so it may import nothing but Electron's renderer
// modules and code bundled into it. The main process passes the platform
// context and the app's own page origin as arguments.

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const platform = JSON.parse(argument('openbots-platform') ?? '{}') as PlatformInfo;
const appBase = argument('openbots-app-base');

// Only the main window, never embedded frames or the small pairing/quick-ask panels.
// IPC rechecks the current document's trust before any update action.
if (argument('openbots-updates') === 'true' && window.top === window) installUpdateToast();

contextBridge.exposeInMainWorld(
  'openbots',
  isAppPage(location.href, appBase)
    ? createAppBridge(ipcRenderer, platform)
    : createWebBridge(ipcRenderer, platform),
);
