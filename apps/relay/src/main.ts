import { readFile } from 'node:fs/promises';
import { pino } from 'pino';
import type { ApnsOptions } from './apns.js';
import { budgetOptionsFromEnv } from './budget.js';
import { loadConfig } from './config.js';
import { drainOptionsFromEnv, drainRequested } from './drain.js';
import { flowOptionsFromEnv } from './flow.js';
import { createRelay } from './relay.js';
import { RedisRegistry } from './registry.js';

// The relay's entry: settings from the environment (config.ts), JSON logs on
// stdout, the shared registry on Redis when `RELAY_REDIS_URL` is set, the
// flow, budget and drain settings (each module reads its own), and two ways
// out. SIGTERM (a deploy, Fly's kill_signal) drains: not ready, nothing new,
// leases given up, and after the grace period the rest closed with 1012.
// SIGINT closes at once with 1001. `RELAY_DRAIN=true` starts draining at boot.

const config = loadConfig();
// Read before anything listens, so a bad setting stops the process at boot.
const flow = flowOptionsFromEnv();
const budget = budgetOptionsFromEnv();
const drain = drainOptionsFromEnv();
const drainAtBoot = drainRequested();
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

const registry = config.redisUrl ? new RedisRegistry({ redis: config.redisUrl }) : undefined;
if (!registry) logger.info('no RELAY_REDIS_URL: the registry is in memory, for this machine alone');

const relay = await createRelay({
  port: config.port,
  host: config.host,
  trustProxy: config.trustProxy,
  logger,
  minClusterSize: config.minClusterSize,
  cluster: config.cluster,
  flow,
  budget,
  drain,
  ...(config.metricsToken ? { metricsToken: config.metricsToken } : {}),
  ...(config.nodeId ? { nodeId: config.nodeId } : {}),
  ...(registry ? { registry } : {}),
  ...(apns ? { apns } : {}),
});
logger.info(
  {
    port: relay.port,
    host: config.host,
    push: apns !== undefined,
    nodeId: relay.nodeId,
    shared: registry !== undefined,
  },
  'relay listening',
);

let exiting = false;
const exit = async (why: string) => {
  if (exiting) return;
  exiting = true;
  logger.info({ why }, 'shutting down');
  await relay.close();
  await registry?.close();
  process.exit(0);
};

relay.drain.listen(process);
process.once('SIGTERM', () => {
  logger.info({ graceMs: relay.drain.options.graceMs }, 'SIGTERM: draining');
  void relay.drain.start('signal').then(() => exit('drained'));
});
process.once('SIGINT', () => void exit('SIGINT'));

if (drainAtBoot) {
  logger.info('RELAY_DRAIN is set: draining');
  // A machine told to drain stays up, unready, until it is stopped.
  void relay.drain.start('env');
}
