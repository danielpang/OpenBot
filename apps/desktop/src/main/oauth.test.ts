import { describe, expect, it, vi } from 'vitest';
import { OAUTH_FOCUS_MS, authorizationUrl, createOAuthBrowser } from './oauth.js';

function setup() {
  let time = 1_000;
  const openExternal = vi.fn(async (_url: string) => undefined);
  const focus = vi.fn();
  const browser = createOAuthBrowser({ openExternal, focus, now: () => time });
  return { browser, openExternal, focus, later: (ms: number) => (time += ms) };
}

describe('the OAuth sign-in in the default browser', () => {
  it('opens only plain http and https URLs', () => {
    expect(authorizationUrl('https://vercel.com/oauth/authorize?state=s')).toBe(
      'https://vercel.com/oauth/authorize?state=s',
    );
    for (const raw of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'openbots://connectors',
      'https://user:pass@example.com/authorize',
      'not a url',
    ]) {
      expect(() => authorizationUrl(raw), raw).toThrow();
    }
  });

  it('opens the page with shell.openExternal, never in a window of the app', async () => {
    const { browser, openExternal } = setup();
    await browser.open('https://mcp.example.com/authorize?client_id=c');
    expect(openExternal).toHaveBeenCalledWith('https://mcp.example.com/authorize?client_id=c');
    await expect(browser.open('file:///Applications')).rejects.toThrow(/http or https/);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('brings the app to the front once per sign-in it opened', async () => {
    const { browser, focus, later } = setup();
    expect(browser.finished()).toBe(false);
    expect(focus).not.toHaveBeenCalled();

    await browser.open('https://mcp.example.com/authorize');
    later(30_000);
    expect(browser.finished()).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    // A page cannot keep pulling the window forward.
    expect(browser.finished()).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('does not take the focus for a sign-in older than the server keeps it', async () => {
    const { browser, focus, later } = setup();
    await browser.open('https://mcp.example.com/authorize');
    later(OAUTH_FOCUS_MS + 1);
    expect(browser.finished()).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });
});
