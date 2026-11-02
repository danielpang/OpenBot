// `pnpm --filter @openbots/server openapi`: writes the OpenAPI document to
// packages/api-client/openapi.json, where the web client is generated from.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createInfra } from './infra/index.js';
import { createLogger } from './logger.js';
import { openApiDocument } from './openapi.js';
import { generateMasterKey } from './secrets.js';

const out = fileURLToPath(new URL('../../../packages/api-client/openapi.json', import.meta.url));

// Building the app needs a config, but nothing here touches the database.
const config = loadConfig({
  OPENBOTS_MASTER_KEY: generateMasterKey(),
  DATABASE_URL: 'postgres://unused',
});
const db = createDb(config.databaseUrl);
const logger = createLogger('silent');
const infra = createInfra(config);
const auth = createAuth({ config, db, logger, limiter: infra.limiter });
const app = createApp({ config, db, logger, auth, infra }, { webDist: '' });

writeFileSync(out, `${JSON.stringify(openApiDocument(app), null, 2)}\n`);
await infra.close();
await db.close();
console.log(`openapi: wrote ${out}`);
