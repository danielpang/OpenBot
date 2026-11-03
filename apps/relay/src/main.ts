import { readFile } from 'node:fs/promises';
import { pino } from 'pino';
import type { ApnsOptions } from './apns.js';
import { loadConfig } from './config.js';
import { createRelay } from './relay.js';

// The relay's entry: settings from the environment (config.ts), JSON logs on
// stdout, and a graceful close on SIGTERM or SIGINT, which tells every client
// and host link the relay is going (1001) before the process exits.

const config = loadConfig();
const logger = pino({ level: config.logLevel, base: { service: 'openbots-relay' } });

let apns: ApnsOptions | undefined;
if (config.apns) {
  apns = {
    keyPem: await readFile(config.apns.keyFile, 'utf8'),
    keyId: config.apns.keyId,
    teamId: config.apns.teamId,
    topic: config.apns.topic,
    environment: config.apns.environment,
  };
} else if (config.apnsMissing.length > 0) {
  logger.warn({ missing: config.apnsMissing }, 'apns settings incomplete: push is unavailable');
} else {
  logger.info('no apns settings: push is unavailable');
}

const relay = await createRelay({
  port: config.port,
  host: config.host,
  trustProxy: config.trustProxy,
  logger,
  ...(apns ? { apns } : {}),
});
logger.info({ port: relay.port, host: config.host, push: apns !== undefined }, 'relay listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    logger.info({ signal }, 'shutting down');
    await relay.close();
    process.exit(0);
  });
}
