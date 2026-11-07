// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_CHANNELS, type DesktopUpdateNotice } from '../ipc.js';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: unknown, notice: DesktopUpdateNotice | null) => void>(),
}));
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: ipc.invoke,
    on: (channel: string, listener: (event: unknown, notice: DesktopUpdateNotice | null) => void) =>
      ipc.listeners.set(channel, listener),
  },
}));
import { installUpdateToast } from './update-toast.js';

const ready: DesktopUpdateNotice = { version: '1.2.3', action: 'restart', busy: false };
const emit = (notice: DesktopUpdateNotice | null) =>
  ipc.listeners.get(DESKTOP_CHANNELS.updateNotice)!({}, notice);
const toast = () => document.querySelector<HTMLElement>('#openbots-update-toast')!;
const action = () => document.querySelector<HTMLButtonElement>('.update-action')!;
function mount() {
  installUpdateToast();
  window.dispatchEvent(new Event('DOMContentLoaded'));
}

beforeEach(() => {
  document.body.innerHTML = '';
  ipc.invoke.mockReset().mockResolvedValue(null);
  ipc.listeners.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('persistent desktop update notice', () => {
  it('hydrates from main-process state without requesting OS notification permission', async () => {
    ipc.invoke.mockResolvedValueOnce(ready);
    mount();
    await vi.waitFor(() => expect(toast().hidden).toBe(false));
    expect(toast().textContent).toContain('Version 1.2.3 is ready to install.');
    expect(action().textContent).toBe('Restart and update');
    expect(toast().getAttribute('aria-live')).toBe('polite');
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith(DESKTOP_CHANNELS.updateStatus);
  });

  it('shows manual downloads, shared dismissal and later version broadcasts', async () => {
    mount();
    await Promise.resolve();
    expect(toast().hidden).toBe(true);
    emit({ ...ready, action: 'download' });
    expect(action().textContent).toBe('Update');
    document.querySelector<HTMLButtonElement>('.update-dismiss')!.click();
    expect(ipc.invoke).toHaveBeenCalledWith(DESKTOP_CHANNELS.updateDismiss);
    emit(null);
    expect(toast().hidden).toBe(true);
    emit({ ...ready, version: '1.2.4' });
    expect(toast().hidden).toBe(false);
    expect(toast().textContent).toContain('1.2.4');
  });

  it('never replaces a live notice with an older hydration response', async () => {
    let resolve!: (notice: DesktopUpdateNotice) => void;
    ipc.invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mount();
    emit({ ...ready, version: '1.2.4' });
    resolve(ready);
    await Promise.resolve();
    expect(toast().textContent).toContain('1.2.4');
  });

  it('locks all notices during consent/install and coalesces local clicks', async () => {
    let resolve!: () => void;
    ipc.invoke.mockImplementation((channel: string) =>
      channel === DESKTOP_CHANNELS.updateCheck
        ? new Promise<void>((done) => {
            resolve = done;
          })
        : Promise.resolve(null),
    );
    mount();
    await Promise.resolve();
    emit(ready);
    action().click();
    action().click();
    expect(action().disabled).toBe(true);
    expect(
      ipc.invoke.mock.calls.filter(([channel]) => channel === DESKTOP_CHANNELS.updateCheck),
    ).toHaveLength(1);
    emit({ ...ready, busy: true });
    resolve();
    await vi.waitFor(() => expect(action().disabled).toBe(true));
    emit(ready);
    await vi.waitFor(() => expect(action().disabled).toBe(false));
  });

  it('shows a retryable action error if main-process IPC fails', async () => {
    mount();
    await Promise.resolve();
    emit(ready);
    ipc.invoke.mockRejectedValueOnce(new Error('Unavailable'));
    action().click();
    await vi.waitFor(() => expect(toast().textContent).toContain('Could not start the update'));
    expect(action().disabled).toBe(false);
  });
});
