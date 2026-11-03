import type { EventBus } from '@openbots/shared';

// When an API key stops working (`DELETE /api-keys/{id}`, or a device's key
// when the device is revoked), every API instance closes the realtime,
// terminal and screen sockets that authenticated with it (ws/gateway.ts,
// ws/computer.ts). Those sockets checked the key only at their upgrade; this
// closes them at once. Without a shared bus (no REDIS_URL) a revocation in
// another process is not heard, so each socket's key is also looked up again
// every minute (ws/key-watch.ts).

/** The bus channel that tells API instances an API key is gone. */
export const API_KEY_REVOKED_CHANNEL = 'openbots:api-key-revoked';

export interface ApiKeyRevoked {
  apiKeyId: string;
}

export function announceApiKeyRevoked(bus: EventBus, apiKeyId: string): Promise<void> {
  return bus.publish<ApiKeyRevoked>(API_KEY_REVOKED_CHANNEL, { apiKeyId });
}
