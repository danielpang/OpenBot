import { describe, expect, it } from 'vitest';
import { HTTP_WARNING, isPrivateHost, parseServerAddress, ServerUrlError } from './server-url.js';

describe('parseServerAddress', () => {
  it('uses https by default and keeps the origin only', () => {
    expect(parseServerAddress(' openbots.example.com ')).toEqual({
      url: 'https://openbots.example.com',
      warning: null,
    });
    expect(parseServerAddress('https://openbots.example.com:8443/app?x=1').url).toBe(
      'https://openbots.example.com:8443',
    );
  });

  it('allows http for this Mac and private networks, with a warning', () => {
    for (const input of [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://192.168.1.4:3000',
      'http://10.0.0.2',
      'http://172.20.1.1',
      'http://100.101.102.103',
      'http://nas.local:3000',
      'http://[::1]:3000',
      'http://[fd12::1]',
    ]) {
      expect(parseServerAddress(input)).toEqual({ url: input, warning: HTTP_WARNING });
    }
  });

  it('defaults a private address without a scheme to http', () => {
    expect(parseServerAddress('localhost:3000')).toEqual({
      url: 'http://localhost:3000',
      warning: HTTP_WARNING,
    });
    expect(parseServerAddress('192.168.1.4:3000').url).toBe('http://192.168.1.4:3000');
  });

  it('refuses http on the internet, other schemes, credentials and blanks', () => {
    expect(() => parseServerAddress('http://openbots.example.com')).toThrow(/Use https/);
    expect(() => parseServerAddress('http://8.8.8.8')).toThrow(/Use https/);
    expect(() => parseServerAddress('http://172.32.0.1')).toThrow(/Use https/);
    expect(() => parseServerAddress('ftp://openbots.example.com')).toThrow(/starts with https/);
    expect(() => parseServerAddress('https://me:pw@openbots.example.com')).toThrow(/user name/);
    expect(() => parseServerAddress('   ')).toThrow(ServerUrlError);
    expect(() => parseServerAddress('https://')).toThrow(ServerUrlError);
  });

  it('knows private hosts', () => {
    expect(isPrivateHost('LOCALHOST')).toBe(true);
    expect(isPrivateHost('box.lan')).toBe(true);
    expect(isPrivateHost('169.254.1.1')).toBe(true);
    expect(isPrivateHost('[fe80::1]')).toBe(true);
    expect(isPrivateHost('openbots.example.com')).toBe(false);
    expect(isPrivateHost('100.128.0.1')).toBe(false);
    expect(isPrivateHost('2001:db8::1')).toBe(false);
  });
});
