import { createHash, randomBytes } from 'node:crypto';
import { labelFor, OwnerHasScreen, type ComputerServices, type StepRecord } from '@openbots/agent';
import {
  AgentError,
  browserProfileDir,
  cdpPortFor,
  createDockerProvider,
  createRemoteProvider,
  nextDisplay,
  SANDBOX_NETWORK,
  SCREEN_SIZE,
  ScreenLocks,
  screenNumber,
  volumeName,
  type ComputerAgentClient,
  type ComputerProvider,
  type ComputerRef,
} from '@openbots/computer';
import {
  CODER_CONTROL_CHANNEL,
  COMPUTER_OFF,
  wsEvent,
  type CoderControl,
  type ComputerStatus,
} from '@openbots/shared';
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { inRanges } from '../client-ip.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { publishEvent } from '../infra/index.js';
import { assertBotOwner } from '../ownership.js';
import { decryptSecretString, encryptSecret, keyringFromConfig } from '../secrets.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from './audit.js';
import { setState } from './bot-state.js';
import { enqueueCoderJob } from './coder-jobs.js';
import { MCP_CONTROL_CHANNEL, type McpControl } from './mcp-control.js';

// The account's computer (plan 4.5, 9; K1 to K7). One `computers` row per
// owner, created on first use through the configured provider (`remote` when
// OPENBOTS_COMPUTER_AGENT_URL is set, else `docker` when DOCKER_HOST is set,
// else none: the computer tools are not offered). Starting it brings the
// machine up and waits for its control agent; the idle sweep stops it after
// `idle_timeout_min` (default 30) unless `always_on`, and the home volume
// stays. Status changes publish `computer.status` to the owner.
//
// Each Bot gets a screen (`bot_screens`, K2): display `:10+n`, its own CDP
// port and Chromium profile, started on the agent the first time the Bot
// needs it after the computer starts. Screen actions take the Bot's screen
// lock. While the owner has taken the screen over (`controlled_by_user_id`,
// K3) a screen action sets the Bot `waiting`, waits a while for the hand
// back, and otherwise answers "The owner has the screen; wait".
//
// Creating, starting and stopping the computer and taking or handing back a
// screen are audited (S-11): by the owner, the Bot whose run needed it, or the
// system for the idle sweep.
//
// The remote provider is one machine for the whole install (plan 9.2): every
// row gets the same agent, so its files under /home/bot and its cookie store
// would be every account's. The first account to use it keeps it, and the
// others are refused, unless the operator sets OPENBOTS_COMPUTER_AGENT_SHARED.
// Displays are numbered per machine, so on a shared agent each account's Bots
// get displays no other account's Bot holds.

export type ComputerRow = typeof schema.computers.$inferSelect;
export type ScreenRow = typeof schema.botScreens.$inferSelect;
type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type BotRow = Pick<typeof schema.bots.$inferSelect, 'id' | 'ownerId' | 'workspaceId'>;

export const DEFAULT_IDLE_TIMEOUT_MIN = 30;
/** The idle timeout the owner can pick, in minutes: five minutes to a day. */
export const IDLE_TIMEOUT_RANGE_MIN = { min: 5, max: 24 * 60 } as const;
/** How long a screen action waits for the owner to hand the screen back. */
export const TAKEOVER_WAIT_MS = 60_000;
const TAKEOVER_POLL_MS = 500;
/** How often the worker looks for idle computers. */
export const IDLE_SWEEP_MS = 60_000;
/** How long deleting a Bot waits for its screen to stop on the agent. */
const SCREEN_STOP_TIMEOUT_MS = 10_000;
/** A failed idle stop is retried after one sweep, then twice as long each time, up to this. */
export const IDLE_STOP_RETRY_MAX_MS = 30 * 60_000;

/**
 * The settings a computer's container is made with (plan 9.5). They live in
 * its environment, so a change applies when the container is made again: the
 * next start of a stopped computer does that, keeping its volumes.
 */
interface SandboxEnv {
  egressProxy?: string;
  noProxy?: string;
  timezone?: string;
}

/** What `computers.spec` holds: how the machine was made, and a pending idle stop retry. */
interface MachineSpec {
  image?: string;
  /**
   * A fingerprint of the `SandboxEnv` it was made with, not the values: the
   * proxy URL may hold a password.
   */
  envKey?: string;
  /** The sandbox network it was made on; absent before it could be anything but the default. */
  network?: string;
  /** Set while a failed idle stop waits for its retry (plan 9.5). */
  idleStopRetry?: { failures: number; retryAt: string };
}

const specOf = (row: ComputerRow): MachineSpec => (row.spec ?? {}) as MachineSpec;

function sandboxEnv(deps: AppDeps): SandboxEnv {
  const proxy = deps.config.sandboxProxy;
  return { egressProxy: proxy?.url, noProxy: proxy?.noProxy, timezone: deps.config.timezone };
}

function envKey({ egressProxy, noProxy, timezone }: SandboxEnv): string {
  const values = [egressProxy ?? null, noProxy ?? null, timezone ?? 'UTC'];
  return createHash('sha256').update(JSON.stringify(values)).digest('base64url');
}

/** True when the machine was made with other settings than the configured ones. */
function envChanged(deps: AppDeps, row: ComputerRow): boolean {
  // Machines made before the fingerprint was recorded have no proxy and run on UTC.
  return (specOf(row).envKey ?? envKey({})) !== envKey(sandboxEnv(deps));
}

/**
 * True when the machine was made on another sandbox network than the
 * configured one (OPENBOTS_SANDBOX_NETWORK changed, for example when the Mac
 * app moved its stack off a network another stack holds).
 */
function networkChanged(deps: AppDeps, row: ComputerRow): boolean {
  return (specOf(row).network ?? SANDBOX_NETWORK) !== deps.config.sandboxNetwork.name;
}

/** True when the machine runs another image than the configured one: OpenBots was upgraded. */
function imageChanged(deps: AppDeps, row: ComputerRow): boolean {
  return (specOf(row).image ?? deps.config.sandboxImage) !== deps.config.sandboxImage;
}

/** The spec without a pending idle stop retry, once the computer stopped or started. */
function settledSpec(row: ComputerRow): MachineSpec {
  const { idleStopRetry: _, ...spec } = specOf(row);
  return spec;
}

/** How long the sweep waits before retrying an idle stop that failed `failures` times. */
export function idleStopRetryDelayMs(failures: number) {
  return Math.min(IDLE_SWEEP_MS * 2 ** Math.max(0, failures - 1), IDLE_STOP_RETRY_MAX_MS);
}

export const computerUnavailable = (message: string) =>
  new DomainError(503, 'COMPUTER_UNAVAILABLE', message);

/** The owner's computer is not running, and this path does not start it (409). */
export const computerOff = () =>
  new DomainError(409, COMPUTER_OFF, 'The computer is off. Start it first.');

const NO_PROVIDER =
  'This install has no computer: set DOCKER_HOST (the docker guard) or OPENBOTS_COMPUTER_AGENT_URL';

const REMOTE_TAKEN =
  "This install's computer is one remote machine, and another account already uses it. " +
  'An administrator can set OPENBOTS_COMPUTER_AGENT_SHARED=true to let every account share it, ' +
  'files and logins included.';

// One provider per process: keyed by its config, which every deps of the process shares.
const providers = new WeakMap<object, ComputerProvider | null>();

/** Replaces the provider for one `AppDeps` (tests use a mocked dockerode or the fake agent). */
export function setComputerProvider(deps: AppDeps, provider: ComputerProvider | null) {
  providers.set(deps.config, provider);
}

export function computerProvider(deps: AppDeps): ComputerProvider | null {
  if (!providers.has(deps.config)) {
    const { computerAgent, dockerHost } = deps.config;
    if (computerAgent?.shared) {
      deps.logger.warn(
        'OPENBOTS_COMPUTER_AGENT_SHARED is on: every account shares the remote computer, its files and its logins',
      );
    }
    providers.set(
      deps.config,
      computerAgent
        ? createRemoteProvider(computerAgent)
        : dockerHost
          ? createDockerProvider({ dockerHost, network: deps.config.sandboxNetwork })
          : null,
    );
  }
  return providers.get(deps.config) ?? null;
}

export function computerAvailable(deps: AppDeps) {
  return computerProvider(deps) !== null;
}

function provider(deps: AppDeps) {
  const found = computerProvider(deps);
  if (!found) throw computerUnavailable(NO_PROVIDER);
  return found;
}

const keyring = (deps: AppDeps) => keyringFromConfig(deps.config);

/** The owner's computer in an organization: one per (organization, owner) (plan 21.3). */
export async function getComputer(deps: Pick<AppDeps, 'db'>, owner: Owner) {
  const [row] = await deps.db
    .select()
    .from(schema.computers)
    .where(
      and(
        eq(schema.computers.ownerId, owner.id),
        eq(schema.computers.workspaceId, owner.workspaceId),
      ),
    );
  return row ?? null;
}

export async function listScreens(deps: Pick<AppDeps, 'db'>, computerId: string) {
  return deps.db
    .select()
    .from(schema.botScreens)
    .where(eq(schema.botScreens.computerId, computerId));
}

async function setStatus(
  deps: AppDeps,
  row: ComputerRow,
  status: ComputerStatus,
  more: Partial<ComputerRow> = {},
  error: string | null = null,
): Promise<ComputerRow> {
  const [updated] = await deps.db
    .update(schema.computers)
    .set({ status, ...more })
    .where(eq(schema.computers.id, row.id))
    .returning();
  await publishStatus(deps, row, status, error);
  return updated ?? row;
}

function publishStatus(
  deps: AppDeps,
  row: ComputerRow,
  status: ComputerStatus,
  error: string | null = null,
) {
  return publishEvent(
    deps.infra.bus,
    wsEvent(
      'computer.status',
      { computerId: row.id, status, error },
      { user_id: row.ownerId, workspace_id: row.workspaceId },
    ),
  );
}

function refOf(deps: AppDeps, row: ComputerRow): ComputerRef {
  if (!row.agentUrl || !row.agentToken) throw computerUnavailable('The computer was never created');
  return {
    provider: row.provider,
    containerId: row.containerId,
    agentUrl: row.agentUrl,
    agentToken: decryptSecretString(row.agentToken, keyring(deps)),
    volumeName: row.volumeName,
  };
}

export function agentFor(deps: AppDeps, row: ComputerRow): ComputerAgentClient {
  return provider(deps).agent(refOf(deps, row));
}

/** The owner's computer row, creating the machine behind it on first use. */
export async function ensureComputer(
  deps: AppDeps,
  owner: Owner,
  by: AuditActor = { type: 'user', id: owner.id },
): Promise<ComputerRow> {
  const machines = provider(deps);
  let row = await getComputer(deps, owner);
  if (!row) {
    await deps.db.transaction(async (tx) => {
      // Two accounts asking at once: one takes the remote machine.
      if (machines.name === 'remote') {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('openbots:remote-computer'))`);
      }
      await assertRemoteFor(deps, owner, tx);
      await tx
        .insert(schema.computers)
        .values({
          workspaceId: owner.workspaceId,
          ownerId: owner.id,
          provider: machines.name,
          status: 'creating',
          idleTimeoutMin: DEFAULT_IDLE_TIMEOUT_MIN,
        })
        .onConflictDoNothing();
    });
    row = (await getComputer(deps, owner))!;
  } else {
    row = await adoptStrayRemote(deps, row);
    await assertRemoteFor(deps, owner);
  }
  if (row.agentUrl && row.agentToken) return row;
  return createMachine(deps, row, by);
}

/** Whether an agent URL points at this host's loopback. */
function loopbackUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || inRanges(host, ['127.0.0.0/8', '::1']);
  } catch {
    return false;
  }
}

/**
 * A database restored from the standalone image into the compose stack (or
 * any Docker install) has `remote` computers whose agent was on the
 * standalone container's loopback (`http://127.0.0.1:7070`), which is
 * nothing here. With no OPENBOTS_COMPUTER_AGENT_URL and Docker as the
 * provider, such a row becomes a Docker computer that is made at its next
 * start, keeping its home volume's name. Any other remote row is left alone.
 */
async function adoptStrayRemote(deps: AppDeps, row: ComputerRow): Promise<ComputerRow> {
  if (row.provider !== 'remote' || deps.config.computerAgent) return row;
  if (provider(deps).name !== 'docker' || !loopbackUrl(row.agentUrl)) return row;
  const [adopted] = await deps.db
    .update(schema.computers)
    .set({
      provider: 'docker',
      containerId: null,
      agentUrl: null,
      agentToken: null,
      status: 'stopped',
    })
    .where(and(eq(schema.computers.id, row.id), eq(schema.computers.provider, 'remote')))
    .returning();
  deps.logger.info(
    { computerId: row.id, agentUrl: row.agentUrl, volumeName: row.volumeName },
    'a remote computer on a loopback agent (a restored standalone database) becomes a Docker computer, made at this start with its volume',
  );
  return adopted ?? row;
}

/**
 * Refuses an account the remote machine when another account used it first
 * and the operator has not shared it (plan 9.2, K1). Rows from before this
 * rule keep the oldest account as the machine's.
 */
async function assertRemoteFor(deps: AppDeps, owner: Owner, db: Db = deps.db) {
  if (provider(deps).name !== 'remote' || deps.config.computerAgent?.shared) return;
  // An account in two organizations has two computers (plan 21.3): the
  // machine belongs to one of them.
  const [first] = await db
    .select({ ownerId: schema.computers.ownerId, workspaceId: schema.computers.workspaceId })
    .from(schema.computers)
    .where(eq(schema.computers.provider, 'remote'))
    .orderBy(asc(schema.computers.createdAt), asc(schema.computers.id))
    .limit(1);
  if (first && (first.ownerId !== owner.id || first.workspaceId !== owner.workspaceId)) {
    throw computerUnavailable(REMOTE_TAKEN);
  }
}

/**
 * Makes the machine behind the row, or makes it again from the configured
 * image and settings (`updating`), keeping its volumes.
 */
async function createMachine(
  deps: AppDeps,
  row: ComputerRow,
  by: AuditActor,
  status: 'creating' | 'updating' = 'creating',
): Promise<ComputerRow> {
  const machines = provider(deps);
  row = await setStatus(deps, row, status);
  const agentToken = randomBytes(32).toString('base64url');
  const env = sandboxEnv(deps);
  try {
    const ref = await machines.create({
      computerId: row.id,
      ownerId: row.ownerId,
      image: deps.config.sandboxImage,
      agentToken,
      volumeName: row.volumeName ?? volumeName(row.id),
      ...env,
    });
    const created = await setStatus(deps, row, 'stopped', {
      provider: ref.provider,
      containerId: ref.containerId,
      agentUrl: ref.agentUrl,
      agentToken: encryptSecret(ref.agentToken, keyring(deps)),
      volumeName: ref.volumeName,
      spec: {
        ...settledSpec(row),
        image: deps.config.sandboxImage,
        envKey: envKey(env),
        network: deps.config.sandboxNetwork.name,
      },
    });
    await auditComputer(deps, created, by, 'computer.create', {
      provider: ref.provider,
      ...(status === 'updating' ? { updated: true, image: deps.config.sandboxImage } : {}),
    });
    return created;
  } catch (error) {
    const message = errorText(error);
    deps.logger.error({ err: error, computerId: row.id }, 'computer create failed');
    await setStatus(deps, row, 'error', {}, message);
    throw computerUnavailable(`The computer could not be created: ${message}`);
  }
}

export interface Started {
  computer: ComputerRow;
  /** Set when this call had to start it. */
  durationMs: number | null;
  /** This start made the machine again from a new image or new settings first. */
  updated: boolean;
}

const starting = new Map<string, Promise<Started>>();
const startKey = (owner: Owner) => `${owner.workspaceId}:${owner.id}`;

/** Starts the owner's computer (creating it on first use) and waits for its agent. */
export function startComputer(
  deps: AppDeps,
  owner: Owner,
  by: AuditActor = { type: 'user', id: owner.id },
): Promise<Started> {
  const key = startKey(owner);
  const pending = starting.get(key);
  if (pending) return pending;
  const started = start(deps, owner, by).finally(() => starting.delete(key));
  starting.set(key, started);
  return started;
}

async function start(deps: AppDeps, owner: Owner, by: AuditActor): Promise<Started> {
  const machines = provider(deps);
  let row = await ensureComputer(deps, owner, by);
  const machine = await machines.status(refOf(deps, row));
  if (machine === 'running' && row.status === 'running') {
    return { computer: await touch(deps, row), durationMs: null, updated: false };
  }
  const began = Date.now();
  // Removed behind the server's back: made again, same home volume.
  if (machine === 'missing') row = await createMachine(deps, row, by);
  // Made from an older image (an upgrade, plan 16.3), before the egress
  // proxy or the timezone changed, or on another sandbox network: made again,
  // same volumes. Only ever a stopped machine, so a running one moves at its
  // next stop, never mid-task.
  const updated =
    machine === 'stopped' &&
    machines.name === 'docker' &&
    (imageChanged(deps, row) ||
      envChanged(deps, row) ||
      networkChanged(deps, row) ||
      // The same tag (`latest`) on a newer build, pulled at worker start.
      (await machines.runsImage?.(refOf(deps, row), deps.config.sandboxImage)) === false);
  if (updated) row = await createMachine(deps, row, by, 'updating');
  row = await setStatus(deps, row, 'starting');
  try {
    await machines.start(refOf(deps, row));
  } catch (error) {
    const message = errorText(error);
    deps.logger.error({ err: error, computerId: row.id }, 'computer start failed');
    await setStatus(deps, row, 'error', {}, message);
    throw computerUnavailable(`The computer did not start: ${message}`);
  }
  // A fresh start has no displays running yet.
  await deps.db
    .update(schema.botScreens)
    .set({ status: 'stopped' })
    .where(eq(schema.botScreens.computerId, row.id));
  row = await setStatus(deps, row, 'running', { lastUsedAt: new Date(), spec: settledSpec(row) });
  await auditComputer(deps, row, by, 'computer.start', { durationMs: Date.now() - began });
  queueRepoJobs(deps, row.id);
  // The hour's wallpaper (K5) on the computer's own clock (its TZ); the agent
  // keeps it current from here.
  agentFor(deps, row)
    .setWallpaper()
    .catch((error: unknown) => deps.logger.warn({ err: error }, 'wallpaper failed'));
  return { computer: row, durationMs: Date.now() - began, updated };
}

/**
 * After a start (GH4, GH6): remembered repositories a new home volume lost
 * are cloned again, then clones made by hand are listed. Queued, never
 * waited on; a failure to queue does not fail the start.
 */
function queueRepoJobs(deps: AppDeps, computerId: string) {
  enqueueCoderJob(deps, { kind: 'reconcile', computerId })
    .then(() => enqueueCoderJob(deps, { kind: 'scan', computerId }))
    .catch((error: unknown) =>
      deps.logger.warn({ err: error, computerId }, 'queueing repository jobs failed'),
    );
}

/** What `wakeComputer` did. */
export type Wake =
  /** No computer provider: nothing to start. */
  | 'unavailable'
  /** No computer yet, and this wake does not create one. */
  | 'none'
  /** Already running (marked used when asked). */
  | 'running'
  /** A start, an update or a stop is under way: left to finish. */
  | 'busy'
  /** A start began in the background. */
  | 'starting';

export interface WakeOptions {
  /** Creates the computer on first use (the Mac app's launch); a message never does. */
  create?: boolean;
  /** Marks a running computer used: a message is activity, the app's launch is not. */
  touch?: boolean;
  by?: AuditActor;
}

/** Statuses a wake leaves alone. */
const BUSY = new Set<string>(['creating', 'updating', 'starting', 'stopping']);

/**
 * Starts the owner's computer in the background when it is off (plan 9.5):
 * the Mac app's launch on This Mac, and an owner's message to their Bots. It
 * returns once the start began, without waiting for it: a failed start is
 * logged and leaves the computer `error`, as any start does. One start runs per
 * computer at a time, and a computer already starting, updating or stopping
 * is left alone. It never changes the idle settings, so the idle sweep stops
 * the computer again once it goes unused.
 */
export async function wakeComputer(
  deps: AppDeps,
  owner: Owner,
  { create = false, touch: used = false, by = { type: 'user', id: owner.id } }: WakeOptions = {},
): Promise<Wake> {
  if (!computerAvailable(deps)) return 'unavailable';
  if (starting.has(startKey(owner))) return 'busy';
  const row = await getComputer(deps, owner);
  if (!row && !create) return 'none';
  if (row?.status === 'running') {
    if (used) await touchComputer(deps, row.id);
    return 'running';
  }
  if (row && BUSY.has(row.status)) return 'busy';
  startComputer(deps, owner, by).catch((error: unknown) =>
    deps.logger.warn(
      { err: error, ownerId: owner.id, workspaceId: owner.workspaceId },
      'computer wake failed',
    ),
  );
  return 'starting';
}

/**
 * The owner's computer when it is running, never starting it: the file
 * browser, the terminal and Preview use this, so a stale tab does not boot the
 * sandbox. Throws `COMPUTER_OFF` (409) otherwise.
 */
export async function runningComputer(deps: AppDeps, owner: Owner): Promise<ComputerRow> {
  provider(deps);
  const row = await getComputer(deps, owner);
  if (row?.status !== 'running') throw computerOff();
  await assertRemoteFor(deps, owner);
  return touch(deps, row);
}

async function touch(deps: AppDeps, row: ComputerRow) {
  const [updated] = await deps.db
    .update(schema.computers)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.computers.id, row.id))
    .returning();
  return updated ?? row;
}

/**
 * Marks the computer used now, so the idle sweep leaves it running: the
 * terminal and screen sockets call it while their frames flow (plan 9.5).
 */
export async function touchComputer(deps: Pick<AppDeps, 'db'>, computerId: string) {
  await deps.db
    .update(schema.computers)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(schema.computers.id, computerId), eq(schema.computers.status, 'running')));
}

/**
 * At worker start, after an upgrade: pulls the sandbox image again when it is
 * already present, so a tag that moves with releases (`latest`, `1.2`) brings
 * the new computer image. `docker compose pull` does not pull it, since no
 * compose service runs it. Each computer moves to it at its next start.
 */
export async function refreshSandboxImage(deps: AppDeps): Promise<void> {
  const machines = computerProvider(deps);
  if (!machines?.refreshImage) return;
  try {
    await machines.refreshImage(deps.config.sandboxImage);
  } catch (error) {
    deps.logger.warn(
      { err: error, image: deps.config.sandboxImage },
      'sandbox image refresh failed',
    );
  }
}

/** What the owner can set on their computer (plan 4.5, 9.5). */
export interface ComputerSettings {
  /** Never stopped for idleness. */
  alwaysOn?: boolean;
  /** Minutes unused before the idle sweep stops it, within `IDLE_TIMEOUT_RANGE_MIN`. */
  idleTimeoutMin?: number;
}

/** Saves the owner's settings on their computer; the next sweep applies them. */
export async function updateComputerSettings(
  deps: AppDeps,
  row: ComputerRow,
  settings: ComputerSettings,
): Promise<ComputerRow> {
  const [updated] = await deps.db
    .update(schema.computers)
    .set({
      ...(settings.alwaysOn !== undefined ? { alwaysOn: settings.alwaysOn } : {}),
      ...(settings.idleTimeoutMin !== undefined ? { idleTimeoutMin: settings.idleTimeoutMin } : {}),
    })
    .where(eq(schema.computers.id, row.id))
    .returning();
  return updated ?? row;
}

export async function stopComputer(
  deps: AppDeps,
  row: ComputerRow,
  by: AuditActor = { type: 'user', id: row.ownerId },
): Promise<ComputerRow> {
  if (!row.agentUrl || row.status === 'stopped') return row;
  return stopMachine(deps, await setStatus(deps, row, 'stopping'), by);
}

/**
 * Stops the owner's computer if it is up, then starts it again; its files
 * and sign-ins are kept. A stopped computer just starts.
 */
export async function restartComputer(
  deps: AppDeps,
  owner: Owner,
  row: ComputerRow,
  by: AuditActor = { type: 'user', id: owner.id },
): Promise<Started> {
  await stopComputer(deps, row, by);
  return startComputer(deps, owner, by);
}

/**
 * Stops the machine of a row already set `stopping`. On failure the row is
 * `error`, with `failed` merged in (the idle sweep's retry), and it throws.
 */
async function stopMachine(
  deps: AppDeps,
  row: ComputerRow,
  by: AuditActor,
  failed: Partial<ComputerRow> = {},
): Promise<ComputerRow> {
  // Its owner's stdio connectors running in it end first, in every process.
  await deps.infra.bus
    .publish<McpControl>(MCP_CONTROL_CHANNEL, {
      type: 'computer',
      ownerId: row.ownerId,
      workspaceId: row.workspaceId,
    })
    .catch((error: unknown) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'stopping stdio connectors failed'),
    );
  // And its coding sessions, wherever their jobs run (I12).
  await deps.infra.bus
    .publish<CoderControl>(CODER_CONTROL_CHANNEL, { type: 'stop_all', computerId: row.id })
    .catch((error: unknown) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'stopping coding sessions failed'),
    );
  try {
    await provider(deps).stop(refOf(deps, row));
  } catch (error) {
    const message = errorText(error);
    await setStatus(deps, row, 'error', failed, message);
    throw computerUnavailable(`The computer did not stop: ${message}`);
  }
  await deps.db
    .update(schema.botScreens)
    .set({ status: 'stopped' })
    .where(eq(schema.botScreens.computerId, row.id));
  // A stopped screen has nothing to hold: a takeover ends with it.
  await releaseScreens(
    deps,
    by,
    and(eq(schema.botScreens.computerId, row.id), isNotNull(schema.botScreens.controlledByUserId))!,
  );
  const stopped = await setStatus(deps, row, 'stopped', { spec: settledSpec(row) });
  await auditComputer(deps, stopped, by, 'computer.stop', {});
  return stopped;
}

/**
 * Hands back every screen matching `where` that someone holds, as a hand
 * back would (audited, `screen.control` published), so the Bots' waiting
 * screen actions go on. For a stop, a disabled member, or a takeover whose
 * tab went away. Returns the screens it released.
 */
export async function releaseScreens(
  deps: AppDeps,
  by: AuditActor,
  where: SQL,
): Promise<ScreenRow[]> {
  const released = await deps.db
    .update(schema.botScreens)
    .set({ controlledByUserId: null, controlledSince: null })
    .where(and(where, isNotNull(schema.botScreens.controlledByUserId)))
    .returning();
  for (const screen of released) {
    await recordAudit(deps.db, {
      workspaceId: screen.workspaceId,
      actor: by,
      action: 'computer.release',
      targetType: 'bot',
      targetId: screen.botId,
      metadata: { screenId: screen.id, display: screen.displayNumber },
    });
    await publishControl(deps, screen, null);
  }
  return released;
}

function publishControl(deps: AppDeps, screen: ScreenRow, userId: string | null) {
  return publishEvent(
    deps.infra.bus,
    wsEvent(
      'screen.control',
      {
        screenId: screen.id,
        controller: userId ? 'user' : 'bot',
        userId,
        botId: screen.botId,
        display: screen.displayNumber,
      },
      { bot_id: screen.botId },
    ),
  );
}

function auditComputer(
  deps: AppDeps,
  row: ComputerRow,
  by: AuditActor,
  action: 'computer.create' | 'computer.start' | 'computer.stop',
  metadata: Record<string, unknown>,
) {
  return recordAudit(deps.db, {
    workspaceId: row.workspaceId,
    actor: by,
    action,
    targetType: 'computer',
    targetId: row.id,
    metadata,
  });
}

/**
 * Stops computers idle past their `idle_timeout_min` (plan 9.5); returns how
 * many. An idle stop that fails leaves the computer `error` and is retried on
 * a later sweep, after one sweep and then twice as long each time, up to
 * `IDLE_STOP_RETRY_MAX_MS`; starting the computer again drops the retry.
 */
export async function sweepIdleComputers(deps: AppDeps, now = new Date()): Promise<number> {
  if (!computerAvailable(deps)) return 0;
  const candidates = await deps.db
    .select()
    .from(schema.computers)
    .where(
      and(
        inArray(schema.computers.status, ['running', 'error']),
        eq(schema.computers.alwaysOn, false),
      ),
    );
  let stopped = 0;
  for (const row of candidates) {
    // An `error` row is retried only when an idle stop failed and its retry is due.
    const retry = specOf(row).idleStopRetry;
    const stopping =
      row.status === 'running'
        ? await claimIdle(deps, row, now)
        : retry && Date.parse(retry.retryAt) <= now.getTime()
          ? await claim(deps, row, eq(schema.computers.status, 'error'))
          : null;
    if (!stopping) continue;
    const failures = row.status === 'error' ? (retry?.failures ?? 0) + 1 : 1;
    const retryAt = new Date(now.getTime() + idleStopRetryDelayMs(failures)).toISOString();
    try {
      await publishStatus(deps, stopping, 'stopping');
      await stopMachine(deps, stopping, SYSTEM_ACTOR, {
        spec: { ...specOf(stopping), idleStopRetry: { failures, retryAt } },
      });
      stopped++;
    } catch (error) {
      deps.logger.warn({ err: error, computerId: row.id, failures, retryAt }, 'idle stop failed');
    }
  }
  return stopped;
}

/**
 * Claims a running computer idle past its timeout, unless it was used
 * meanwhile or the owner has one of its screens (K3): a takeover is in use
 * however long the sign-in takes.
 */
function claimIdle(deps: AppDeps, row: ComputerRow, now: Date) {
  const idleMs = (row.idleTimeoutMin ?? DEFAULT_IDLE_TIMEOUT_MIN) * 60_000;
  const last = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
  if (now.getTime() - last < idleMs) return null;
  const held = deps.db
    .select({ id: schema.botScreens.id })
    .from(schema.botScreens)
    .where(
      and(
        eq(schema.botScreens.computerId, schema.computers.id),
        isNotNull(schema.botScreens.controlledByUserId),
      ),
    );
  return claim(
    deps,
    row,
    and(
      eq(schema.computers.status, 'running'),
      or(
        isNull(schema.computers.lastUsedAt),
        lt(schema.computers.lastUsedAt, new Date(now.getTime() - idleMs)),
      ),
      not(exists(held)),
    ),
  );
}

/** Sets the row `stopping` if it still matches, so two workers sweeping at once stop it once. */
async function claim(deps: AppDeps, row: ComputerRow, still: SQL | undefined) {
  const [claimed] = await deps.db
    .update(schema.computers)
    .set({ status: 'stopping' })
    .where(and(eq(schema.computers.id, row.id), still))
    .returning();
  return claimed ?? null;
}

/** The Bot's screen row, allocated on first use, with its display started on the agent. */
export async function ensureScreen(
  deps: AppDeps,
  bot: BotRow,
  computer: ComputerRow,
  agent: ComputerAgentClient,
): Promise<ScreenRow> {
  let screen = await screenOf(deps, bot.id);
  const allocated = !screen;
  for (let attempt = 0; !screen && attempt < 5; attempt++) {
    await deps.db.transaction(async (tx) => {
      // Displays belong to the machine. A remote agent is one machine for
      // every row on it, so its displays are allocated across accounts, one
      // at a time; a docker computer is its own machine.
      const shared = computer.provider === 'remote' && computer.agentUrl;
      if (shared) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`openbots:screens:${computer.agentUrl}`}))`,
        );
      }
      const taken = await tx
        .select({ display: schema.botScreens.displayNumber })
        .from(schema.botScreens)
        .innerJoin(schema.computers, eq(schema.computers.id, schema.botScreens.computerId))
        .where(
          shared
            ? eq(schema.computers.agentUrl, shared)
            : eq(schema.botScreens.computerId, computer.id),
        );
      const display = nextDisplay(taken.map((s) => s.display));
      // Unique on the Bot and on (computer, display): a racing allocation retries.
      await tx
        .insert(schema.botScreens)
        .values({
          workspaceId: bot.workspaceId,
          botId: bot.id,
          computerId: computer.id,
          displayNumber: display,
          cdpPort: cdpPortFor(display),
          browserProfileDir: browserProfileDir(display),
          status: 'stopped',
        })
        .onConflictDoNothing();
    });
    screen = await screenOf(deps, bot.id);
  }
  if (!screen) throw computerUnavailable('No screen could be allocated for this Bot');
  if (allocated || screen.status !== 'running') {
    // The agent keeps Chromium's profile per screen number; a display freed by
    // a deleted Bot must not hand its logins to the next one.
    const info = await agent.startScreen({
      n: screenNumber(screen.displayNumber),
      ...SCREEN_SIZE,
      ...(allocated ? { fresh: true } : {}),
    });
    const [updated] = await deps.db
      .update(schema.botScreens)
      .set({ status: 'running', cdpPort: info.cdpPort })
      .where(eq(schema.botScreens.id, screen.id))
      .returning();
    screen = updated ?? screen;
  }
  return screen;
}

export async function screenOf(deps: Pick<AppDeps, 'db'>, botId: string) {
  const [row] = await deps.db
    .select()
    .from(schema.botScreens)
    .where(eq(schema.botScreens.botId, botId));
  return row ?? null;
}

/**
 * After a Bot is deleted (B7): stops its screen if the computer is running,
 * best effort, so its Chromium and the Bot's logins do not linger. Its
 * `bot_screens` row went with the Bot (foreign-key cascade), which frees the
 * display; on a stopped computer nothing runs, and the next Bot given that
 * display starts with a fresh profile (`ensureScreen`).
 */
export async function stopDeletedBotScreen(deps: AppDeps, screen: ScreenRow | null) {
  if (!screen || !computerAvailable(deps)) return;
  try {
    const [computer] = await deps.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, screen.computerId));
    if (computer?.status !== 'running') return;
    await agentFor(deps, computer).stopScreen(
      screenNumber(screen.displayNumber),
      AbortSignal.timeout(SCREEN_STOP_TIMEOUT_MS),
    );
  } catch (error) {
    // Not running on the agent (a restart, say) is what we wanted anyway.
    if (error instanceof AgentError && error.status === 404) return;
    deps.logger.warn({ err: error, screenId: screen.id }, 'stopping a deleted Bot screen failed');
  }
}

/**
 * Take or hand back a Bot's screen (plan 9.4, K3). Taking it starts the
 * computer and the screen so the owner has something to drive, and opens
 * `url` in its browser when given (a sign-in page, K8).
 */
export async function setScreenControl(
  deps: AppDeps,
  user: Owner,
  botId: string,
  take: boolean,
  url?: string,
): Promise<ScreenRow> {
  await assertBotOwner(deps.db, user, botId);
  let screen = await screenOf(deps, botId);
  if (take) {
    const { computer } = await startComputer(deps, user);
    const agent = agentFor(deps, computer);
    screen = await ensureScreen(
      deps,
      { id: botId, ownerId: user.id, workspaceId: user.workspaceId },
      computer,
      agent,
    );
    if (url) {
      // The owner can still type the address; a page that will not load is no reason to refuse.
      await agent
        .browser(screenNumber(screen.displayNumber), { action: 'navigate', url })
        .catch((error: unknown) => deps.logger.warn({ err: error, botId }, 'navigate failed'));
    }
  }
  if (!screen) throw notFound('This Bot has no screen yet');
  const [updated] = await deps.db
    .update(schema.botScreens)
    .set(
      take
        ? { controlledByUserId: user.id, controlledSince: new Date() }
        : { controlledByUserId: null, controlledSince: null },
    )
    .where(eq(schema.botScreens.id, screen.id))
    .returning();
  await recordAudit(deps.db, {
    workspaceId: user.workspaceId,
    actor: { type: 'user', id: user.id },
    action: take ? 'computer.takeover' : 'computer.release',
    targetType: 'bot',
    targetId: botId,
    metadata: { screenId: screen.id, display: screen.displayNumber },
  });
  await publishControl(deps, updated ?? screen, take ? user.id : null);
  // What the owner did on the screen, a sign-in say, reaches the other Bots (K1).
  if (!take && screen.status === 'running') await syncCookies(deps, user, screen);
  return updated!;
}

/**
 * Spreads the cookies of `screen`'s browser, or of every running screen's,
 * to the account's other screens now (K1). The agent also syncs after each
 * action and every 30 seconds; this is for what the owner did by hand. False
 * when the computer is not running or the agent could not sync.
 */
export async function syncCookies(
  deps: AppDeps,
  owner: Owner,
  screen?: Pick<ScreenRow, 'displayNumber'>,
): Promise<boolean> {
  if (!computerAvailable(deps)) return false;
  const computer = await getComputer(deps, owner);
  if (computer?.status !== 'running') return false;
  try {
    await agentFor(deps, computer).syncCookies(
      screen ? screenNumber(screen.displayNumber) : undefined,
    );
    return true;
  } catch (error) {
    deps.logger.warn({ err: error, computerId: computer.id }, 'cookie sync failed');
    return false;
  }
}

/** Waits until nobody holds the Bot's screen; false when `timeoutMs` passes first. */
async function waitForHandBack(
  deps: AppDeps,
  botId: string,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const screen = await screenOf(deps, botId);
    if (!screen?.controlledByUserId) return true;
    if (Date.now() >= deadline) return false;
    signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  }
}

const screenLocks = new ScreenLocks();

export interface ComputerRunOptions {
  bot: BotRow;
  runId: string;
  signal?: AbortSignal;
  recordStep(step: StepRecord): Promise<void>;
  /**
   * The run had to start the computer (W3): the run posts its compact event
   * row, which says when the start updated it first. Not called when the
   * computer was already running.
   */
  onComputerStarted?(durationMs: number, updated: boolean): Promise<void>;
  /** How long a screen action waits for a hand back; `TAKEOVER_WAIT_MS` by default. */
  takeoverWaitMs?: number;
  takeoverPollMs?: number;
  /** How often a running command marks the computer used; `EXEC_TOUCH_MS` by default. */
  execTouchMs?: number;
}

/** How often a command still running marks the computer used. */
export const EXEC_TOUCH_MS = 60_000;

/**
 * The agent, with a command marking the computer used while it runs: `bash`
 * may run for 30 minutes, longer than the shortest idle timeout, and the idle
 * sweep must not stop the computer under it (plan 9.5).
 */
function inUse(
  deps: AppDeps,
  computerId: string,
  agent: ComputerAgentClient,
  everyMs = EXEC_TOUCH_MS,
): ComputerAgentClient {
  return {
    ...agent,
    async exec(request, options) {
      const timer = setInterval(() => {
        touchComputer(deps, computerId).catch((error: unknown) =>
          deps.logger.warn({ err: error, computerId }, 'marking the computer used failed'),
        );
      }, everyMs);
      try {
        return await agent.exec(request, options);
      } finally {
        clearInterval(timer);
      }
    },
  };
}

/** The computer tools' backend for one run (the agent's `ComputerServices`). */
export function computerServices(deps: AppDeps, options: ComputerRunOptions): ComputerServices {
  const { bot, runId, signal } = options;
  const owner = { id: bot.ownerId, workspaceId: bot.workspaceId };
  // Calls in one step share a start; it is logged once.
  const logged = new WeakSet<Started>();
  const ready = async () => {
    const started = await startComputer(deps, owner, { type: 'bot', id: bot.id });
    const { computer, durationMs, updated } = started;
    if (durationMs !== null && !logged.has(started)) {
      logged.add(started);
      await options.recordStep({
        type: 'tool_call',
        label: labelFor('computer_start', {}, { durationMs }),
        payload: { toolName: 'computer_start', durationMs },
        durationMs,
      });
      // A missing event row never fails the tool call that needed the computer.
      await options.onComputerStarted?.(durationMs, updated).catch((error: unknown) => {
        deps.logger.warn({ err: error, runId }, 'computer started event failed');
      });
    }
    const agent = inUse(deps, computer.id, agentFor(deps, computer), options.execTouchMs);
    return { computer, agent };
  };
  // While the owner holds the screen, wait for the hand back (K3).
  const holdForOwner = async (screen: ScreenRow | null, tool: string) => {
    if (!screen?.controlledByUserId) return;
    await setState(deps, bot.id, 'waiting', {
      runId,
      currentAction: 'Waiting: the owner has the screen',
    });
    const free = await waitForHandBack(
      deps,
      bot.id,
      options.takeoverWaitMs ?? TAKEOVER_WAIT_MS,
      options.takeoverPollMs ?? TAKEOVER_POLL_MS,
      signal,
    );
    if (!free) throw new OwnerHasScreen();
    await setState(deps, bot.id, 'working', {
      runId,
      currentAction: 'Back on the screen',
      currentTool: tool,
    });
  };
  return {
    ...(signal ? { signal } : {}),
    agent: async () => (await ready()).agent,
    screen: (fn) =>
      screenLocks.run(
        bot.id,
        async () => {
          const { computer, agent } = await ready();
          const screen = await ensureScreen(deps, bot, computer, agent);
          await holdForOwner(screen, 'computer');
          return fn(screenNumber(screen.displayNumber), agent);
        },
        signal,
      ),
    // A command can drive the screen too (xdotool), so bash waits as well
    // (S-7). A Bot with no screen yet has nothing the owner could hold.
    screenFree: async () => holdForOwner(await screenOf(deps, bot.id), 'bash'),
    // A command runs with the Bot's own display and no other's (S-7).
    screenNumber: async () => {
      const screen = await screenOf(deps, bot.id);
      return screen ? screenNumber(screen.displayNumber) : undefined;
    },
  };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
