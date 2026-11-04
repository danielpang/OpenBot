import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { completePairing } from '../services/devices.js';
import { ensureInstanceKey } from '../services/instance-key.js';
import { createTestApp, type TestApp } from '../test-app.js';
import type { CliContext } from './context.js';
import { runDevices } from './devices.js';
import { runPair } from './pair.js';
import { relayHttpBase, runRelay } from './relay.js';

// `openbots pair`, `openbots devices` and `openbots relay` (MOBILE_AND_VM_PLAN.md 4.4).

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

describe('the device commands', () => {
  let t: TestApp;
  let lines: string[];
  let ctx: CliContext;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const fresh = (overrides: Partial<CliContext> = {}): CliContext => {
    lines = [];
    ctx = {
      config: t.deps.config,
      db: t.deps.db,
      infra: t.deps.infra,
      write: (line) => lines.push(line),
      ...overrides,
    };
    return ctx;
  };

  const linkOf = () => lines.find((l) => l.startsWith('openbots://pair#'));

  it('pair prints a QR code that makes the owner on an install with none', async () => {
    expect(await runPair(['--link', '--name', 'Home VM'], fresh())).toBe(0);
    // The QR code: blocks over several lines.
    expect(lines[0]!.split('\n').length).toBeGreaterThan(10);
    expect(lines.join('\n')).toMatch(/expires in 5 minutes/);
    expect(lines.join('\n')).toMatch(/no owner yet: the phone that pairs becomes its owner/);
    expect(lines.join('\n')).toMatch(/no way to reach this server/);
    const link = linkOf()!;
    expect(link).toContain('name=Home%20VM');
    expect(link).toContain('setup=1');
    const [row] = await t.db.select().from(schema.devicePairings);
    expect(row).toMatchObject({ createdBy: 'cli', createsOwner: true, ownerId: null });
    const [audit] = await t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'device.pairing_created'));
    expect(audit).toMatchObject({ actorType: 'system', targetId: row!.id });
  });

  it('pair prints the link only with --link, and takes direct addresses', async () => {
    expect(await runPair(['--direct', 'https://bots.example.com'], fresh())).toBe(0);
    expect(linkOf()).toBeUndefined();
    expect(lines.join('\n')).not.toMatch(/no way to reach/);
    expect(await runPair(['--direct', 'nope'], fresh())).toBe(2);
    expect(await runPair(['--frobnicate'], fresh())).toBe(2);
    expect(lines.join('\n')).toMatch(/usage: openbots pair/);
  });

  it('devices lists and revokes, and pairs from the CLI go to the owner made at pairing', async () => {
    expect(await runDevices([], fresh())).toBe(0);
    expect(lines).toEqual(['No paired devices. Pair one with `openbots pair`.']);

    await t.db.delete(schema.devicePairings);
    await runPair(['--link'], fresh());
    const code = new URLSearchParams(linkOf()!.split('#')[1]).get('code')!;
    const paired = await completePairing({
      db: t.deps.db,
      auth: t.deps.auth,
      config: t.deps.config,
      infra: t.deps.infra,
      body: {
        code,
        name: 'Phone',
        platform: 'ios',
        publicKey: b64(randomBytes(32)),
        pushKey: b64(randomBytes(32)),
        ownerName: 'Daniel',
      },
    });
    expect(paired.owner.name).toBe('Daniel');

    expect(await runDevices(['list'], fresh())).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(paired.device.id);
    expect(lines[0]).toContain('Phone');
    expect(lines[0]).toContain('seen never');

    expect(await runDevices(['revoke', paired.device.id], fresh())).toBe(0);
    const [row] = await t.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, paired.device.id));
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.apiKeyId).toBeNull();
    expect(await runDevices(['revoke', paired.device.id], fresh())).toBe(1);
    expect(await runDevices(['revoke', 'not-a-uuid'], fresh())).toBe(1);
    expect(await runDevices(['revoke'], fresh())).toBe(2);
    expect(await runDevices(['explode'], fresh())).toBe(2);
  });

  it('relay prints the host id, and off with no relay configured', async () => {
    const { hostId } = await ensureInstanceKey({ db: t.deps.db, config: t.deps.config });
    expect(await runRelay([], fresh())).toBe(0);
    expect(lines).toEqual([`host id: ${hostId}`, 'relay off (OPENBOTS_RELAY_URL is not set)']);
  });

  it('relay asks the relay whether it sees this host linked', async () => {
    const { hostId } = await ensureInstanceKey({ db: t.deps.db, config: t.deps.config });
    const asked: string[] = [];
    const config = { ...t.deps.config, relayUrl: 'wss://relay.example.com' };
    const linked = (value: boolean) =>
      (async (url: string) => {
        asked.push(url);
        return Response.json({ hostId, linked: value });
      }) as unknown as typeof fetch;
    expect(await runRelay([], fresh({ config, fetch: linked(true) }))).toBe(0);
    expect(asked).toEqual([`https://relay.example.com/v1/hosts/${hostId}`]);
    expect(lines).toEqual([
      `host id: ${hostId}`,
      'relay: wss://relay.example.com',
      'status: linked',
    ]);
    expect(await runRelay([], fresh({ config, fetch: linked(false) }))).toBe(0);
    expect(lines.at(-1)).toMatch(/^status: not linked/);
    const down = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await runRelay([], fresh({ config, fetch: down }))).toBe(1);
    expect(lines.at(-1)).toMatch(/could not be reached: connect ECONNREFUSED/);
    expect(relayHttpBase('ws://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
  });

  it('refuses on the managed service', async () => {
    const managed = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed' });
    try {
      const out: string[] = [];
      const managedCtx: CliContext = {
        config: managed.deps.config,
        db: managed.deps.db,
        infra: managed.deps.infra,
        write: (line) => out.push(line),
      };
      expect(await runPair([], managedCtx)).toBe(1);
      expect(await runDevices([], managedCtx)).toBe(1);
      expect(out.join('\n')).toMatch(/Settings > Devices/);
      expect(await managed.db.select().from(schema.devicePairings)).toEqual([]);
    } finally {
      await managed.close();
    }
  });
});
