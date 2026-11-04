import { describe, expect, it } from 'vitest';
import { normalizeTunnelPath } from './server.js';

// A tunneled path names a path and query on the server and nothing else: the
// adapter joins it to a loopback origin, so a path that could reach another
// host must never get that far.

describe('normalizeTunnelPath', () => {
  it('keeps a path and its query, and drops a fragment', () => {
    expect(normalizeTunnelPath('/api/v1/bots?x=1')).toBe('/api/v1/bots?x=1');
    expect(normalizeTunnelPath('/ws')).toBe('/ws');
    expect(normalizeTunnelPath('/a#frag')).toBe('/a');
  });

  it('refuses anything that is not a path on this server', () => {
    for (const bad of [
      '',
      'ws',
      '//evil.example/ws',
      'http://evil.example/ws',
      '/a\\b',
      '/a b',
      '/a\nb',
      '/a\u0000b',
    ]) {
      expect(normalizeTunnelPath(bad), bad).toBeNull();
    }
  });
});
