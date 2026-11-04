import { ensureInstanceKey } from '../services/instance-key.js';
import type { CliContext, CliResult } from './context.js';

// `openbots relay` (MOBILE_AND_VM_PLAN.md 4.4): this server's host id, the
// relay it uses, and whether the relay sees it linked (RELAY_PROTOCOL.md 3.5).

/** The relay's https (or http) base for its presence route, from its wss (or ws) URL. */
export function relayHttpBase(relayUrl: string): string {
  return relayUrl.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');
}

export async function runRelay(args: string[], ctx: CliContext): CliResult {
  const { db, config, write } = ctx;
  if (args.length) {
    write('usage: openbots relay');
    return 2;
  }
  const { hostId } = await ensureInstanceKey({ db, config });
  write(`host id: ${hostId}`);
  if (!config.relayUrl) {
    write('relay off (OPENBOTS_RELAY_URL is not set)');
    return 0;
  }
  write(`relay: ${config.relayUrl}`);
  const url = `${relayHttpBase(config.relayUrl)}/v1/hosts/${hostId}`;
  try {
    const res = await (ctx.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      write(`status: unknown (the relay answered ${res.status})`);
      return 1;
    }
    const { linked } = (await res.json()) as { linked?: unknown };
    write(
      linked === true
        ? 'status: linked'
        : 'status: not linked (the server dials the relay once a phone is paired or a pairing is open)',
    );
    return 0;
  } catch (error) {
    write(`status: unknown (the relay could not be reached: ${(error as Error).message})`);
    return 1;
  }
}
