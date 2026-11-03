import { describe, expect, it, vi } from 'vitest';
import { fileMenu } from './menu.js';

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
