import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { linkHost, makeHost, startRelay } from './test/helpers.js';

// A fake APNs: an HTTP/2 server (cleartext, as a test needs no TLS) that
// checks each request as Apple would read it and answers from a script.

interface Seen {
  headers: http2.IncomingHttpHeaders;
  body: Record<string, unknown>;
  jwtVerifies: boolean;
}

const servers: http2.Http2Server[] = [];
const sessions: http2.ServerHttp2Session[] = [];
afterEach(async () => {
  // The relay may still hold its session open; the fake does not wait for it.
  for (const session of sessions.splice(0)) session.destroy();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function fakeApns(publicKey: KeyObject, answers: { status: number; body?: string }[]) {
  const seen: Seen[] = [];
  const server = http2.createServer();
  server.on('session', (session) => sessions.push(session));
  server.on('stream', (stream, headers) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => (text += chunk));
    stream.on('end', () => {
      const [header, claims, signature] = String(headers.authorization)
        .replace(/^bearer /, '')
        .split('.');
      const jwtVerifies = verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature ?? '', 'base64url'),
      );
      seen.push({ headers, body: JSON.parse(text) as Record<string, unknown>, jwtVerifies });
      const answer = answers.shift() ?? { status: 500 };
      stream.respond({ ':status': answer.status, 'content-type': 'application/json' });
      stream.end(answer.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const TOKEN = 'a1'.repeat(32);

function pushFrame(id: string) {
  return {
    type: 'push',
    id,
    platform: 'ios',
    token: TOKEN,
    ciphertext: 'c2VhbGVkIG5vdGljZQ',
    collapseId: 'approval:42',
    priority: 10,
    expiresAt: 1_800_000_000,
    threadId: 'bot-1',
  };
}

describe('push', () => {
  it('answers unavailable without APNs credentials', async () => {
    const relay = await startRelay();
    const link = await linkHost(relay, makeHost());
    link.send(pushFrame('p1'));
    expect(await link.text()).toEqual({
      type: 'push.result',
      id: 'p1',
      ok: false,
      reason: 'unavailable',
      status: null,
    });
  });

  it('sends to APNs and maps 200 to ok and 410 to unregistered', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const apns = await fakeApns(publicKey, [
      { status: 200 },
      { status: 410, body: '{"reason":"Unregistered"}' },
      { status: 400, body: '{"reason":"BadDeviceToken"}' },
      { status: 503, body: '{"reason":"ServiceUnavailable"}' },
    ]);
    const relay = await startRelay({
      apns: {
        keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        keyId: 'KEYID12345',
        teamId: 'TEAM123456',
        topic: 'dev.openbots.app',
        origin: apns.origin,
      },
    });
    const link = await linkHost(relay, makeHost());

    link.send(pushFrame('p1'));
    expect(await link.text()).toEqual({ type: 'push.result', id: 'p1', ok: true });
    link.send(pushFrame('p2'));
    expect(await link.text()).toEqual({
      type: 'push.result',
      id: 'p2',
      ok: false,
      reason: 'unregistered',
      status: 410,
    });
    link.send(pushFrame('p3'));
    expect(await link.text()).toMatchObject({ id: 'p3', reason: 'invalid', status: 400 });
    link.send(pushFrame('p4'));
    expect(await link.text()).toMatchObject({ id: 'p4', reason: 'error', status: 503 });

    const [first] = apns.seen;
    expect(first!.jwtVerifies).toBe(true);
    expect(first!.headers).toMatchObject({
      ':method': 'POST',
      ':path': `/3/device/${TOKEN}`,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '1800000000',
      'apns-collapse-id': 'approval:42',
      'apns-topic': 'dev.openbots.app',
    });
    const [header, claims] = String(first!.headers.authorization)
      .replace(/^bearer /, '')
      .split('.')
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()) as unknown);
    expect(header).toEqual({ alg: 'ES256', kid: 'KEYID12345' });
    expect(claims).toMatchObject({ iss: 'TEAM123456', iat: expect.any(Number) });
    expect(first!.body).toEqual({
      aps: {
        alert: { title: 'OpenBots', body: 'You have a notification' },
        'mutable-content': 1,
        'thread-id': 'bot-1',
      },
      enc: 'c2VhbGVkIG5vdGljZQ',
    });
    // One token serves every request until it is 50 minutes old.
    expect(new Set(apns.seen.map((s) => s.headers.authorization)).size).toBe(1);
  });

  it('answers error 429 past the pushes of the hour', async () => {
    const relay = await startRelay({ limits: { pushesPerHour: 2 } });
    const link = await linkHost(relay, makeHost());
    for (const id of ['p1', 'p2']) {
      link.send(pushFrame(id));
      expect(await link.text()).toMatchObject({ id, reason: 'unavailable' });
    }
    link.send(pushFrame('p3'));
    expect(await link.text()).toEqual({
      type: 'push.result',
      id: 'p3',
      ok: false,
      reason: 'error',
      status: 429,
    });
  });

  it('answers invalid for a push frame that does not parse', async () => {
    const relay = await startRelay();
    const link = await linkHost(relay, makeHost());
    link.send({ ...pushFrame('p1'), token: 'NOT HEX' });
    expect(await link.text()).toMatchObject({ id: 'p1', ok: false, reason: 'invalid' });
  });

  it('closes 4400 for a push on a link that did not offer push', async () => {
    const relay = await startRelay();
    const link = await linkHost(relay, makeHost(), ['streams']);
    link.send(pushFrame('p1'));
    expect(await link.text()).toMatchObject({ type: 'error', code: 'protocol' });
    expect((await link.closed).code).toBe(4400);
  });
});
