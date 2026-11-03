import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { wsEvent } from '@openbots/shared';
import { and, count, desc, eq, gt, isNull, isNotNull, lte, or, sql } from 'drizzle-orm';
import { findInstallOwner, type Auth } from '../auth.js';
import type { Config } from '../config.js';
import type { AppDeps, RelayLink } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { announceApiKeyRevoked } from '../api-key-events.js';
import {
  asDirectory,
  deviceWorkspaces,
  devicesExist,
  inWorkspace,
  pairingWorkspace,
} from '../db/scope.js';
import type { DevicePlatform, PairingCreator } from '../db/schema/devices.js';
import { DomainError, notFound } from '../errors.js';
import { publishEvent, type Infra } from '../infra/index.js';
import { ownerActive } from '../membership.js';
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
// Every refusal is the same 401 PAIRING_INVALID, a pairing whose owner is no
// longer an active member of its organization included. Expiry is judged by
// the database's clock, as the code is spent by it. Every check that can
// refuse runs before the code is spent; when a later step fails (the key, the
// device row, a race for the same static key) whatever was made is undone,
// the owner too when this pairing made them, and the code is given back. The
// route rate-limits by client and by code (routes/devices.ts).
//
// A device's static key is unique in its organization, not across them: one
// phone may pair with several organizations of one server (the managed
// service), each pairing its own device row and key. The relay adapter finds
// every device of a static key and serves each request as the one whose key
// it carries (relay/adapter.ts).
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
   * The CLI has none: a running server's link finds the pairing within 10
   * seconds (relay/link.ts).
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

  // Every check that can refuse, then the code is spent, so whatever happens next it works once.
  const pairing = await inWorkspace(workspaceId, () =>
    db.transaction(async (tx) => {
      const [found] = await tx
        .select({
          row: schema.devicePairings,
          live: sql<boolean>`${schema.devicePairings.expiresAt} > now()`,
        })
        .from(schema.devicePairings)
        .where(eq(schema.devicePairings.codeHash, hash));
      const row = found?.row;
      if (!row || !sameBytes(row.codeHash, hash) || row.usedAt !== null || !found.live) {
        throw pairingInvalid();
      }
      // An owner suspended or removed since the link was made pairs nothing.
      if (row.ownerId && !(await ownerActive(tx, { ownerId: row.ownerId, workspaceId }))) {
        throw pairingInvalid();
      }
      if (await deviceKeyTaken(tx, workspaceId, publicKey)) throw devicePaired();
      const [spent] = await tx
        .update(schema.devicePairings)
        .set({ usedAt: sql`now()` })
        .where(and(eq(schema.devicePairings.id, row.id), isNull(schema.devicePairings.usedAt)))
        .returning();
      if (!spent) throw pairingInvalid();
      return spent;
    }),
  );

  let ownerId: string | null = null;
  let createdOwner = false;
  let created: { id: string; key: string } | null = null;
  let device: DeviceRow;
  try {
    // The account: the pairing's, the install's owner made meanwhile, or a new owner.
    ownerId = pairing.ownerId ?? (await installOwnerFor(db, config));
    if (!ownerId && pairing.createsOwner && config.deployment === 'self_hosted') {
      const made = await auth.api.createPairingOwner({
        body: { name: body.ownerName?.trim() || DEFAULT_PAIRED_OWNER_NAME },
      });
      ownerId = made.user.id;
      createdOwner = made.created;
    }
    if (!ownerId) throw pairingInvalid();
    const owner = ownerId;
    if (!(await inWorkspace(workspaceId, () => ownerActive(db, { ownerId: owner, workspaceId })))) {
      throw pairingInvalid();
    }

    const key = await auth.api.createApiKey({
      body: { name: body.name.slice(0, API_KEY_NAME_MAX), userId: owner, expiresIn: null },
    });
    created = key;
    // better-auth made it with no organization, so it is the directory's until it has one.
    await asDirectory(() =>
      db
        .update(schema.apikeys)
        .set({ workspaceId })
        .where(and(eq(schema.apikeys.id, key.id), eq(schema.apikeys.referenceId, owner))),
    );

    device = await inWorkspace(workspaceId, () =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.devices)
          .values({
            workspaceId,
            ownerId: owner,
            name: body.name,
            platform: body.platform,
            publicKey,
            apiKeyId: key.id,
            pushKey: encryptSecret(pushKey, keyringFromConfig(config)),
          })
          .returning();
        if (!pairing.ownerId) {
          await tx
            .update(schema.devicePairings)
            .set({ ownerId: owner })
            .where(eq(schema.devicePairings.id, pairing.id));
        }
        return row!;
      }),
    );
  } catch (error) {
    // No device, no key: the key would open the account with nothing to revoke it by.
    await undoPairing(db, {
      workspaceId,
      pairing,
      apiKeyId: created?.id ?? null,
      createdOwner,
      ownerId,
    });
    // The other insert of a race for this static key won (checked above, before the spend).
    if (isUniqueViolation(error)) throw devicePaired();
    throw error;
  }
  const key = created!;
  const owner = ownerId!;

  const [ownerRow] = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, owner));
  await inWorkspace(workspaceId, async () => {
    await recordAudit(db, {
      workspaceId,
      actor: { type: 'user', id: owner },
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
        { user_id: owner, workspace_id: workspaceId },
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
    key: key.key,
    owner: { id: owner, name: ownerRow?.name ?? DEFAULT_PAIRED_OWNER_NAME },
    setupNeeded: await setupNeeded(db, workspaceId, owner),
  };
}

const devicePaired = () =>
  new DomainError(409, 'DEVICE_ALREADY_PAIRED', 'This device is paired already');

/** Whether an unrevoked device of the organization (in scope) holds this static key. */
async function deviceKeyTaken(db: Db, workspaceId: string, publicKey: Uint8Array) {
  const [row] = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.workspaceId, workspaceId),
        eq(schema.devices.publicKey, Buffer.from(publicKey)),
        isNull(schema.devices.revokedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * A pairing that failed after its code was spent: the key and the owner it
 * made go, and the code is given back as it was, so the phone can try again
 * and the documented "the code is not spent" holds for a refusal. Each step
 * is tried whatever the others do.
 */
async function undoPairing(
  db: Db,
  undo: {
    workspaceId: string;
    pairing: PairingRow;
    apiKeyId: string | null;
    createdOwner: boolean;
    ownerId: string | null;
  },
): Promise<void> {
  const { workspaceId, pairing, apiKeyId, createdOwner, ownerId } = undo;
  if (apiKeyId) {
    await asDirectory(() => db.delete(schema.apikeys).where(eq(schema.apikeys.id, apiKeyId))).catch(
      () => undefined,
    );
  }
  // A placeholder owner this pairing made would be left with no way in.
  if (createdOwner && ownerId) {
    await asDirectory(() => db.delete(schema.users).where(eq(schema.users.id, ownerId))).catch(
      () => undefined,
    );
  }
  await inWorkspace(workspaceId, () =>
    db
      .update(schema.devicePairings)
      .set({ usedAt: null, ownerId: pairing.ownerId })
      .where(eq(schema.devicePairings.id, pairing.id)),
  ).catch(() => undefined);
}

async function installOwnerFor(db: Db, config: Config): Promise<string | null> {
  if (config.deployment !== 'self_hosted') return null;
  return (await findInstallOwner(db)) ?? null;
}

/** Whether the owner still has no model provider they may use, or no Bot (RELAY_PROTOCOL.md 6.3). */
export async function setupNeeded(db: Db, workspaceId: string, ownerId: string): Promise<boolean> {
  return inWorkspace(workspaceId, async () => {
    const [bot] = await db
      .select({ id: schema.bots.id })
      .from(schema.bots)
      .where(and(eq(schema.bots.workspaceId, workspaceId), eq(schema.bots.ownerId, ownerId)))
      .limit(1);
    return !bot || !(await ownerHasProvider(db, workspaceId, ownerId));
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
 * Revokes a device (RELAY_PROTOCOL.md 6.4). The device row goes first: it is
 * marked revoked and forgets its static key, push key and push token in one
 * update, so whatever fails after, nothing can push to it or open a tunnel
 * as it. `device.revoked` goes out then, for the relay adapters to close its
 * streams. Its API key is deleted next, and the API instances are told to
 * close the sockets it opened (api-key-events.ts). Should that delete fail,
 * the row keeps the key's id, and a second `DELETE /devices/{id}` (or
 * `openbots devices revoke`) finishes it rather than answering 404.
 */
export async function revokeDevice(
  deps: Pick<AppDeps, 'db'> & { infra: Pick<Infra, 'bus'> },
  owner: DeviceOwner,
  deviceId: string,
  actor: AuditActor,
): Promise<void> {
  const { db, infra } = deps;
  await inWorkspace(owner.workspaceId, async () => {
    const device = await revocableDevice(db, owner, deviceId);
    if (device.revokedAt === null) {
      const [revoked] = await db
        .update(schema.devices)
        .set({
          revokedAt: new Date(),
          publicKey: null,
          pushKey: null,
          pushToken: null,
          pushEnvironment: null,
        })
        .where(and(eq(schema.devices.id, device.id), isNull(schema.devices.revokedAt)))
        .returning();
      if (revoked) {
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
      }
    }
    if (device.apiKeyId) {
      const keyId = device.apiKeyId;
      // API keys are the directory's (db/scope.ts).
      await asDirectory(() =>
        db
          .delete(schema.apikeys)
          .where(and(eq(schema.apikeys.id, keyId), eq(schema.apikeys.referenceId, owner.ownerId))),
      );
      // The foreign key clears it already; said here for a key another owner held.
      await db
        .update(schema.devices)
        .set({ apiKeyId: null })
        .where(eq(schema.devices.id, device.id));
      await announceApiKeyRevoked(infra.bus, keyId);
    }
  });
}

/** The owner's device to revoke: an unrevoked one, or one whose revocation did not delete its key. */
async function revocableDevice(db: Db, { workspaceId, ownerId }: DeviceOwner, deviceId: string) {
  const [row] = await db
    .select()
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.id, deviceId),
        eq(schema.devices.workspaceId, workspaceId),
        eq(schema.devices.ownerId, ownerId),
        or(isNull(schema.devices.revokedAt), isNotNull(schema.devices.apiKeyId)),
      ),
    );
  if (!row) throw notFound('No such device');
  return row;
}

/**
 * Cancels an open pairing of the owner's (`DELETE /devices/pairings/{id}`):
 * its code stops working at once. 404 for one that is used, expired and
 * swept, or another owner's.
 */
export async function cancelPairing(
  db: Db,
  { workspaceId, ownerId }: DeviceOwner,
  pairingId: string,
  actor: AuditActor,
): Promise<void> {
  const [row] = await db
    .delete(schema.devicePairings)
    .where(
      and(
        eq(schema.devicePairings.id, pairingId),
        eq(schema.devicePairings.workspaceId, workspaceId),
        eq(schema.devicePairings.ownerId, ownerId),
        isNull(schema.devicePairings.usedAt),
      ),
    )
    .returning({ id: schema.devicePairings.id });
  if (!row) throw notFound('No such pairing');
  await recordAudit(db, {
    workspaceId,
    actor,
    action: 'device.pairing_cancelled',
    targetType: 'device_pairing',
    targetId: row.id,
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
 * Publishes `device.updated`, on which the push worker reads the
 * organization's devices again, so a token registered just after pairing
 * gets the next notice.
 */
export async function registerPush(
  deps: Pick<AppDeps, 'db' | 'config'> & { infra: Pick<Infra, 'bus'> },
  owner: DeviceOwner & { apiKeyId: string | null },
  deviceId: string,
  push: PushRegistration,
): Promise<void> {
  const { db, config, infra } = deps;
  await inWorkspace(owner.workspaceId, async () => {
    const device = await ownDevice(db, owner, deviceId);
    if (!owner.apiKeyId || device.apiKeyId !== owner.apiKeyId) {
      throw new DomainError(403, 'NOT_THIS_DEVICE', 'Only the device itself registers its push');
    }
    const [updated] = await db
      .update(schema.devices)
      .set({
        pushToken: encryptSecret(push.token.toLowerCase(), keyringFromConfig(config)),
        pushEnvironment: push.environment,
      })
      .where(and(eq(schema.devices.id, device.id), isNull(schema.devices.revokedAt)))
      .returning();
    if (!updated) return;
    await publishEvent(
      infra.bus,
      wsEvent(
        'device.updated',
        { device: { ...eventDevice(updated), pushRegistered: updated.pushToken !== null } },
        { user_id: owner.ownerId, workspace_id: owner.workspaceId },
      ),
    );
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
 * Every unrevoked device with this static key, one per organization it is
 * paired with, the oldest pairing first: the relay adapter's lookup after
 * the handshake. Empty when no organization has it.
 */
export async function findDevicesByPublicKey(db: Db, publicKey: Uint8Array): Promise<DeviceRow[]> {
  const devices: DeviceRow[] = [];
  for (const workspaceId of await deviceWorkspaces(db, publicKey)) {
    const [row] = await inWorkspace(workspaceId, () =>
      db
        .select()
        .from(schema.devices)
        .where(
          and(
            eq(schema.devices.workspaceId, workspaceId),
            eq(schema.devices.publicKey, Buffer.from(publicKey)),
            isNull(schema.devices.revokedAt),
          ),
        ),
    );
    if (row) devices.push(row);
  }
  return devices;
}

/** The first of `findDevicesByPublicKey`, or null. */
export async function findDeviceByPublicKey(db: Db, publicKey: Uint8Array) {
  return (await findDevicesByPublicKey(db, publicKey))[0] ?? null;
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

export const deviceKeyNotAllowed = () =>
  new DomainError(
    403,
    'DEVICE_KEY_NOT_ALLOWED',
    'A paired device cannot make keys, pairings, webhooks or other ways in or out. Sign in on the web or the Mac app.',
  );

/** Whether this API key is a device's (revoked or not). Call in the organization's scope. */
export async function isDeviceKey(
  db: Db,
  caller: { workspaceId: string; apiKeyId?: string | null },
): Promise<boolean> {
  if (!caller.apiKeyId) return false;
  const [row] = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.workspaceId, caller.workspaceId),
        eq(schema.devices.apiKeyId, caller.apiKeyId),
      ),
    );
  return row !== undefined;
}

/**
 * A device's key cannot make more credentials or open new paths out of the
 * server: a stolen phone could otherwise leave something behind that
 * outlives its revocation. The owner does those from a signed-in session.
 */
export async function refuseDeviceKey(
  db: Db,
  caller: { workspaceId: string; apiKeyId?: string | null },
): Promise<void> {
  if (await isDeviceKey(db, caller)) throw deviceKeyNotAllowed();
}

/**
 * The routes a device's key may not call (403 DEVICE_KEY_NOT_ALLOWED), by
 * method and path under `/api/v1`: each makes a long-lived credential (an
 * API key, a pairing, a webhook token or signing secret, an event
 * subscription's secret, an invitation) or a path out of the server (an
 * event subscription's URL, a connector, an OAuth grant, a provider's
 * endpoint) or widens what such a path may do (a connector marked trusted or
 * local, the connector policy, the organization's settings). An edit is
 * refused when it sends any field outside a short list of harmless ones
 * (`beyond`), so a field added to a schema later is refused until it is
 * listed. `unless` lets the request through: a phone that set up a headless
 * install adds the first model provider itself (plan 8.3 step 4), though not
 * one marked local.
 * `requireUser` and `requireAdmin` apply the list (middleware/auth.ts), so a
 * route the managed build mounts is covered too.
 */
export interface DeviceKeyRule {
  method: string;
  path: RegExp;
  when?(body: Record<string, unknown>): boolean;
  unless?(
    db: Db,
    caller: { workspaceId: string; id: string },
    body: Record<string, unknown> | null,
  ): Promise<boolean>;
}

/** True when the body sends a field that is not one of `allowed`. */
const beyond =
  (...allowed: string[]) =>
  (body: Record<string, unknown>) =>
    Object.keys(body).some((field) => body[field] !== undefined && !allowed.includes(field));

const always = () => true;

export const DEVICE_KEY_RULES: readonly DeviceKeyRule[] = [
  { method: 'POST', path: /^\/api-keys$/ },
  { method: 'POST', path: /^\/devices\/pairings$/ },
  { method: 'POST', path: /^\/bots\/[^/]+\/endpoints$/ },
  { method: 'POST', path: /^\/endpoints\/[^/]+\/rotate$/ },
  {
    method: 'PATCH',
    path: /^\/endpoints\/[^/]+$/,
    // Not signature, allowed IPs, the rate limit, the slug or a tool policy override.
    when: beyond('enabled', 'match', 'template', 'responseMode', 'syncTimeoutS'),
  },
  { method: 'POST', path: /^\/event-subscriptions$/ },
  {
    method: 'PATCH',
    path: /^\/event-subscriptions\/[^/]+$/,
    when: (body) => beyond('events', 'enabled')(body) || body.rotateSecret === true,
  },
  { method: 'POST', path: /^\/connectors$/ },
  { method: 'POST', path: /^\/connectors\/import$/ },
  {
    method: 'PATCH',
    path: /^\/connectors\/[^/]+$/,
    when: beyond('name'),
  },
  { method: 'PUT', path: /^\/connectors\/[^/]+\/trusted$/ },
  { method: 'PUT', path: /^\/connectors\/[^/]+\/local$/ },
  { method: 'PUT', path: /^\/connector-policy$/ },
  { method: 'PATCH', path: /^\/settings$/ },
  { method: 'GET', path: /^\/connectors\/[^/]+\/oauth\/start$/ },
  {
    method: 'POST',
    path: /^\/providers$/,
    when: always,
    unless: async (db, caller, body) =>
      body?.local !== true && !(await ownerHasProvider(db, caller.workspaceId, caller.id)),
  },
  { method: 'PATCH', path: /^\/providers\/[^/]+$/, when: beyond('name', 'smallModelId') },
  // The managed build's (ee/server); a self-hosted install answers 404 there anyway.
  { method: 'POST', path: /^\/organization\/invitations$/ },
];

/** The rule for a request, by method and its path under `/api/v1`, if any. */
export function deviceKeyRule(method: string, path: string): DeviceKeyRule | undefined {
  const upper = method.toUpperCase();
  return DEVICE_KEY_RULES.find((rule) => rule.method === upper && rule.path.test(path));
}

/** Whether the owner has a model provider they may use (the organization's or their own). */
async function ownerHasProvider(db: Db, workspaceId: string, ownerId: string): Promise<boolean> {
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
  return provider !== undefined;
}
