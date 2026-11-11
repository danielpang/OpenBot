import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampPanelWidth,
  MIN_PANEL_WIDTH,
  PANEL_WIDTHS,
  storedPanelWidth,
  storePanelWidth,
} from './right-panel.js';

describe('right panel width', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stays between its minimum and what leaves the page its room', () => {
    expect(clampPanelWidth(100, 1600)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(700, 1600)).toBe(700);
    expect(clampPanelWidth(1500, 1600)).toBe(1000);
    // A narrow window still gets the minimum.
    expect(clampPanelWidth(500, 700)).toBe(MIN_PANEL_WIDTH);
  });

  it('remembers a width per kind of panel and forgets it on reset', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    expect(storedPanelWidth('default')).toBe(PANEL_WIDTHS.default);
    storePanelWidth('default', 620);
    expect(storedPanelWidth('default')).toBe(620);
    expect(storedPanelWidth('wide')).toBe(PANEL_WIDTHS.wide);
    storePanelWidth('default', null);
    expect(storedPanelWidth('default')).toBe(PANEL_WIDTHS.default);
  });

  it('starts at its usual width when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(storedPanelWidth('wide')).toBe(PANEL_WIDTHS.wide);
  });
});
