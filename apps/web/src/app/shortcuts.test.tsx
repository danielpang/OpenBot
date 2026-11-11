// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { NAV_LINKS } from './nav.js';
import {
  isNewFallbackShortcut,
  isNewShortcut,
  newShortcutLabel,
  officeShortcutLabel,
  opensNew,
  showsOffice,
  useNewShortcut,
} from './shortcuts.js';

const key = (
  k: string,
  mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {},
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('New shortcut', () => {
  it('fires on Cmd+N and Ctrl+N only', () => {
    expect(isNewShortcut(key('n', { metaKey: true }))).toBe(true);
    expect(isNewShortcut(key('N', { ctrlKey: true }))).toBe(true);
    expect(isNewShortcut(key('n'))).toBe(false);
    expect(isNewShortcut(key('n', { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isNewShortcut(key('m', { ctrlKey: true }))).toBe(false);
  });

  it('falls back to Alt+N (Option+N) in a browser, which keeps Cmd/Ctrl+N for itself', () => {
    expect(isNewFallbackShortcut(key('n', { altKey: true }))).toBe(true);
    // Option+N on a Mac is a dead key: only the physical key says N.
    expect(isNewFallbackShortcut({ ...key('Dead', { altKey: true }), code: 'KeyN' })).toBe(true);
    expect(isNewFallbackShortcut(key('n', { altKey: true, ctrlKey: true }))).toBe(false);
    expect(isNewFallbackShortcut(key('n', { altKey: true, shiftKey: true }))).toBe(false);
    expect(isNewFallbackShortcut(key('n'))).toBe(false);
  });

  it('leaves Option+N to type ñ in a text field, and opens New everywhere else', () => {
    const field = document.createElement('textarea');
    const optionN = { ...key('Dead', { altKey: true }), code: 'KeyN' };
    expect(opensNew({ ...optionN, target: field })).toBe(false);
    expect(opensNew({ ...optionN, target: document.body })).toBe(true);
    expect(opensNew({ ...key('n', { altKey: true }), target: field })).toBe(true);
    expect(opensNew({ ...key('n', { metaKey: true }), target: field })).toBe(true);
    expect(opensNew({ ...key('n'), target: field })).toBe(false);
  });

  it('is labelled with the shortcut that works where the app runs', () => {
    expect(newShortcutLabel('MacIntel', true)).toBe('⌘N');
    expect(newShortcutLabel('Win32', true)).toBe('Ctrl+N');
    expect(newShortcutLabel('MacIntel', false)).toBe('⌥N');
    expect(newShortcutLabel('Win32', false)).toBe('Alt+N');
  });

  it("opens from Alt+N and from the Mac app's File > New", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let menu: (() => void) | undefined;
    const off = vi.fn();
    (window as { openbots?: unknown }).openbots = {
      platform: { kind: 'desktop', os: 'darwin', version: '1.0.0', nativeNotifications: true },
      onNavigate: () => () => {},
      onNew: (listener: () => void) => {
        menu = listener;
        return off;
      },
    };
    const onNew = vi.fn();
    function Harness() {
      useNewShortcut(onNew);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    try {
      act(() => root.render(<Harness />));
      const event = new KeyboardEvent('keydown', { key: 'n', altKey: true, cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      menu?.();
      expect(onNew).toHaveBeenCalledTimes(2);
      act(() => root.unmount());
      expect(off).toHaveBeenCalled();
    } finally {
      delete (window as { openbots?: unknown }).openbots;
    }
  });
});

describe('Show Office Space shortcut', () => {
  const field = Object.assign(document.createElement('textarea'));
  it('takes Cmd/Ctrl+Shift+O, and Alt+Shift+O outside text fields', () => {
    expect(showsOffice({ ...key('o', { metaKey: true, shiftKey: true }), target: null })).toBe(true);
    expect(showsOffice({ ...key('O', { ctrlKey: true, shiftKey: true }), target: null })).toBe(true);
    expect(
      showsOffice({ ...key('Ø', { altKey: true, shiftKey: true }), code: 'KeyO', target: null }),
    ).toBe(true);
    expect(
      showsOffice({ ...key('Ø', { altKey: true, shiftKey: true }), code: 'KeyO', target: field }),
    ).toBe(false);
    expect(showsOffice({ ...key('o', { metaKey: true }), target: null })).toBe(false);
  });

  it('labels the keys that work here', () => {
    expect(officeShortcutLabel('MacIntel', true)).toBe('⇧⌘O');
    expect(officeShortcutLabel('MacIntel', false)).toBe('⌥⇧O');
    expect(officeShortcutLabel('Win32', true)).toBe('Ctrl+Shift+O');
  });
});

describe('sidebar links', () => {
  it('lists the account-level pages in PRD order', () => {
    expect(NAV_LINKS.map((l) => l.label)).toEqual(['Connectors', 'Skills', 'Computer', 'Settings']);
  });
});
