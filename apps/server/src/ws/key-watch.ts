import type { Unsubscribe } from '@openbots/shared';
import { and, gt, inArray, isNull, or, eq } from 'drizzle-orm';
import { API_KEY_REVOKED_CHANNEL, type ApiKeyRevoked } from '../api-key-events.js';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { asDirectory, outsideScope } from '../db/scope.js';

// A socket authenticates once, at its upgrade. One opened with an API key
// (a paired phone's included) closes 1008 when that key stops working: at
// once on the bus message `DELETE /api-keys/{id}` and a device's revocation
// send (api-key-events.ts), and, for a revocation this process did not hear
// of (another process with no shared bus, or a key that expired), when the
// keys of the open sockets are looked up again every KEY_RECHECK_MS.

/** How often the keys of open sockets are looked up again. */
export const KEY_RECHECK_MS = 60_000;
/** The close code and reason of a socket whose key stopped working. */
export const CLOSE_KEY_REVOKED = 1008;
const REASON = 'api key revoked';

export interface KeyedSocket {
  /** The API key the socket authenticated with; null for a session. */
  readonly apiKeyId: string | null;
  close(code: number, reason: string): void;
}

export interface KeyWatch {
  /** Looks every open socket's key up now: the timer's work, for tests. */
  check(): Promise<void>;
  stop(): Promise<void>;
}

export async function watchApiKeys(
  deps: Pick<AppDeps, 'db' | 'infra' | 'logger'>,
  sockets: () => Iterable<KeyedSocket>,
  intervalMs = KEY_RECHECK_MS,
): Promise<KeyWatch> {
  const { db, infra, logger } = deps;

  const closeKey = (apiKeyId: string) => {
    for (const socket of [...sockets()]) {
      if (socket.apiKeyId === apiKeyId) socket.close(CLOSE_KEY_REVOKED, REASON);
    }
  };

  async function check(): Promise<void> {
    const ids = new Set<string>();
    for (const socket of sockets()) if (socket.apiKeyId) ids.add(socket.apiKeyId);
    if (!ids.size) return;
    const now = new Date();
    // API keys are the directory's (db/scope.ts).
    const live = await asDirectory(() =>
      db
        .select({ id: schema.apikeys.id })
        .from(schema.apikeys)
        .where(
          and(
            inArray(schema.apikeys.id, [...ids]),
            eq(schema.apikeys.enabled, true),
            or(isNull(schema.apikeys.expiresAt), gt(schema.apikeys.expiresAt, now)),
          ),
        ),
    );
    const found = new Set(live.map((row) => row.id));
    for (const id of ids) if (!found.has(id)) closeKey(id);
  }

  const timer = outsideScope(() =>
    setInterval(() => {
      check().catch((err: unknown) =>
        logger.warn({ err }, 'could not look up the API keys of open sockets'),
      );
    }, intervalMs),
  );
  timer.unref();

  const unsubscribe: Unsubscribe = await infra.bus.subscribe<ApiKeyRevoked>(
    API_KEY_REVOKED_CHANNEL,
    ({ apiKeyId }) => {
      if (typeof apiKeyId === 'string') closeKey(apiKeyId);
    },
  );

  return {
    check,
    async stop() {
      clearInterval(timer);
      await unsubscribe();
    },
  };
}
