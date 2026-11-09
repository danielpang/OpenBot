// The server process (plan 21.5). OPENBOTS_ROLE picks what runs: `api`
// serves HTTP, `worker` runs background work, `all` (the default) does both.
// The self-hosted entry (main.ts) runs it with no extensions; the managed
// service's entry (ee/server) passes its own.
import { serve } from '@hono/node-server';
import { makeNonDumpable } from '@openbots/mcp';
import { createApp } from './app.js';
import { createAuth, encryptStoredOAuthTokens } from './auth.js';
import { loadConfig } from './config.js';
import type { AppDeps } from './context.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { protectFilesDir } from './files-dir.js';
import { createInfra } from './infra/index.js';
import { createLogger } from './logger.js';
import { rotateMasterKey } from './rotation.js';
import { recheckConnectorsOnBoot } from './services/connector-startup.js';
import {
  closeMcpManager,
  repairEmptyGitHubAuth,
  sealPlaintextConnectorValues,
} from './services/connectors.js';
import { openInstanceKey } from './services/instance-key.js';
import { startRelayAdapter } from './relay/adapter.js';
import { createRelayLink } from './relay/link.js';
import { registerLoginHooks } from './services/logins.js';
import {
  backfillProviderKeyHints,
  upgradeOllamaProviders,
  sealPlaintextProviderHeaders,
  seedProvidersFromEnv,
} from './services/providers.js';
import { registerRoutineHooks } from './services/routines.js';
import { registerRunHooks } from './services/runs.js';
import { registerSkillHooks } from './services/skills.js';
import { inEveryOrganization, startWorkers } from './workers.js';
import { openAppDb } from './db/app-role.js';
import { attachComputerProxies, isComputerSocketPath } from './ws/computer.js';
import { attachGateway } from './ws/gateway.js';
import type { ServerExtensions } from './extensions.js';
import { ensureWorkspace } from './workspace.js';

const PORT = Number(process.env.PORT ?? 3000);

export async function runServer(extensions: ServerExtensions = {}): Promise<void> {
  const logger = createLogger();
  // Before any stdio connector starts: where it can, keep them out of this process's /proc (S-1).
  if (makeNonDumpable())
    logger.info('stdio connectors run as nobody; this process is non-dumpable');
  const config = loadConfig();
  // The core alone cannot make an organization: the managed service runs from ee/server.
  if (config.deployment === 'managed' && !extensions.organizations) {
    throw new Error(
      'OPENBOTS_DEPLOYMENT=managed runs from the managed server build (ee/server); this is the self-hosted server',
    );
  }
  if (config.secretsFromEnvironment.length) {
    logger.warn(
      { variables: config.secretsFromEnvironment },
      'secrets came from the environment, where /proc/<pid>/environ and `docker inspect` show them; give each as NAME_FILE instead (docker/entrypoint.sh does this for the compose service)',
    );
  }
  if (config.deployment === 'managed' && config.stdioRunner === 'host') {
    logger.warn(
      "OPENBOTS_STDIO_RUNNER=host on the managed service (OPENBOTS_ALLOW_HOST_STDIO): every organization's stdio connectors run on this server as one user, with no isolation between them",
    );
  }
  // Files this process makes are its own; stdio servers run as another user (S-1).
  process.umask(0o077);
  protectFilesDir(config.filesDir);
  // Migrations as the tables' owner; then the app works under row-level
  // security, as openbots_app (db/app-role.ts, db/scope.ts).
  const owner = createDb(config.databaseUrl);
  await migrate(owner);
  const db = await openAppDb(owner, config, logger);
  // A self-hosted install is one implicit organization (plan 21.2).
  if (config.deployment === 'self_hosted') await ensureWorkspace(db);
  await seedProvidersFromEnv({ db, config, logger });
  // Upkeep of each organization's rows, in its scope.
  await inEveryOrganization({ db }, async () => {
    await sealPlaintextConnectorValues({ db, config, logger });
    await repairEmptyGitHubAuth({ db, config });
    await sealPlaintextProviderHeaders({ db, config });
    await backfillProviderKeyHints({ db, config });
    await upgradeOllamaProviders({ db });
    return 0;
  });
  await encryptStoredOAuthTokens({ db, config });
  // The relay identity, made on the first start (services/instance-key.ts).
  // One the master key does not open leaves the relay off rather than the server down.
  const instance = await openInstanceKey({ db, config, logger });
  logger.info({ role: config.role }, 'migrations applied');

  const infra = createInfra(config, (err) => logger.error({ err }, 'redis error'));
  if (infra.kind === 'memory' && config.role !== 'all') {
    logger.warn(
      { role: config.role },
      'REDIS_URL is unset: queues and events stay inside this process',
    );
  }
  const auth = createAuth({
    config,
    db,
    logger,
    limiter: infra.limiter,
    plugins: extensions.authPlugins?.({ config, db, logger, infra }) ?? [],
  });
  const deps: AppDeps = { config, db, logger, infra, auth, extensions };
  const stops: (() => Promise<void>)[] = [];
  // Both roles: the API enqueues runs for owner messages, the worker runs them.
  registerRunHooks();
  registerRoutineHooks();
  registerSkillHooks();
  registerLoginHooks();

  /**
   * The relay link (src/relay), when OPENBOTS_RELAY_URL is set: with the
   * adapter that serves its streams on `port` in an API process, push only
   * in a worker. `GET /relay` and the push worker find it on `deps.relay`.
   */
  async function startRelay(port: number | null) {
    if (!config.relayUrl || !instance) return;
    const link = await createRelayLink(deps, { instance });
    deps.relay = link;
    stops.push(link.stop);
    if (port !== null) stops.push(startRelayAdapter(deps, { link, instance, port }).stop);
  }

  if (config.role === 'api' || config.role === 'all') {
    const app = createApp(deps, { webDist: extensions.webDist });
    let listening!: () => void;
    const listened = new Promise<void>((resolve) => (listening = resolve));
    const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
      logger.info({ port: info.port, publicUrl: config.publicUrl }, 'listening');
      listening();
    });
    const gateway = await attachGateway(server, deps, { ignore: isComputerSocketPath });
    stops.push(gateway.close);
    stops.push((await attachComputerProxies(server, deps)).close);
    stops.push(() => new Promise((resolve) => server.close(() => resolve())));
    // Streams become requests to this port, so the link waits for it.
    await listened;
    await startRelay(PORT);
  } else {
    await startRelay(null);
  }
  if (config.role === 'worker' || config.role === 'all') {
    const workers = await startWorkers(deps);
    stops.push(workers.stop);
    if (config.previousMasterKeys.length) void rotateInBackground();
    const checks = new AbortController();
    const rechecking = inEveryOrganization(deps, () => recheckConnectorsOnBoot(deps, checks.signal))
      .then((checked) => logger.info({ checked }, 'connector startup checks finished'))
      .catch(() => logger.warn('connector startup checks did not complete'));
    stops.push(async () => {
      checks.abort();
      await rechecking;
    });
  }

  /** Re-seals secrets under the new master key while the server runs (plan 4.9); `rotate-key` does the same. */
  async function rotateInBackground() {
    logger.info(
      { previousKeys: config.previousMasterKeys.length },
      'master key rotation: re-sealing secrets under OPENBOTS_MASTER_KEY',
    );
    try {
      const report = await rotateMasterKey({
        db,
        config,
        onProgress: (progress) => logger.info(progress, 'master key rotation'),
      });
      const summary = { resealed: report.resealed, current: report.current };
      if (report.failed.length) {
        logger.warn(
          { ...summary, failed: report.failed },
          'master key rotation: some secrets open with no configured key; keep OPENBOTS_MASTER_KEY_PREVIOUS until they are re-entered',
        );
      } else {
        logger.info(
          summary,
          'master key rotation done; OPENBOTS_MASTER_KEY_PREVIOUS can be removed',
        );
      }
    } catch (err) {
      logger.error(
        { err },
        'master key rotation stopped; it resumes at the next start or with rotate-key',
      );
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      logger.info({ signal }, 'shutting down');
      await Promise.allSettled(stops.map((stop) => stop()));
      await closeMcpManager(deps);
      await infra.close();
      await db.close();
      process.exit(0);
    });
  }
}
