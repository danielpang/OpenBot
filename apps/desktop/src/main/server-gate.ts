import type { ServerProfile } from '../ipc.js';
import type { StackManager } from '../stack/manager.js';
import { serverPath } from './navigation.js';
import { CHECK_TIMEOUT_MS, checkServer, ServerCheckError, type FetchLike } from './server-check.js';

// Whether the main window may load a profile's server (plan 14.4). Another
// program can answer at a profile's address: a dev server on the local
// stack's port, or a page where a self-hosted server used to be. So nothing
// loads a server page until the server answers as OpenBots (./server-check.ts)
// and, for This Mac, until the app's own Compose project has its server
// running and healthy. A pass is remembered briefly, so the load right after
// it is not checked twice; any later load of the server is checked again.

export const NOT_OPENBOTS_SERVER = 'This address does not answer as an OpenBots server.';
export const LOCAL_STOPPED = 'OpenBots is not running on this Mac.';
export const LOCAL_NOT_READY = 'The OpenBots server on this Mac is not ready yet.';

export function portUsedMessage(port: number): string {
  return `Port ${port} on this Mac is used by another app, not OpenBots.`;
}

/** How long a pass lets loads of the server through without another check. */
export const FRESH_MS = 15_000;

export interface Refusal {
  ok: false;
  /** port-taken and stopped are This Mac's; the others any server's. */
  reason: 'port-taken' | 'stopped' | 'not-openbots' | 'unreachable';
  /** The sentence the start page shows. */
  message: string;
}

export type Verdict = { ok: true; setupRequired: boolean } | Refusal;

export interface VerifyOptions {
  fetch: FetchLike;
  /**
   * This Mac's stack. Null when the local profile points at a development
   * server instead (OPENBOTS_DESKTOP_LOCAL_URL), which only has to answer as
   * OpenBots.
   */
  stack: Pick<StackManager, 'status'> | null;
  timeoutMs?: number;
}

function port(url: string): number {
  const parsed = new URL(url);
  return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
}

/** Anything at all answers HTTP at the address. */
async function answers(fetch: FetchLike, url: string, timeoutMs: number): Promise<boolean> {
  return fetch(new URL('/healthz', url).toString(), {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  }).then(
    () => true,
    () => false,
  );
}

async function verifyAddress(
  profile: ServerProfile,
  fetch: FetchLike,
  timeoutMs: number,
): Promise<Verdict> {
  try {
    const { setupRequired } = await checkServer(fetch, profile.url, timeoutMs);
    return { ok: true, setupRequired };
  } catch (error) {
    if (!(error instanceof ServerCheckError)) throw error;
    return error.answered
      ? { ok: false, reason: 'not-openbots', message: NOT_OPENBOTS_SERVER }
      : { ok: false, reason: 'unreachable', message: error.message };
  }
}

/** Whether the profile's server is OpenBots, and for This Mac the app's own stack. */
export async function verifyServer(
  profile: ServerProfile,
  options: VerifyOptions,
): Promise<Verdict> {
  const { fetch, stack } = options;
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  if (profile.kind !== 'local' || stack == null) return verifyAddress(profile, fetch, timeoutMs);

  const portTaken = (): Refusal => ({
    ok: false,
    reason: 'port-taken',
    message: portUsedMessage(port(profile.url)),
  });
  // A failed Docker check leaves the stack unknown: then only the port says anything.
  const status = await stack.status().catch(() => null);
  const server = status?.services.find((s) => s.service === 'openbots');
  const healthy =
    server?.state === 'running' && (server.health === '' || server.health === 'healthy');
  if (!healthy) {
    // The stack's server is not up, so whatever answers on its port is another app.
    const taken =
      status == null ? await answers(fetch, profile.url, timeoutMs) : status.port?.taken === true;
    if (taken) return portTaken();
    return {
      ok: false,
      reason: 'stopped',
      message: server == null ? LOCAL_STOPPED : LOCAL_NOT_READY,
    };
  }
  const verdict = await verifyAddress(profile, fetch, timeoutMs);
  if (verdict.ok) return verdict;
  // The stack runs, yet something else answers at its address.
  if (verdict.reason === 'not-openbots') return portTaken();
  return { ok: false, reason: 'stopped', message: LOCAL_NOT_READY };
}

export interface ServerGate {
  /** Checks the profile's server now; a pass lets loads of it through for FRESH_MS. */
  verify(profile: ServerProfile): Promise<Verdict>;
  /**
   * For a top-level load of `url` in the profile's window: null lets it
   * through right after a pass, and otherwise once the server passes again.
   * A URL off the server's origin is let through: the navigation guard
   * (./navigation.ts) decides those.
   */
  admit(profile: ServerProfile, url: string): Promise<Refusal | null>;
}

export interface ServerGateOptions {
  verify: (profile: ServerProfile) => Promise<Verdict>;
  now?: () => number;
  freshMs?: number;
}

export function createServerGate(options: ServerGateOptions): ServerGate {
  const now = options.now ?? Date.now;
  const freshMs = options.freshMs ?? FRESH_MS;
  /** The last pass of each profile, at the URL it had then. */
  const passed = new Map<string, { url: string; at: number }>();
  /** One check at a time per profile: loads that ask together share it. */
  const pending = new Map<string, Promise<Verdict>>();

  function verify(profile: ServerProfile): Promise<Verdict> {
    const key = `${profile.id} ${profile.url}`;
    const running = pending.get(key);
    if (running) return running;
    passed.delete(profile.id);
    const check = options
      .verify(profile)
      .then((verdict) => {
        if (verdict.ok) passed.set(profile.id, { url: profile.url, at: now() });
        return verdict;
      })
      .finally(() => pending.delete(key));
    pending.set(key, check);
    return check;
  }

  return {
    verify,

    async admit(profile, url) {
      if (serverPath(url, profile.url) == null) return null;
      const last = passed.get(profile.id);
      if (last && last.url === profile.url && now() - last.at < freshMs) return null;
      const verdict = await verify(profile);
      return verdict.ok ? null : verdict;
    },
  };
}
