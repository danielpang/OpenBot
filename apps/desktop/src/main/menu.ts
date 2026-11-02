// The app menu's File menu (B2). New opens the web app's New dialog: the
// page gets Cmd+N in the app, but a menu item with the accelerator makes it
// work from anywhere in the app and shows the shortcut where Mac users look.

export const NEW_ACCELERATOR = 'CommandOrControl+N';

/** A menu item as Electron's `Menu.buildFromTemplate` takes it, without Electron. */
export interface MenuItem {
  label?: string;
  role?: 'close';
  type?: 'normal' | 'separator' | 'submenu';
  accelerator?: string;
  submenu?: MenuItem[];
  click?: () => void;
}

export function fileMenu(actions: { newItem(): void }): MenuItem {
  return {
    label: 'File',
    submenu: [
      { label: 'New…', accelerator: NEW_ACCELERATOR, click: () => actions.newItem() },
      { type: 'separator' },
      { role: 'close' },
    ],
  };
}
