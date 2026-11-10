import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChunkRecovery } from './chunk-recovery.js';

const saved = new Map<string, string>();
function page(build = 'build-a') {
  const target = new EventTarget();
  const reload = vi.fn();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  };
  vi.stubGlobal('window', Object.assign(target, { location: { reload }, sessionStorage: storage }));
  installChunkRecovery(build);
  const fail = () => {
    const event = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  return { reload, fail, storage, target };
}

afterEach(() => {
  saved.clear();
  vi.unstubAllGlobals();
});

describe('chunk recovery', () => {
  it('reloads a stale tab and suppresses the error while navigating', () => {
    const p = page();
    expect(p.fail().defaultPrevented).toBe(true);
    expect(p.fail().defaultPrevented).toBe(true);
    expect(p.reload).toHaveBeenCalledTimes(1);
  });

  it('does not loop after reload and leaves persistent errors visible', () => {
    page().fail();
    const next = page();
    expect(next.fail().defaultPrevented).toBe(false);
    expect(next.reload).not.toHaveBeenCalled();
  });

  it('allows recovery again after a new build', () => {
    page().fail();
    const next = page('build-b');
    expect(next.fail().defaultPrevented).toBe(true);
    expect(next.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload if session storage is unavailable', () => {
    const p = page();
    vi.spyOn(p.storage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(p.fail().defaultPrevented).toBe(false);
    expect(p.reload).not.toHaveBeenCalled();
  });

  it('does not intercept unrelated errors', () => {
    const p = page();
    p.target.dispatchEvent(new Event('error'));
    expect(p.reload).not.toHaveBeenCalled();
  });
});
