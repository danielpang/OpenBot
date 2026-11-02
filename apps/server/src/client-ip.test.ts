import { describe, expect, it } from 'vitest';
import { inRanges, isCidr, resolveClientIp } from './client-ip.js';

const TUNNEL = ['172.16.0.0/12', 'fd00::/8'];

describe('resolveClientIp', () => {
  it('ignores X-Forwarded-For when no proxy is trusted', () => {
    expect(resolveClientIp('198.51.100.9', '203.0.113.5', [])).toBe('198.51.100.9');
    expect(resolveClientIp('172.18.0.4', '203.0.113.5', [])).toBe('172.18.0.4');
  });

  it('ignores X-Forwarded-For from a peer that is not a trusted proxy', () => {
    expect(resolveClientIp('198.51.100.9', '203.0.113.5', TUNNEL)).toBe('198.51.100.9');
  });

  it('takes the right-most untrusted hop behind a trusted proxy', () => {
    // A client sending a forged header gets its real address appended.
    expect(resolveClientIp('172.18.0.4', '203.0.113.5, 198.51.100.9', TUNNEL)).toBe('198.51.100.9');
    // Trusted hops are skipped.
    expect(resolveClientIp('172.18.0.4', '198.51.100.9, 172.18.0.9, fd00::2', TUNNEL)).toBe(
      '198.51.100.9',
    );
    // Every hop trusted: the left-most one is all there is.
    expect(resolveClientIp('172.18.0.4', '172.18.0.7, 172.18.0.9', TUNNEL)).toBe('172.18.0.7');
    // No header: the proxy itself.
    expect(resolveClientIp('172.18.0.4', undefined, TUNNEL)).toBe('172.18.0.4');
  });

  it('normalizes IPv4-mapped addresses and gives up on malformed hops', () => {
    expect(resolveClientIp('::ffff:172.18.0.4', '::ffff:203.0.113.5', TUNNEL)).toBe('203.0.113.5');
    expect(resolveClientIp('172.18.0.4', '203.0.113.5, not-an-ip', TUNNEL)).toBeNull();
    expect(resolveClientIp(undefined, '203.0.113.5', TUNNEL)).toBeNull();
  });
});

describe('CIDR helpers', () => {
  it('accepts addresses and ranges and checks membership', () => {
    expect(['10.0.0.0/8', '127.0.0.1', '::1', 'fd00::/8'].every(isCidr)).toBe(true);
    expect(['10.0.0.0/33', 'x', '10.0.0.0/8/2', '10.0.0.0/-1', ''].some(isCidr)).toBe(false);
    expect(inRanges('172.31.255.1', TUNNEL)).toBe(true);
    expect(inRanges('172.32.0.1', TUNNEL)).toBe(false);
    expect(inRanges('fd12::1', TUNNEL)).toBe(true);
    expect(inRanges('172.18.0.1', [])).toBe(false);
  });
});
