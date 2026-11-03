import { parseArgs } from 'node:util';
import qrcode from 'qrcode-terminal';
import { findInstallOwner } from '../auth.js';
import { SYSTEM_ACTOR } from '../services/audit.js';
import { createPairing, PAIRING_TTL_MS } from '../services/devices.js';
import { ensureWorkspace } from '../workspace.js';
import type { CliContext, CliResult } from './context.js';

// `openbots pair [--name <name>] [--direct <url>]... [--link]`
// (MOBILE_AND_VM_PLAN.md 4.4): makes a pairing straight in the database, with
// no HTTP and no sign-in, and prints its QR code for the phone to scan. On an
// install with no owner yet the phone that pairs becomes the owner (plan 8.3).

export const PAIR_USAGE = 'usage: openbots pair [--name <name>] [--direct <url>]... [--link]';

/** The QR code of `text` for a terminal, in qrcode-terminal's small mode. */
export function terminalQr(text: string): Promise<string> {
  return new Promise((resolve) => qrcode.generate(text, { small: true }, resolve));
}

export async function runPair(args: string[], ctx: CliContext): CliResult {
  const { db, config, write } = ctx;
  let options: { name?: string; direct?: string[]; link?: boolean };
  try {
    ({ values: options } = parseArgs({
      args,
      options: {
        name: { type: 'string' },
        direct: { type: 'string', multiple: true },
        link: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (error) {
    write(`pair: ${(error as Error).message}`);
    write(PAIR_USAGE);
    return 2;
  }
  if (config.deployment !== 'self_hosted') {
    write(
      'pair: this is the managed service; pair a phone from Settings > Devices in the web app instead',
    );
    return 1;
  }
  for (const url of options.direct ?? []) {
    if (!/^https?:\/\/[^\s]+$/.test(url) || !URL.canParse(url)) {
      write(`pair: --direct ${url} is not an http or https URL`);
      return 2;
    }
  }
  const workspace = await ensureWorkspace(db);
  const ownerId = (await findInstallOwner(db)) ?? null;
  const pairing = await createPairing({
    db,
    config,
    workspaceId: workspace.id,
    ownerId,
    name: options.name,
    direct: options.direct,
    createdBy: 'cli',
    actor: SYSTEM_ACTOR,
  });
  write(await terminalQr(pairing.link));
  write('Scan this with the OpenBots app on your phone.');
  const minutes = Math.round(PAIRING_TTL_MS / 60_000);
  write(`It works once and expires in ${minutes} minutes, at ${pairing.expiresAt}.`);
  if (pairing.qr.setup) {
    write('This server has no owner yet: the phone that pairs becomes its owner.');
  }
  if (!pairing.qr.relay && !pairing.qr.direct.length) {
    write(
      'Warning: no relay (OPENBOTS_RELAY_URL) and no https address (OPENBOTS_PUBLIC_URL or --direct), so the phone has no way to reach this server.',
    );
  }
  if (options.link) write(pairing.link);
  return 0;
}
