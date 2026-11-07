import { ipcRenderer } from 'electron';
import { DESKTOP_CHANNELS, type DesktopUpdateNotice } from '../ipc.js';

/** Lives in the isolated preload, in trusted main frames only. */
export function installUpdateToast() {
  window.addEventListener(
    'DOMContentLoaded',
    () => {
      const style = document.createElement('style');
      style.textContent = `
      /* OpenBots's own popover/button tokens, not Bento's panel/brand theme. */
      #openbots-update-toast {
        position: fixed; right: 20px; bottom: 20px; z-index: 60;
        width: max-content; max-width: min(460px, calc(100vw - 40px));
        box-sizing: border-box; display: flex; align-items: center; gap: 16px; padding: 16px;
        border: 1px solid var(--border, #dedede); border-radius: var(--radius, 10px);
        background: var(--popover, #fafafa); color: var(--popover-foreground, #202020);
        box-shadow: 0 8px 28px rgb(24 24 24 / 12%), 0 2px 6px rgb(24 24 24 / 5%);
        font: 13px/1.45 var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif);
        -webkit-app-region: no-drag;
      }
      #openbots-update-toast[hidden] { display: none; }
      #openbots-update-toast .update-copy { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
      #openbots-update-toast .update-title { font-size: 13px; font-weight: 600; letter-spacing: -.01em; }
      #openbots-update-toast .update-message { font-size: 12px; color: var(--muted-foreground, #686868); overflow-wrap: anywhere; }
      #openbots-update-toast button { flex: none; font: inherit; cursor: pointer; white-space: nowrap; }
      #openbots-update-toast .update-action {
        min-height: 34px; border: 1px solid transparent; border-radius: calc(var(--radius, 10px) - 4px);
        background: var(--primary, #262626); color: var(--primary-foreground, #fafafa);
        padding: 6px 13px; font-size: 12px; font-weight: 500;
      }
      #openbots-update-toast .update-action:hover:not(:disabled) { opacity: .88; }
      #openbots-update-toast .update-action:active:not(:disabled) { transform: translateY(1px); }
      #openbots-update-toast .update-dismiss {
        display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
        border: 0; border-radius: calc(var(--radius, 10px) - 4px);
        background: transparent; color: var(--muted-foreground, #686868); font-size: 20px; line-height: 1;
      }
      #openbots-update-toast .update-dismiss:hover { background: var(--muted, #ededed); color: var(--foreground, #202020); }
      #openbots-update-toast button:focus-visible { outline: 2px solid var(--ring, #858585); outline-offset: 3px; }
      #openbots-update-toast button:disabled { cursor: wait; opacity: .6; }
    `;
      document.head.append(style);
      const toast = document.createElement('div');
      toast.id = 'openbots-update-toast';
      toast.hidden = true;
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      const copy = document.createElement('div');
      copy.className = 'update-copy';
      const title = document.createElement('span');
      title.className = 'update-title';
      title.textContent = 'OpenBots update';
      const message = document.createElement('span');
      message.className = 'update-message';
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'update-action';
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'update-dismiss';
      dismiss.textContent = '×';
      dismiss.setAttribute('aria-label', 'Dismiss update notification');
      copy.append(title, message);
      toast.append(copy, action, dismiss);
      document.body.append(toast);
      let current: DesktopUpdateNotice | null = null;
      let working = false;

      const render = (notice: DesktopUpdateNotice | null) => {
        current = notice;
        toast.hidden = notice === null;
        if (notice) {
          message.textContent = `Version ${notice.version} ${notice.action === 'download' ? 'is available.' : 'is ready to install.'}`;
          action.textContent = notice.action === 'download' ? 'Update' : 'Restart and update';
          action.disabled = working || notice.busy;
        }
      };
      action.addEventListener('click', () => {
        if (working || !current || current.busy) return;
        working = true;
        render(current);
        void ipcRenderer
          .invoke(DESKTOP_CHANNELS.updateCheck)
          .catch(() => {
            message.textContent = 'Could not start the update. Please try again.';
          })
          .finally(() => {
            working = false;
            action.disabled = current?.busy ?? false;
          });
      });
      dismiss.addEventListener('click', () => {
        void ipcRenderer.invoke(DESKTOP_CHANNELS.updateDismiss).catch(() => {});
      });
      let received = false;
      ipcRenderer.on(
        DESKTOP_CHANNELS.updateNotice,
        (_event, notice: DesktopUpdateNotice | null) => {
          received = true;
          render(notice);
        },
      );
      void ipcRenderer
        .invoke(DESKTOP_CHANNELS.updateStatus)
        .then((notice) => {
          if (!received) render(notice);
        })
        .catch(() => {});
    },
    { once: true },
  );
}
