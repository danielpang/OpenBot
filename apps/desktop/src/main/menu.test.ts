import { describe, expect, it, vi } from 'vitest';
import { fileMenu, viewMenu } from './menu.js';

describe('the File menu', () => {
  it('has New on Cmd+N, which opens the New dialog', () => {
    const newItem = vi.fn();
    const menu = fileMenu({ newItem, pairPhone: vi.fn() });
    const item = menu.submenu?.find((i) => i.label === 'New…');
    expect(item?.accelerator).toBe('CommandOrControl+N');
    item?.click?.();
    expect(newItem).toHaveBeenCalledOnce();
  });

  it('has Pair your phone after New, which opens Settings > Devices', () => {
    const pairPhone = vi.fn();
    const menu = fileMenu({ newItem: vi.fn(), pairPhone });
    const labels = menu.submenu?.map((i) => i.label);
    expect(labels?.indexOf('Pair your phone…')).toBe(labels!.indexOf('New…') + 1);
    menu.submenu?.find((i) => i.label === 'Pair your phone…')?.click?.();
    expect(pairPhone).toHaveBeenCalledOnce();
  });
});

describe('the View menu', () => {
  it('has Show Office Space first, on Cmd+Shift+O, and keeps reload, zoom and full screen', () => {
    const showOffice = vi.fn();
    const menu = viewMenu({ showOffice });
    const first = menu.submenu?.[0];
    expect(first?.label).toBe('Show Office Space');
    expect(first?.accelerator).toBe('CommandOrControl+Shift+O');
    first?.click?.();
    expect(showOffice).toHaveBeenCalledOnce();
    expect(menu.submenu?.map((i) => i.role).filter(Boolean)).toEqual([
      'reload',
      'forceReload',
      'toggleDevTools',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'togglefullscreen',
    ]);
  });
});
