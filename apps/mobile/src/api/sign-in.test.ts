import { describe, expect, it, vi } from 'vitest';
import { signInAndPair } from './sign-in';
import { base64urlEncode } from '@openbots/tunnel';
const encoded = base64urlEncode(new Uint8Array(32).fill(3));
const link = `openbots://pair#v=1&host=${'a'.repeat(26)}&key=${encoded}&code=${encoded}&direct=https%3A%2F%2Fbots.example&name=My%20server`;
describe('password sign-in establishes independently revocable device credentials', () => {
  it('creates one-use pairing, uses session only during setup and signs out after success', async () => {
    const calls: { url: string; body?: unknown }[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      calls.push({ url: req.url, body: req.method === 'POST' ? await req.json() : undefined });
      if (req.url.endsWith('/sign-in/email'))
        return Response.json({ token: 'session-never-stored' });
      if (req.url.endsWith('/devices/pairings'))
        return Response.json({ link, id: 'pairing', expiresAt: '2026-01-01', qr: link });
      if (req.url.endsWith('/healthz')) return Response.json({ ok: true });
      if (req.url.endsWith('/devices/pair'))
        return Response.json({
          key: 'obk_device',
          device: { id: 'device' },
          owner: { id: 'owner' },
          setupNeeded: false,
        });
      if (req.url.endsWith('/sign-out')) return Response.json({ success: true });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const result = await signInAndPair(
      {
        address: 'https://bots.example',
        email: 'a@example.com',
        password: 'password-only-sentinel',
        deviceName: 'iPhone',
      },
      request,
    );
    expect(result.secrets.apiKey).toBe('obk_device');
    expect(result.host.deviceId).toBe('device');
    expect(JSON.stringify(result)).not.toContain('password-only-sentinel');
    expect(calls.at(-1)?.url).toBe('https://bots.example/api/auth/sign-out');
    expect(
      calls.filter((call) => JSON.stringify(call.body ?? null).includes('password-only-sentinel')),
    ).toHaveLength(1);
  });
  it('clears the session even when pairing creation fails', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ token: 'session' }))
      .mockResolvedValueOnce(Response.json({ detail: 'Unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    await expect(
      signInAndPair(
        {
          address: 'https://bots.example',
          email: 'a@example.com',
          password: 'password-only-sentinel',
          deviceName: 'iPhone',
        },
        fetcher,
      ),
    ).rejects.toThrow('Unavailable');
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://bots.example/api/auth/sign-out');
  });
});
