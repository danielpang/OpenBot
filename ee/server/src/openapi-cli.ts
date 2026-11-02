// `pnpm --filter @openbots/ee-server openapi`: writes the document of the
// managed routes to ee/server/openapi.json, which ee/web's client types are
// generated from. The core's routes are in packages/api-client.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '@openbots/server/context';
import { openApiDocument } from '@openbots/server/openapi';
import { organizationRoutes } from './routes.js';

const out = fileURLToPath(new URL('../openapi.json', import.meta.url));
const app = new OpenAPIHono<AppEnv>();
app.route('/api/v1', organizationRoutes({}));
const doc = openApiDocument(app);
doc.info = { ...doc.info, title: 'OpenBots managed API', description: 'Organizations' };
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`openapi: wrote ${out}`);
