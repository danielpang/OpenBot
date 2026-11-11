// The app menu's File menu (B2). New opens the web app's New dialog: the
// page gets Cmd+N in the app, but a menu item with the accelerator makes it
// work from anywhere in the app and shows the shortcut where Mac users look.
// Pair your phone opens Settings > Devices on the active connection, where the
// web app shows the pairing QR code.

export const NEW_ACCELERATOR = 'CommandOrControl+N';
/** View > Show Office Space: O for Office (apps/web shortcuts.ts takes the same keys). */
export const OFFICE_ACCELERATOR = 'CommandOrControl+Shift+O';

/** A menu item as Electron's `Menu.buildFromTemplate` takes it, without Electron. */
export interface MenuItem {
  label?: string;
  role?:
    | 'close'
    | 'reload'
    | 'forceReload'
    | 'toggleDevTools'
    | 'resetZoom'
    | 'zoomIn'
    | 'zoomOut'
    | 'togglefullscreen';
  type?: 'normal' | 'separator' | 'submenu';
  accelerator?: string;
  submenu?: MenuItem[];
  click?: () => void;
}

export function fileMenu(actions: { newItem(): void; pairPhone(): void }): MenuItem {
  return {
    label: 'File',
    submenu: [
      { label: 'New…', accelerator: NEW_ACCELERATOR, click: () => actions.newItem() },
      { label: 'Pair your phone…', click: () => actions.pairPhone() },
      { type: 'separator' },
      { role: 'close' },
    ],
  };
}

/**
 * The View menu: Electron's own (reload, zoom, full screen) with Show Office Space
 * first, which brings back the home page's office of Bots from any page.
 */
export function viewMenu(actions: { showOffice(): void }): MenuItem {
  return {
    label: 'View',
    submenu: [
      {
        label: 'Show Office Space',
        accelerator: OFFICE_ACCELERATOR,
        click: () => actions.showOffice(),
      },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
}
