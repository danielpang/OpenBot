import { describe, expect, it, vi } from 'vitest';
import { base64urlEncode } from '@openbots/tunnel';
import { pairHost, parsePairingLink } from './pairing';

const key = base64urlEncode(new Uint8Array(32).fill(1));
const code = base64urlEncode(new Uint8Array(32).fill(2));
const link = `openbots://pair#v=1&host=aaaaaaaaaaaaaaaaaaaaaaaaaa&key=${key}&code=${code}&direct=https%3A%2F%2Fbots.example.com&name=Ada%27s%20Mac%20%2B%20VM`;

describe('pairing', () => {
  it('parses the server fragment encoding and repeated direct paths', () => {
    expect(
      parsePairingLink(`${link}&direct=https%3A%2F%2Fother.example.com&setup=1`),
    ).toMatchObject({
      name: "Ada's Mac + VM",
      setup: true,
      direct: ['https://bots.example.com', 'https://other.example.com'],
    });
  });

  it('accepts only the configured HTTPS universal link origin', () => {
    expect(
      parsePairingLink(link.replace('openbots://pair', 'https://openbots.dev/pair')).host,
    ).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaa');
    for (const origin of [
      'https://evil.example/pair',
      'http://openbots.dev/pair',
      'https://openbots.dev/other',
    ]) {
      expect(() => parsePairingLink(link.replace('openbots://pair', origin))).toThrow();
    }
  });

  it('refuses duplicate security fields, public HTTP, short keys, and unsupported versions', () => {
    for (const input of [
      `${link}&key=${key}`,
      link.replace('v=1', 'v=2'),
      link.replace(key, 'short'),
      link.replace('https%3A', 'http%3A'),
    ]) {
      expect(() => parsePairingLink(input)).toThrow();
    }
  });

  it('exchanges exactly one pairing POST with real device key material', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith('/healthz')) return Response.json({ status: 'ok' });
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(body.code).toBe(code);
      expect(body.platform).toBe('ios');
      expect(body.publicKey).toHaveLength(43);
      expect(body.pushKey).toBe(base64urlEncode(new Uint8Array(32).fill(3)));
      expect(init?.headers).toBeInstanceOf(Headers);
      return Response.json({
        key: 'obk_device-secret',
        device: { id: 'device-1' },
        owner: { id: 'owner-1' },
        setupNeeded: true,
      });
    });
    const paired = await pairHost(parsePairingLink(link), {
      deviceName: ' My phone ',
      fetch: fetchImpl,
      randomBytes: () => new Uint8Array(32).fill(3),
    });
    expect(paired).toMatchObject({
      host: { deviceId: 'device-1', ownerId: 'owner-1' },
      secrets: { apiKey: 'obk_device-secret' },
      setupNeeded: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
