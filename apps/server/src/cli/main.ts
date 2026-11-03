// `openbots pair | devices | relay` in the server image (docker/entrypoint.sh),
// or `pnpm --filter @openbots/server pair` and so on. Connects as rotate-key
// does: the stack's config and database, no HTTP. The commands themselves are
// in the modules beside this one.
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { scopedDb } from '../db/scope.js';
import { createInfra } from '../infra/index.js';
import type { CliContext } from './context.js';
import { runDevices } from './devices.js';
import { runPair } from './pair.js';
import { runRelay } from './relay.js';

const COMMANDS = { pair: runPair, devices: runDevices, relay: runRelay } as const;

const [name, ...args] = process.argv.slice(2);
const command = COMMANDS[name as keyof typeof COMMANDS];
if (!command) {
  console.error('usage: openbots pair | devices | relay');
  process.exit(2);
}

const config = loadConfig();
// Under row-level security like the app, one organization at a time (db/scope.ts).
const db = scopedDb(createDb(config.databaseUrl, { max: 1 }));
const infra = createInfra(config);
const ctx: CliContext = { config, db, infra, write: (line) => console.log(line) };
try {
  process.exitCode = await command(args, ctx);
} catch (error) {
  console.error(`${name}: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await infra.close();
  await db.close();
}
