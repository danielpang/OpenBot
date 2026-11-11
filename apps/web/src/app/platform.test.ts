import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import {
  applyLiquidGlass,
  hasInsetTitleBar,
  hasLiquidGlass,
  hasNativeNotifications,
  platform,
  WINDOW_DRAG,
  windowDragClass,
} from './platform.js';
import { TitleBarInset } from './sidebar.js';

const desktop = { kind: 'desktop', os: 'darwin', version: '1.0.0', nativeNotifications: true };

describe('platform', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is the web without the Mac app bridge', () => {
    vi.stubGlobal('window', {});
    expect(platform()).toEqual({ kind: 'web' });
    expect(hasNativeNotifications()).toBe(false);
  });

  it('reads the Mac app platform context from window.openbots', () => {
    vi.stubGlobal('window', { openbots: { platform: desktop, onNavigate: () => () => {} } });
    expect(platform()).toEqual(desktop);
    expect(hasNativeNotifications()).toBe(true);
  });

  it('keeps browser notifications when the shell cannot show its own', () => {
    vi.stubGlobal('window', {
      openbots: {
        platform: { ...desktop, nativeNotifications: false },
        onNavigate: () => () => {},
      },
    });
    expect(platform().kind).toBe('desktop');
    expect(hasNativeNotifications()).toBe(false);
  });

  it('clears the traffic lights and drags the window only in the Mac app', () => {
    vi.stubGlobal('window', {});
    expect(hasInsetTitleBar()).toBe(false);
    expect(windowDragClass()).toBeUndefined();
    expect(renderToString(createElement(TitleBarInset))).toBe('');

    vi.stubGlobal('window', { openbots: { platform: desktop, onNavigate: () => () => {} } });
    expect(hasInsetTitleBar()).toBe(true);
    expect(windowDragClass()).toBe(WINDOW_DRAG);
    const strip = renderToString(createElement(TitleBarInset));
    expect(strip).toContain('data-slot="title-bar-inset"');
    expect(strip).toContain('h-8');
    expect(strip).toContain('[-webkit-app-region:drag]');
    // Controls inside a drag region opt out, so they still take clicks.
    expect(WINDOW_DRAG).toContain('[-webkit-app-region:no-drag]');

    // The window keeps its title bar on other systems.
    vi.stubGlobal('window', {
      openbots: { platform: { ...desktop, os: 'win32' }, onNavigate: () => () => {} },
    });
    expect(hasInsetTitleBar()).toBe(false);
    expect(renderToString(createElement(TitleBarInset))).toBe('');
  });

  it('turns on Liquid Glass only when the Mac app window draws the material', () => {
    const root = () => ({ dataset: {} as Record<string, string> }) as unknown as HTMLElement;

    vi.stubGlobal('window', {});
    expect(hasLiquidGlass()).toBe(false);

    // App versions before it, and macOS before 26, leave it out or false.
    vi.stubGlobal('window', { openbots: { platform: desktop, onNavigate: () => () => {} } });
    expect(hasLiquidGlass()).toBe(false);
    const plain = root();
    applyLiquidGlass(plain);
    expect(plain.dataset.glass).toBeUndefined();

    vi.stubGlobal('window', {
      openbots: { platform: { ...desktop, liquidGlass: true }, onNavigate: () => () => {} },
    });
    expect(hasLiquidGlass()).toBe(true);
    const glass = root();
    applyLiquidGlass(glass);
    expect(glass.dataset.glass).toBe('');
  });

  it('ignores something else called openbots', () => {
    vi.stubGlobal('window', { openbots: { platform: { kind: 'other' } } });
    expect(platform()).toEqual({ kind: 'web' });
  });
});
