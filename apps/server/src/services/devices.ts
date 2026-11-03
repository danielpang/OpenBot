import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { wsEvent } from '@openbots/shared';
import { and, count, desc, eq, gt, isNull, isNotNull, lte, or, sql } from 'drizzle-orm';
import { findInstallOwner, type Auth } from '../auth.js';
import type { Config } from '../config.js';
import type { AppDeps, RelayLink } from '../context.js';
import { schema, type Db } from '../db/client.js';
import {
  asDirectory,
  deviceWorkspace,
  devicesExist,
  inWorkspace,
  pairingWorkspace,
} from '../db/scope.js';
import type { DevicePlatform, PairingCreator } from '../db/schema/devices.js';
import { DomainError, notFound } from '../errors.js';
import { publishEvent, type Infra } from '../infra/index.js';
import { encryptSecret, keyringFromConfig } from '../secrets.js';
import { recordAudit, type AuditActor } from './audit.js';
import { ensureInstanceKey } from './instance-key.js';

// Devices and pairing (docs/RELAY_PROTOCOL.md sections 2 and 6;
// MOBILE_AND_VM_PLAN.md section 4). A device is a phone (or later a desktop)
// that holds one of its owner's API keys, a Noise static key the relay
// adapter knows it by, and a push key. It is enrolled with a pairing: a 32
// byte code in a link shown as a QR code, good for 5 minutes and once,
// stored only as its SHA-256.
//
// Pairing runs with no sign-in, so the code is all there is: its
// organization is found through openbots_pairing_workspace() (db/scope.ts),
// the code is compared there in constant time, and it is spent with a
// conditional update so two phones racing for one code cannot both win.
// Every refusal is the same 401 PAIRING_INVALID. The route rate-limits by
// client and by code (routes/devices.ts).
//
// On a self-hosted install with no owner yet (headless first run, plan
// 8.3) the pairing makes the owner, the way the Mac app's local sign-in
// does (auth.ts `createPairingOwner`).

export const PAIRING_TTL_MS = 5 * 60_000;
export const MAX_OPEN_PAIRINGS = 5;
export const PAIRING_CODE_BYTES = 32;
/** A device's static key and push key are 32 bytes each. */
export const DEVICE_KEY_BYTES = 32;
/** Placeholder for a new owner who gave no name (as local.ts). */
export const DEFAULT_PAIRED_OWNER_NAME = 'Me';
/** How often the workers drop spent pairings. */
export const PAIRING_SWEEP_MS = 5 * 60_000;
/** How often `touchDevice` writes `last_seen_at` for one device at most. */
export const TOUCH_INTERVAL_MS = 60_000;
/** better-auth's api-key plugin refuses longer names. */
const API_KEY_NAME_MAX = 32;

export type DeviceRow = typeof schema.devices.$inferSelect;
export type PairingRow = typeof schema.devicePairings.$inferSelect;

/** What the pairing link carries (RELAY_PROTOCOL.md 6.1), as `POST /devices/pairings` answers it. */
export interface PairingQr {
  v: 1;
  host: string;
  key: string;
  code: string;
  relay: string | null;
  direct: string[];
  name: string;
  setup: boolean;
}

export interface CreatedPairing {
  id: string;
  expiresAt: string;
  link: string;
  qr: PairingQr;
}

export interface DeviceSummary {
  id: string;
  name: string;
  platform: DevicePlatform;
  createdAt: string;
  lastSeenAt: string | null;
  pushRegistered: boolean;
}

export const pairingInvalid = () =>
  new DomainError(401, 'PAIRING_INVALID', 'This pairing code is not valid. Make a new one.');

export const pairingKeyMismatch = () =>
  new DomainError(
    400,
    'PAIRING_KEY_MISMATCH',
    'The public key is not the one this connection was opened with',
  );

export const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** base64url (no padding) to bytes, or null when it is not exactly that. */
export function fromBase64url(value: string, length?: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return null;
  if (length !== undefined && bytes.length !== length) return null;
  return bytes;
}

/** The SHA-256 a pairing code is stored and looked up as. */
export function pairingCodeHash(code: Uint8Array): Buffer {
  return createHash('sha256').update(code).digest();
}

/** The link of RELAY_PROTOCOL.md 6.1: each value percent-encoded with encodeURIComponent. */
export function pairingLink(qr: PairingQr): string {
  const fields: [string, string][] = [
    ['v', String(qr.v)],
    ['host', qr.host],
    ['key', qr.key],
    ['code', qr.code],
  ];
  if (qr.relay) fields.push(['relay', qr.relay]);
  for (const url of qr.direct) fields.push(['direct', url]);
  fields.push(['name', qr.name]);
  if (qr.setup) fields.push(['setup', '1']);
  return `openbots://pair#${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

/** OPENBOTS_PUBLIC_URL as a direct address, when it is https. */
export function defaultDirectUrls(config: Pick<Config, 'publicUrl'>): string[] {
  const url = new URL(config.publicUrl);
  return url.protocol === 'https:' ? [config.publicUrl.replace(/\/+$/, '')] : [];
}

const iso = (date: Date | string | null | undefined) =>
  date ? new Date(date).toISOString() : null;

export function toDeviceSummary(row: DeviceRow): DeviceSummary {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    createdAt: iso(row.createdAt)!,
    lastSeenAt: iso(row.lastSeenAt),
    pushRegistered: row.pushToken !== null,
  };
}

const eventDevice = (row: DeviceRow) => ({
  id: row.id,
  name: row.name,
  platform: row.platform,
  createdAt: iso(row.createdAt)!,
  revokedAt: iso(row.revokedAt),
});

/** Serializes making pairings for one owner, so the cap holds under concurrent requests. */
function lockPairings(db: Db, workspaceId: string, ownerId: string | null) {
  return db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`pairings:${workspaceId}:${ownerId ?? ''}`}))`,
  );
}

export interface CreatePairingInput {
  db: Db;
  config: Config;
  workspaceId: string;
  /** The account the device will belong to; null on a self-hosted install with no owner yet. */
  ownerId: string | null;
  /** The server's name in the link; the organization's name when absent. */
  name?: string;
  /** Direct addresses; OPENBOTS_PUBLIC_URL when absent and https. */
  direct?: string[];
  createdBy: PairingCreator;
  /** Who made it, for the audit log; the system for the CLI. */
  actor: AuditActor;
  /**
   * This process's relay link, woken so it dials now that a pairing is open.
   * The CLI has none: a running server finds the pairing within a minute.
   */
  relay?: Pick<RelayLink, 'wake'>;
}

/**
 * Makes a pairing and its link (RELAY_PROTOCOL.md 6.1). At most
 * MAX_OPEN_PAIRINGS open per owner (409 TOO_MANY_PAIRINGS). With no owner
 * (self-hosted only), the pairing makes one, and the link says `setup=1`.
 */
export async function createPairing(input: CreatePairingInput): Promise<CreatedPairing> {
  const { db, config, workspaceId, createdBy, actor } = input;
  const instance = await ensureInstanceKey({ db, config });
  let ownerId = input.ownerId;
  if (!ownerId) {
    if (config.deployment !== 'self_hosted') {
      throw new DomainError(409, 'NO_OWNER', 'A pairing on the managed service needs an account');
    }
    ownerId = (await findInstallOwner(db)) ?? null;
  }
  const createsOwner = ownerId === null;
  return inWorkspace(workspaceId, async () => {
    const [workspace] = await db
      .select({ name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    if (!workspace) throw notFound('Organization not found');
    const name = input.name?.trim() || workspace.name;
    const direct = input.direct ?? defaultDirectUrls(config);
    const code = randomBytes(PAIRING_CODE_BYTES);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
    const pairing = await db.transaction(async (tx) => {
      await lockPairings(tx, workspaceId, ownerId);
      const [open] = await tx
        .select({ n: count() })
        .from(schema.devicePairings)
        .where(
          and(
            eq(schema.devicePairings.workspaceId, workspaceId),
            ownerId
              ? eq(schema.devicePairings.ownerId, ownerId)
              : isNull(schema.devicePairings.ownerId),
            isNull(schema.devicePairings.usedAt),
            gt(schema.devicePairings.expiresAt, now),
          ),
        );
      if ((open?.n ?? 0) >= MAX_OPEN_PAIRINGS) {
        throw new DomainError(
          409,
          'TOO_MANY_PAIRINGS',
          `At most ${MAX_OPEN_PAIRINGS} pairings can be open at once. Wait for one to expire.`,
        );
      }
      const [row] = await tx
        .insert(schema.devicePairings)
        .values({
          workspaceId,
          ownerId,
          codeHash: pairingCodeHash(code),
          directUrls: direct,
          name,
          createsOwner,
          expiresAt,
          createdBy,
        })
        .returning();
      return row!;
    });
    await recordAudit(db, {
      workspaceId,
      actor,
      action: 'device.pairing_created',
      targetType: 'device_pairing',
      targetId: pairing.id,
      metadata: { createdBy, createsOwner, expiresAt: expiresAt.toISOString(), direct },
    });
    input.relay?.wake();
    const qr: PairingQr = {
      v: 1,
      host: instance.hostId,
      key: base64url(instance.tunnelPublicKey),
      code: base64url(code),
      relay: config.relayUrl ?? null,
      direct,
      name,
      setup: createsOwner,
    };
    return { id: pairing.id, expiresAt: expiresAt.toISOString(), link: pairingLink(qr), qr };
  });
}

export interface PairRequest {
  code: string;
  name: string;
  platform: DevicePlatform;
  publicKey: string;
  pushKey: string;
  ownerName?: string;
}

export interface PairResult {
  device: { id: string; name: string; platform: DevicePlatform; createdAt: string };
  key: string;
  owner: { id: string; name: string };
  setupNeeded: boolean;
}

export interface CompletePairingInput {
  db: Db;
  auth: Auth;
  config: Config;
  infra: Pick<Infra, 'bus'>;
  body: PairRequest;
  /**
   * The device static key of the Noise handshake, when the request came
   * through the tunnel; `publicKey` must equal it.
   */
  handshakeKey?: Uint8Array;
}

/**
 * `POST /devices/pair` (RELAY_PROTOCOL.md 6.3): spends the code, makes the
 * owner when the pairing says so and there still is none, then the device
 * and its API key. The key is in the answer and nowhere else.
 */
export async function completePairing(input: CompletePairingInput): Promise<PairResult> {
  const { db, auth, config, infra, body, handshakeKey } = input;
  const code = fromBase64url(body.code, PAIRING_CODE_BYTES);
  if (!code) throw pairingInvalid();
  const publicKey = fromBase64url(body.publicKey, DEVICE_KEY_BYTES);
  const pushKey = fromBase64url(body.pushKey, DEVICE_KEY_BYTES);
  if (!publicKey || !pushKey) {
    throw new DomainError(400, 'VALIDATION_FAILED', 'publicKey and pushKey must be 32 bytes');
  }
  if (handshakeKey && !sameBytes(handshakeKey, publicKey)) throw pairingKeyMismatch();

  const hash = pairingCodeHash(code);
  const workspaceId = await pairingWorkspace(db, hash);
  if (!workspaceId) throw pairingInvalid();

  // Spend the code first, so whatever happens next it works once.
  const pairing = await inWorkspace(workspaceId, () =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.devicePairings)
        .where(eq(schema.devicePairings.codeHash, hash));
      const now = new Date();
      if (
        !row ||
        !sameBytes(row.codeHash, hash) ||
        row.usedAt !== null ||
        new Date(row.expiresAt) <= now
      ) {
        throw pairingInvalid();
      }
      if (await deviceWorkspace(tx, publicKey)) {
        throw new DomainError(409, 'DEVICE_ALREADY_PAIRED', 'This device is paired already');
      }
      const [spent] = await tx
        .update(schema.devicePairings)
        .set({ usedAt: now })
        .where(and(eq(schema.devicePairings.id, row.id), isNull(schema.devicePairings.usedAt)))
        .returning();
      if (!spent) throw pairingInvalid();
      return spent;
    }),
  );

  // The account: the pairing's, the install's owner made meanwhile, or a new owner.
  let ownerId = pairing.ownerId ?? (await installOwnerFor(db, config));
  let createdOwner = false;
  if (!ownerId && pairing.createsOwner && config.deployment === 'self_hosted') {
    const made = await auth.api.createPairingOwner({
      body: { name: body.ownerName?.trim() || DEFAULT_PAIRED_OWNER_NAME },
    });
    ownerId = made.user.id;
    createdOwner = made.created;
  }
  if (!ownerId) throw pairingInvalid();

  const created = await auth.api.createApiKey({
    body: { name: body.name.slice(0, API_KEY_NAME_MAX), userId: ownerId, expiresIn: null },
  });
  // better-auth made it with no organization, so it is the directory's until it has one.
  await asDirectory(() =>
    db
      .update(schema.apikeys)
      .set({ workspaceId })
      .where(and(eq(schema.apikeys.id, created.id), eq(schema.apikeys.referenceId, ownerId))),
  );

  let device: DeviceRow;
  try {
    device = await inWorkspace(workspaceId, () =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.devices)
          .values({
            workspaceId,
            ownerId,
            name: body.name,
            platform: body.platform,
            publicKey,
            apiKeyId: created.id,
            pushKey: encryptSecret(pushKey, keyringFromConfig(config)),
          })
          .returning();
        if (!pairing.ownerId) {
          await tx
            .update(schema.devicePairings)
            .set({ ownerId })
            .where(eq(schema.devicePairings.id, pairing.id));
        }
        return row!;
      }),
    );
  } catch (error) {
    // No device, no key: the key would open the account with nothing to revoke it by.
    await asDirectory(() => db.delete(schema.apikeys).where(eq(schema.apikeys.id, created.id)));
    if (isUniqueViolation(error)) {
      throw new DomainError(409, 'DEVICE_ALREADY_PAIRED', 'This device is paired already');
    }
    throw error;
  }

  const [owner] = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId));
  await inWorkspace(workspaceId, async () => {
    await recordAudit(db, {
      workspaceId,
      actor: { type: 'user', id: ownerId },
      action: 'device.paired',
      targetType: 'device',
      targetId: device.id,
      metadata: {
        name: device.name,
        platform: device.platform,
        pairingId: pairing.id,
        via: handshakeKey ? 'relay' : 'direct',
        createdOwner,
      },
    });
    await publishEvent(
      infra.bus,
      wsEvent(
        'device.paired',
        { device: eventDevice(device) },
        { user_id: ownerId, workspace_id: workspaceId },
      ),
    );
  });
  return {
    device: {
      id: device.id,
      name: device.name,
      platform: device.platform,
      createdAt: iso(device.createdAt)!,
    },
    key: created.key,
    owner: { id: ownerId, name: owner?.name ?? DEFAULT_PAIRED_OWNER_NAME },
    setupNeeded: await setupNeeded(db, workspaceId, ownerId),
  };
}

async function installOwnerFor(db: Db, config: Config): Promise<string | null> {
  if (config.deployment !== 'self_hosted') return null;
  return (await findInstallOwner(db)) ?? null;
}

/** Whether the owner still has no model provider they may use, or no Bot (RELAY_PROTOCOL.md 6.3). */
export async function setupNeeded(db: Db, workspaceId: string, ownerId: string): Promise<boolean> {
  return inWorkspace(workspaceId, async () => {
    const [provider] = await db
      .select({ id: schema.providers.id })
      .from(schema.providers)
      .where(
        and(
          eq(schema.providers.workspaceId, workspaceId),
          or(isNull(schema.providers.ownerId), eq(schema.providers.ownerId, ownerId)),
        ),
      )
      .limit(1);
    const [bot] = await db
      .select({ id: schema.bots.id })
      .from(schema.bots)
      .where(and(eq(schema.bots.workspaceId, workspaceId), eq(schema.bots.ownerId, ownerId)))
      .limit(1);
    return !provider || !bot;
  });
}

export interface DeviceOwner {
  workspaceId: string;
  ownerId: string;
}

/** The owner's unrevoked devices, newest first. Call in the organization's scope. */
export async function listDevices(db: Db, { workspaceId, ownerId }: DeviceOwner) {
  const rows = await db
    .select()
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.workspaceId, workspaceId),
        eq(schema.devices.ownerId, ownerId),
        isNull(schema.devices.revokedAt),
      ),
    )
    .orderBy(desc(schema.devices.createdAt));
  return rows.map(toDeviceSummary);
}

async function ownDevice(db: Db, { workspaceId, ownerId }: DeviceOwner, deviceId: string) {
  const [row] = await db
    .select()
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.id, deviceId),
        eq(schema.devices.workspaceId, workspaceId),
        eq(schema.devices.ownerId, ownerId),
        isNull(schema.devices.revokedAt),
      ),
    );
  if (!row) throw notFound('No such device');
  return row;
}

/**
 * Revokes a device (RELAY_PROTOCOL.md 6.4): deletes its API key first, so it
 * stops working at once, then forgets its static key and push key and token,
 * and publishes `device.revoked` for the relay adapters to close its streams.
 */
export async function revokeDevice(
  deps: Pick<AppDeps, 'db'> & { infra: Pick<Infra, 'bus'> },
  owner: DeviceOwner,
  deviceId: string,
  actor: AuditActor,
): Promise<void> {
  const { db, infra } = deps;
  await inWorkspace(owner.workspaceId, async () => {
    const device = await ownDevice(db, owner, deviceId);
    if (device.apiKeyId) {
      const keyId = device.apiKeyId;
      // API keys are the directory's (db/scope.ts).
      await asDirectory(() =>
        db
          .delete(schema.apikeys)
          .where(and(eq(schema.apikeys.id, keyId), eq(schema.apikeys.referenceId, owner.ownerId))),
      );
    }
    const [revoked] = await db
      .update(schema.devices)
      .set({
        revokedAt: new Date(),
        apiKeyId: null,
        publicKey: null,
        pushKey: null,
        pushToken: null,
        pushEnvironment: null,
      })
      .where(and(eq(schema.devices.id, device.id), isNull(schema.devices.revokedAt)))
      .returning();
    if (!revoked) return;
    await recordAudit(db, {
      workspaceId: owner.workspaceId,
      actor,
      action: 'device.revoked',
      targetType: 'device',
      targetId: device.id,
      metadata: { name: device.name, platform: device.platform },
    });
    await publishEvent(
      infra.bus,
      wsEvent(
        'device.revoked',
        { device: eventDevice(revoked) },
        { user_id: owner.ownerId, workspace_id: owner.workspaceId },
      ),
    );
  });
}

export interface PushRegistration {
  /** APNs device token, hex. */
  token: string;
  environment: 'production' | 'sandbox';
}

/**
 * Registers or refreshes a device's push token (sealed). Only the device
 * itself: the caller's API key must be the device's (403 NOT_THIS_DEVICE).
 */
export async function registerPush(
  deps: Pick<AppDeps, 'db' | 'config'>,
  owner: DeviceOwner & { apiKeyId: string | null },
  deviceId: string,
  push: PushRegistration,
): Promise<void> {
  const { db, config } = deps;
  await inWorkspace(owner.workspaceId, async () => {
    const device = await ownDevice(db, owner, deviceId);
    if (!owner.apiKeyId || device.apiKeyId !== owner.apiKeyId) {
      throw new DomainError(403, 'NOT_THIS_DEVICE', 'Only the device itself registers its push');
    }
    await db
      .update(schema.devices)
      .set({
        pushToken: encryptSecret(push.token.toLowerCase(), keyringFromConfig(config)),
        pushEnvironment: push.environment,
      })
      .where(and(eq(schema.devices.id, device.id), isNull(schema.devices.revokedAt)));
  });
}

// When each API key last touched its device, per process; bounded.
const touched = new Map<string, number>();

/**
 * Notes that the device behind an API key was seen: writes `last_seen_at`
 * at most once a minute per key (per process here, and in the database
 * across processes). Nothing happens for a key that is no device's.
 */
export async function touchDevice(
  db: Db,
  { workspaceId, apiKeyId }: { workspaceId: string; apiKeyId: string },
  now = Date.now(),
): Promise<void> {
  const last = touched.get(apiKeyId);
  if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
  if (touched.size > 10_000) touched.clear();
  touched.set(apiKeyId, now);
  const cutoff = new Date(now - TOUCH_INTERVAL_MS);
  await inWorkspace(workspaceId, () =>
    db
      .update(schema.devices)
      .set({ lastSeenAt: new Date(now) })
      .where(
        and(
          eq(schema.devices.apiKeyId, apiKeyId),
          isNull(schema.devices.revokedAt),
          or(isNull(schema.devices.lastSeenAt), lte(schema.devices.lastSeenAt, cutoff)),
        ),
      ),
  );
}

/**
 * The unrevoked device with this static key, in any organization, or null:
 * the relay adapter's lookup after the handshake.
 */
export async function findDeviceByPublicKey(db: Db, publicKey: Uint8Array) {
  const workspaceId = await deviceWorkspace(db, publicKey);
  if (!workspaceId) return null;
  const [row] = await inWorkspace(workspaceId, () =>
    db
      .select()
      .from(schema.devices)
      .where(
        and(eq(schema.devices.publicKey, Buffer.from(publicKey)), isNull(schema.devices.revokedAt)),
      ),
  );
  return row ? { ...row, workspaceId } : null;
}

/** Whether any organization has an unrevoked device or an open pairing: the relay link dials only then. */
export function anyDevicesOrPairings(db: Db, now = new Date()): Promise<boolean> {
  return devicesExist(db, now);
}

/** Deletes used and expired pairings in the organization in scope; returns how many. */
export async function expireDuePairings(
  deps: Pick<AppDeps, 'db'>,
  now = new Date(),
): Promise<number> {
  const deleted = await deps.db
    .delete(schema.devicePairings)
    .where(or(isNotNull(schema.devicePairings.usedAt), lte(schema.devicePairings.expiresAt, now)))
    .returning({ id: schema.devicePairings.id });
  return deleted.length;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function isUniqueViolation(error: unknown): boolean {
  for (let e = error as { code?: string; cause?: unknown } | undefined; e;) {
    if (e.code === '23505') return true;
    e = e.cause as typeof e;
  }
  return false;
}

/**
 * A device's key cannot make more credentials: no API keys and no pairings.
 * Otherwise a stolen phone could mint a key or pair another device that
 * outlives its revocation. The owner makes those from a signed-in session.
 */
export async function refuseDeviceKey(
  db: Db,
  caller: { workspaceId: string; apiKeyId?: string | null },
): Promise<void> {
  if (!caller.apiKeyId) return;
  const [row] = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.workspaceId, caller.workspaceId),
        eq(schema.devices.apiKeyId, caller.apiKeyId),
      ),
    );
  if (row) {
    throw new DomainError(
      403,
      'DEVICE_KEY_NOT_ALLOWED',
      'A paired device cannot make API keys or pairings. Sign in on the web or the Mac app.',
    );
  }
}
