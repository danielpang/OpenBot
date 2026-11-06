import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { DEVICE_KEY_HEADER, rateLimitKey, tunnelHeader } from '../client-ip.js';
import type { AppEnv } from '../context.js';
import { DEVICE_PLATFORMS } from '../db/schema/devices.js';
import { DomainError } from '../errors.js';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import { userActor } from '../services/audit.js';
import {
  PAIRING_CODE_BYTES,
  cancelPairing,
  completePairing,
  createPairing,
  fromBase64url,
  listDevices,
  pairingCodeHash,
  pairingKeyMismatch,
  registerPush,
  revokeDevice,
} from '../services/devices.js';
import { ensureInstanceKey } from '../services/instance-key.js';

// Devices and pairing (docs/RELAY_PROTOCOL.md 6.3 and 6.4; services/devices.ts).
// A device's key is an ordinary API key, so a device reaches every route
// behind `requireUser` as its owner. `POST /devices/pair` is the one route
// a phone calls with no key: it spends a pairing code and answers the key.
// It is rate-limited like sign-in, per client (10 an hour) and per code (5
// tries, after which the code is dead), in the infra's limiter.

/** Per client, as better-auth's sign-in: 10 an hour. */
export const PAIR_CLIENT_LIMIT = { window: 3600, max: 10 };
/** Per code: 5 tries an hour, longer than the code lives. */
export const PAIR_CODE_LIMIT = { window: 3600, max: 5 };

const PlatformSchema = z.enum(DEVICE_PLATFORMS);

const DeviceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    platform: PlatformSchema,
    createdAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime().nullable(),
    pushRegistered: z.boolean().openapi({ description: 'The device has sent its push token' }),
  })
  .openapi('Device');

const directUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .openapi({ description: 'An address the phone tries before the relay' });

const CreatePairingSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional().openapi({
      description: "The server's name in the phone's hosts list; the organization's by default",
    }),
    direct: z.array(directUrl).max(8).optional().openapi({
      description: 'Direct addresses; OPENBOTS_PUBLIC_URL when it is https, by default',
    }),
  })
  .openapi('CreatePairing');

const PairingQrSchema = z
  .object({
    v: z.literal(1),
    host: z.string().openapi({ description: "The server's relay host id" }),
    key: z.string().openapi({ description: "The server's Noise static key, base64url" }),
    code: z.string().openapi({ description: 'The 32 byte pairing code, base64url' }),
    relay: z.string().nullable().openapi({ description: 'The relay URL; null with no relay' }),
    direct: z.array(z.string()),
    name: z.string(),
    setup: z.boolean().openapi({ description: 'The server has no owner yet' }),
  })
  .openapi('PairingQr');

const PairingSchema = z
  .object({
    id: z.uuid(),
    expiresAt: z.iso.datetime(),
    link: z.string().openapi({ description: 'The `openbots://pair#...` link the QR code shows' }),
    qr: PairingQrSchema,
  })
  .openapi('Pairing');

const PairRequestSchema = z
  .strictObject({
    code: z.string().min(1).max(256).openapi({ description: 'From the link, base64url' }),
    name: z.string().trim().min(1).max(100),
    platform: PlatformSchema,
    publicKey: z.string().min(1).max(256).openapi({
      description: "The device's X25519 static key, base64url",
    }),
    pushKey: z.string().min(1).max(256).openapi({ description: '32 random bytes, base64url' }),
    ownerName: z.string().trim().min(1).max(100).optional().openapi({
      description: 'The new owner’s name, used only on a server with no owner yet',
    }),
  })
  .openapi('PairRequest');

const PairResultSchema = z
  .object({
    device: z.object({
      id: z.uuid(),
      name: z.string(),
      platform: PlatformSchema,
      createdAt: z.iso.datetime(),
    }),
    key: z.string().openapi({ description: "The device's API key; shown only once" }),
    owner: z.object({ id: z.uuid(), name: z.string() }),
    setupNeeded: z.boolean().openapi({
      description: 'The owner has no model provider or no Bot yet: run the first-run steps',
    }),
  })
  .openapi('PairResult');

const PushSchema = z
  .strictObject({
    token: z
      .string()
      .regex(/^[0-9a-fA-F]{16,512}$/, 'must be the APNs token in hex')
      .openapi({ description: 'The APNs device token, hex' }),
    environment: z.enum(['production', 'sandbox']),
  })
  .openapi('DevicePush');

const RelaySchema = z
  .object({
    hostId: z.string(),
    relayUrl: z.string().nullable(),
    status: z.enum(['off', 'connecting', 'linked']),
    since: z.iso.datetime().nullable(),
    error: z.string().nullable().openapi({
      description: 'Why the last attempt to link failed, while connecting; null otherwise',
    }),
  })
  .openapi('RelayStatus');

const rateLimited = (c: Context<AppEnv>, retryAfter: number | null, fallback: number) => {
  c.header('retry-after', String(retryAfter ?? fallback));
  return new DomainError(429, 'RATE_LIMITED', 'Too many pairing attempts; try again later');
};

export const deviceRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'post',
      path: '/devices/pairings',
      tags: ['devices'],
      summary: 'Make a pairing link for a phone (good for 5 minutes, once)',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: {
          required: false,
          content: { 'application/json': { schema: CreatePairingSchema } },
        },
      },
      responses: {
        201: {
          description: 'The pairing, its link and the QR payload',
          content: { 'application/json': { schema: PairingSchema } },
        },
        400: problemResponse('Invalid request'),
        409: problemResponse('Too many open pairings (TOO_MANY_PAIRINGS)'),
        ...authProblems,
      },
    }),
    async (c) => {
      const { db, config, relay } = c.var.deps;
      const body = (c.req.valid('json') as z.infer<typeof CreatePairingSchema> | undefined) ?? {};
      const pairing = await createPairing({
        db,
        config,
        workspaceId: c.var.user.workspaceId,
        ownerId: c.var.user.id,
        name: body.name,
        direct: body.direct,
        createdBy: 'user',
        actor: userActor(c.var.user),
        relay,
      });
      return c.json(pairing, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/devices/pairings/{id}',
      tags: ['devices'],
      summary: 'Cancel an open pairing: its code stops working at once',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        204: { description: 'Cancelled' },
        404: problemResponse('No such open pairing'),
        ...authProblems,
      },
    }),
    async (c) => {
      const { user } = c.var;
      await cancelPairing(
        c.var.deps.db,
        { workspaceId: user.workspaceId, ownerId: user.id },
        c.req.valid('param').id,
        userActor(user),
      );
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/devices/pair',
      tags: ['devices'],
      summary: 'Pair a device with a code from a pairing link (the phone’s side)',
      description:
        'No authentication: the code is the credential. Rate-limited per client (10 an hour) and per code (5 tries). Answers the device’s API key once.',
      request: {
        body: { required: true, content: { 'application/json': { schema: PairRequestSchema } } },
      },
      responses: {
        200: {
          description: 'The device, its API key and the owner',
          content: { 'application/json': { schema: PairResultSchema } },
        },
        400: problemResponse(
          'Invalid request, or the key is not the tunnel’s (PAIRING_KEY_MISMATCH)',
        ),
        401: problemResponse('The code is unknown, used or expired (PAIRING_INVALID)'),
        409: problemResponse('The device is paired already'),
        429: problemResponse('Too many attempts'),
      },
    }),
    async (c) => {
      const { db, auth, config, infra } = c.var.deps;
      const body = c.req.valid('json');
      const client = await infra.limiter.consume(
        `pair:${rateLimitKey(c) ?? 'unknown'}`,
        PAIR_CLIENT_LIMIT,
      );
      if (!client.allowed) throw rateLimited(c, client.retryAfter, PAIR_CLIENT_LIMIT.window);
      const code = fromBase64url(body.code, PAIRING_CODE_BYTES);
      if (code) {
        const tries = await infra.limiter.consume(
          `pair-code:${pairingCodeHash(code).toString('hex')}`,
          PAIR_CODE_LIMIT,
        );
        if (!tries.allowed) throw rateLimited(c, tries.retryAfter, PAIR_CODE_LIMIT.window);
      }
      // The tunnel's static key, from the relay adapter on loopback (client-ip.ts).
      const sentKey = tunnelHeader(c, DEVICE_KEY_HEADER);
      let handshakeKey: Uint8Array | undefined;
      if (sentKey !== undefined) {
        handshakeKey = fromBase64url(sentKey) ?? undefined;
        if (!handshakeKey) throw pairingKeyMismatch();
      }
      const result = await completePairing({ db, auth, config, infra, body, handshakeKey });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/devices',
      tags: ['devices'],
      summary: "The caller's paired devices",
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Devices, newest first',
          content: { 'application/json': { schema: z.object({ items: z.array(DeviceSchema) }) } },
        },
        ...authProblems,
      },
    }),
    async (c) => {
      const { user } = c.var;
      const items = await listDevices(c.var.deps.db, {
        workspaceId: user.workspaceId,
        ownerId: user.id,
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/devices/{id}',
      tags: ['devices'],
      summary: 'Revoke a device: its key stops working at once and its streams close',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        204: { description: 'Revoked' },
        404: problemResponse('No such device'),
        ...authProblems,
      },
    }),
    async (c) => {
      const { user } = c.var;
      await revokeDevice(
        c.var.deps,
        { workspaceId: user.workspaceId, ownerId: user.id },
        c.req.valid('param').id,
        userActor(user),
      );
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/devices/{id}/push',
      tags: ['devices'],
      summary: "Register or refresh the device's push token (the device itself only)",
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: z.object({ id: z.uuid() }),
        body: { required: true, content: { 'application/json': { schema: PushSchema } } },
      },
      responses: {
        204: { description: 'Registered' },
        400: problemResponse('Invalid request'),
        403: problemResponse('The caller is not this device (NOT_THIS_DEVICE)'),
        404: problemResponse('No such device'),
        ...authProblems,
      },
    }),
    async (c) => {
      const { user } = c.var;
      await registerPush(
        c.var.deps,
        { workspaceId: user.workspaceId, ownerId: user.id, apiKeyId: user.apiKeyId },
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/relay',
      tags: ['devices'],
      summary: "The relay link's status and this server's host id",
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Relay status',
          content: { 'application/json': { schema: RelaySchema } },
        },
        ...authProblems,
      },
    }),
    async (c) => {
      const { relay, db, config } = c.var.deps;
      if (relay) return c.json(relay.status(), 200);
      const { hostId } = await ensureInstanceKey({ db, config });
      return c.json(
        {
          hostId,
          relayUrl: config.relayUrl ?? null,
          status: 'off' as const,
          since: null,
          error: null,
        },
        200,
      );
    },
  );
