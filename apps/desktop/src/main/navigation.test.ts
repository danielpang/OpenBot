import { describe, expect, it } from 'vitest';
import { navigationVerdict, serverPath } from './navigation.js';

const SERVER = 'https://openbots.example.com';

describe('navigationVerdict', () => {
  const callback = (provider: string) =>
    encodeURIComponent(`${SERVER}/api/auth/callback/${provider}`);

  it('keeps the server and OAuth sign-in in the window', () => {
    expect(navigationVerdict('https://openbots.example.com/bots/1', SERVER)).toBe('allow');
    expect(navigationVerdict('https://github.com/login/oauth/authorize?x=1', SERVER)).toBe('allow');
    expect(navigationVerdict('https://accounts.google.com/o/oauth2/v2/auth', SERVER)).toBe('allow');
  });

  it("allows the pages of GitHub's and Google's sign-in flows", () => {
    for (const url of [
      `https://github.com/login/oauth/authorize?client_id=c&redirect_uri=${callback('github')}`,
      'https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize',
      'https://github.com/session',
      'https://github.com/sessions/two-factor/app',
      'https://github.com/login/device',
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=c&redirect_uri=${callback('google')}`,
      'https://accounts.google.com/v3/signin/identifier?flowName=GeneralOAuthFlow',
      'https://accounts.google.com/signin/oauth/consent?authuser=0',
      'https://accounts.google.com/v3/signin/challenge/pwd',
      'https://accounts.google.com/AccountChooser',
      'https://accounts.google.com/CheckCookie?continue=x',
    ]) {
      expect(navigationVerdict(url, SERVER), url).toBe('allow');
    }
  });

  it('opens every other GitHub and Google page in the browser', () => {
    for (const url of [
      'https://github.com/',
      'https://github.com/danielpang/OpenBots',
      'https://github.com/danielpang/OpenBots/issues/1',
      'https://github.com/settings/applications',
      'https://github.com/loginx',
      'https://github.com/sessionsx/1',
      'https://gist.github.com/login',
      'https://github.com.evil.example/login/oauth/authorize',
      'https://github.com:8443/login',
      'https://user:pass@github.com/login',
      'https://accounts.google.com/',
      'https://accounts.google.com/b/0/ManageAccount',
      'https://myaccount.google.com/signin',
      'https://docs.google.com/document/d/1',
    ]) {
      expect(navigationVerdict(url, SERVER), url).toBe('external');
    }
  });

  it("opens a connector's OAuth sign-in in the browser, on GitHub and Google too", () => {
    const connector = encodeURIComponent(`${SERVER}/api/v1/connectors/oauth/callback`);
    for (const url of [
      `https://github.com/login/oauth/authorize?client_id=c&redirect_uri=${connector}`,
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=c&redirect_uri=${connector}`,
      `https://vercel.com/oauth/authorize?client_id=c&redirect_uri=${connector}`,
    ]) {
      expect(navigationVerdict(url, SERVER), url).toBe('external');
    }
  });

  it("opens another app's authorization request in the browser", () => {
    const elsewhere = encodeURIComponent('https://evil.example/callback');
    expect(
      navigationVerdict(
        `https://github.com/login/oauth/authorize?client_id=c&redirect_uri=${elsewhere}`,
        SERVER,
      ),
    ).toBe('external');
    expect(
      navigationVerdict(
        `https://accounts.google.com/o/oauth2/v2/auth?client_id=c&redirect_uri=${elsewhere}`,
        SERVER,
      ),
    ).toBe('external');
    expect(
      navigationVerdict('https://github.com/login/oauth/authorize?redirect_uri=nope', SERVER),
    ).toBe('external');
  });

  it('opens other web links in the browser', () => {
    expect(navigationVerdict('https://docs.example.com', SERVER)).toBe('external');
    expect(navigationVerdict('http://github.com/login', SERVER)).toBe('external');
    expect(navigationVerdict('http://openbots.example.com/', SERVER)).toBe('external');
  });

  it('goes nowhere for other schemes', () => {
    expect(navigationVerdict('file:///etc/passwd', SERVER)).toBe('deny');
    expect(navigationVerdict('javascript:alert(1)', SERVER)).toBe('deny');
    expect(navigationVerdict('not a url', SERVER)).toBe('deny');
  });
});

describe('serverPath', () => {
  it('is the path and query on the server, null elsewhere', () => {
    expect(serverPath('https://openbots.example.com/bots/b1?seq=3', SERVER)).toBe('/bots/b1?seq=3');
    expect(serverPath('file:///x/index.html', SERVER)).toBeNull();
    expect(serverPath('', SERVER)).toBeNull();
  });
});
