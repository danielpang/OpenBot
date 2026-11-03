import {
  createRelay,
  type PushGateway,
  type PushOutcome,
  type PushRequest,
  type Relay,
} from '@openbots/relay';
import { EVENTS_CHANNEL, wsEvent, type WsEvent } from '@openbots/shared';
import { connectThroughRelay, hostPresence, RelayConnectError } from '@openbots/tunnel';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { publishEvent } from '../infra/index.js';
import { registry } from '../metrics.js';
import { createPairing, pairingCodeHash } from '../services/devices.js';
import { ensureInstanceKey, type InstanceKey } from '../services/instance-key.js';
import { createTestApp, type TestApp } from '../test-app.js';
import {
  createRelayLink,
  DEFAULT_LINK_TIMING,
  relayCloseCode,
  type HostRelayLink,
} from './link.js';

// The host link against a real relay in process: linking, status and its
// `relay.status` events, backoff, dialing only while a device or pairing
// exists (and finding one the CLI made), and push.

const FAST = {
  initialBackoffMs: 50,
  maxBackoffMs: 400,
  offCheckMs: 60_000,
  linkTimeoutMs: 2_000,
  pushTimeoutMs: 2_000,
};

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const wsUrl = (relay: Relay) => relay.url.replace(/^http/, 'ws');

describe('relay link', () => {
  let t: TestApp;
  let relay: Relay;
  let instance: InstanceKey;
  let deps: AppDeps;
  let workspaceId: string;
  let ownerId: string;
  const pushes: PushRequest[] = [];
  let outcome: PushOutcome = { ok: true };
  const gateway: PushGateway = {
    send: async (push) => {
      pushes.push(push);
      return outcome;
    },
    close: async () => {},
  };
  const links: HostRelayLink[] = [];

  const link = async (extra: Partial<Parameters<typeof createRelayLink>[1]> = {}) => {
    const made = await createRelayLink(deps, { instance, timing: FAST, ...extra });
    links.push(made);
    return made;
  };

  const pair = () =>
    createPairing({
      db: deps.db,
      config: deps.config,
      workspaceId,
      ownerId,
      createdBy: 'user',
      actor: { type: 'user', id: ownerId },
    });

  const clearPairings = () => t.db.delete(schema.devicePairings);

  beforeAll(async () => {
    relay = await createRelay({ port: 0, host: '127.0.0.1', apns: gateway });
    t = await createTestApp();
    await t.signUp('owner@example.com');
    ownerId = await t.userId('owner@example.com');
    workspaceId = await t.defaultOrganization();
    deps = { ...t.deps, config: { ...t.deps.config, relayUrl: wsUrl(relay) } };
    instance = await ensureInstanceKey({ db: t.deps.db, config: t.deps.config });
  });

  afterEach(async () => {
    await Promise.all(links.splice(0).map((l) => l.stop()));
    await clearPairings();
    pushes.length = 0;
    outcome = { ok: true };
  });

  afterAll(async () => {
    await relay.close();
    await t.close();
  });

  it('stays off and makes no connection while there is no device or pairing', async () => {
    const l = await link();
    expect(l.status()).toEqual({
      hostId: instance.hostId,
      relayUrl: wsUrl(relay),
      status: 'off',
      since: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await hostPresence({ relayUrl: relay.url, hostId: instance.hostId })).toBe(false);
    await expect(
      l.push({ platform: 'ios', token: 'ab', ciphertext: 'x', priority: 5, expiresAt: 1 }),
    ).rejects.toThrow(/not linked/);
  });

  it('dials on wake once a pairing is open, links, and reports it', async () => {
    const l = await link();
    await pair();
    l.wake();
    await waitFor(() => l.status().status === 'linked');
    expect(l.status().since).not.toBeNull();
    expect(await hostPresence({ relayUrl: relay.url, hostId: instance.hostId })).toBe(true);
    const metrics = await registry.getSingleMetricAsString('openbots_relay_linked');
    expect(metrics).toMatch(/openbots_relay_linked 1/);
  });

  it('createPairing wakes the link it is given', async () => {
    const l = await link();
    expect(l.status().status).toBe('off');
    await createPairing({
      db: deps.db,
      config: deps.config,
      workspaceId,
      ownerId,
      createdBy: 'user',
      actor: { type: 'user', id: ownerId },
      relay: l,
    });
    await waitFor(() => l.status().status === 'linked');
  });

  it('finds a pairing another process made within its off check, with no wake and no event', async () => {
    expect(DEFAULT_LINK_TIMING.offCheckMs).toBe(10_000);
    const l = await link({ timing: { ...FAST, offCheckMs: 100 } });
    expect(l.status().status).toBe('off');
    // As `openbots pair` would in its own process: a row, and nothing told to this one.
    await t.db.insert(schema.devicePairings).values({
      workspaceId,
      ownerId,
      codeHash: pairingCodeHash(crypto.getRandomValues(new Uint8Array(32))),
      directUrls: [],
      name: 'Server',
      createsOwner: false,
      expiresAt: new Date(Date.now() + 5 * 60_000),
      createdBy: 'cli',
    });
    await waitFor(() => l.status().status === 'linked');
  });

  it('publishes relay.status to the owner as it changes, the GET /relay payload', async () => {
    const events: WsEvent[] = [];
    const off = await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (event) => {
      if (event.type === 'relay.status') events.push(event);
    });
    try {
      await pair();
      const l = await link();
      await waitFor(() => events.some((e) => e.payload.status === 'linked'));
      const linked = events.find((e) => e.payload.status === 'linked')!;
      expect(linked).toMatchObject({ user_id: ownerId, workspace_id: workspaceId });
      expect(linked.payload).toEqual(l.status());
      expect(events.map((e) => e.payload.status)).toEqual(['connecting', 'linked']);
      // Once nothing is left the link goes off, and the owner it told hears that too.
      await clearPairings();
      await l.stop();
      expect(events.at(-1)).toMatchObject({
        user_id: ownerId,
        payload: { status: 'off', hostId: instance.hostId },
      });
    } finally {
      await off();
    }
  });

  it('publishes no relay.status from a push only link', async () => {
    const events: WsEvent[] = [];
    const off = await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (event) => {
      if (event.type === 'relay.status') events.push(event);
    });
    try {
      await pair();
      const l = await link({ capabilities: ['push'] });
      await waitFor(() => l.status().status === 'linked');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual([]);
    } finally {
      await off();
    }
  });

  it('links at start when a pairing is already open', async () => {
    await pair();
    const l = await link();
    expect(l.status().status).toBe('connecting');
    await waitFor(() => l.status().status === 'linked');
  });

  it('goes off when the last pairing and device are gone and a device event says so', async () => {
    await pair();
    const l = await link();
    await waitFor(() => l.status().status === 'linked');
    await clearPairings();
    await publishEvent(
      t.deps.infra.bus,
      wsEvent(
        'device.revoked',
        {
          device: {
            id: crypto.randomUUID(),
            name: 'Phone',
            platform: 'ios',
            createdAt: new Date().toISOString(),
            revokedAt: new Date().toISOString(),
          },
        },
        { user_id: ownerId, workspace_id: workspaceId },
      ),
    );
    await waitFor(() => l.status().status === 'off');
    await waitFor(
      async () => !(await hostPresence({ relayUrl: relay.url, hostId: instance.hostId })),
    );
  });

  it('carries a push to the relay and answers its result', async () => {
    await pair();
    const l = await link();
    await waitFor(() => l.status().status === 'linked');
    const request = {
      platform: 'ios' as const,
      token: 'abcdef0123',
      ciphertext: 'c2VhbGVk',
      collapseId: 'approval:1',
      priority: 10 as const,
      expiresAt: 1_900_000_000,
      threadId: 'bot-1',
    };
    expect(await l.push(request)).toEqual({ ok: true });
    expect(pushes).toEqual([
      {
        token: request.token,
        ciphertext: request.ciphertext,
        collapseId: request.collapseId,
        priority: 10,
        expiresAt: request.expiresAt,
        threadId: 'bot-1',
      },
    ]);
    outcome = { ok: false, reason: 'unregistered', status: 410 };
    expect(await l.push(request)).toEqual({ ok: false, reason: 'unregistered', status: 410 });
    // Several at once each get their own answer.
    outcome = { ok: true };
    const results = await Promise.all([1, 2, 3].map(() => l.push(request)));
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
  });

  it('reconnects with backoff when the relay goes away and comes back', async () => {
    const own = await createRelay({ port: 0, host: '127.0.0.1' });
    const port = own.port;
    const ownDeps = { ...deps, config: { ...deps.config, relayUrl: wsUrl(own) } };
    await pair();
    const l = await createRelayLink(ownDeps, { instance, timing: FAST });
    links.push(l);
    await waitFor(() => l.status().status === 'linked');
    await own.close();
    await waitFor(() => l.status().status === 'connecting');
    // A few failed dials while it is down, then it comes back on the same port.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const back = await createRelay({ port, host: '127.0.0.1' });
    try {
      await waitFor(() => l.status().status === 'linked', 5_000);
      expect(await hostPresence({ relayUrl: back.url, hostId: instance.hostId })).toBe(true);
    } finally {
      await l.stop();
      await back.close();
    }
  });

  it('offers no streams from a push only link', async () => {
    await pair();
    const l = await link({ capabilities: ['push'] });
    await waitFor(() => l.status().status === 'linked');
    const error = await connectThroughRelay({
      relayUrl: wsUrl(relay),
      hostId: instance.hostId,
      createSocket: (url) => new WebSocket(url),
      timeoutMs: 2_000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayConnectError);
    expect((error as RelayConnectError).code).toBe(4404);
  });

  it('stop closes the link and leaves it off', async () => {
    await pair();
    const l = await link();
    await waitFor(() => l.status().status === 'linked');
    await l.stop();
    expect(l.status().status).toBe('off');
    await waitFor(
      async () => !(await hostPresence({ relayUrl: relay.url, hostId: instance.hostId })),
    );
  });

  it('passes on only the close codes the relay accepts', () => {
    expect(relayCloseCode(1000)).toBe(1000);
    expect(relayCloseCode(4429)).toBe(4429);
    expect(relayCloseCode(1001)).toBe(1000);
    expect(relayCloseCode(1011)).toBe(1000);
    expect(relayCloseCode(undefined)).toBe(1000);
  });
});
