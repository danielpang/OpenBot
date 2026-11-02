import { describe, expect, it, vi } from 'vitest';
import { fileMenu } from './menu.js';

describe('the File menu', () => {
  it('has New on Cmd+N, which opens the New dialog', () => {
    const newItem = vi.fn();
    const menu = fileMenu({ newItem });
    const item = menu.submenu?.find((i) => i.label === 'New…');
    expect(item?.accelerator).toBe('CommandOrControl+N');
    item?.click?.();
    expect(newItem).toHaveBeenCalledOnce();
  });
});
