import { findInstallOwner } from '../auth.js';
import { DomainError } from '../errors.js';
import { SYSTEM_ACTOR } from '../services/audit.js';
import { listDevices, revokeDevice } from '../services/devices.js';
import { inWorkspace } from '../db/scope.js';
import { ensureWorkspace } from '../workspace.js';
import type { CliContext, CliResult } from './context.js';

// `openbots devices [list | revoke <id>]` (MOBILE_AND_VM_PLAN.md 4.4): the
// owner's paired devices, for a VM with no browser at hand.

export const DEVICES_USAGE = 'usage: openbots devices [list | revoke <id>]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runDevices(args: string[], ctx: CliContext): CliResult {
  const { db, config, write } = ctx;
  const [command = 'list', ...rest] = args;
  if (!['list', 'revoke'].includes(command) || (command === 'list' && rest.length)) {
    write(DEVICES_USAGE);
    return 2;
  }
  if (config.deployment !== 'self_hosted') {
    write('devices: this is the managed service; manage devices in Settings > Devices instead');
    return 1;
  }
  const workspace = await ensureWorkspace(db);
  const ownerId = await findInstallOwner(db);
  const owner = ownerId ? { workspaceId: workspace.id, ownerId } : null;

  if (command === 'list') {
    const devices = owner ? await inWorkspace(workspace.id, () => listDevices(db, owner)) : [];
    if (!devices.length) {
      write('No paired devices. Pair one with `openbots pair`.');
      return 0;
    }
    for (const d of devices) {
      write(
        [d.id, d.platform, d.name, `paired ${d.createdAt}`, `seen ${d.lastSeenAt ?? 'never'}`].join(
          '  ',
        ),
      );
    }
    return 0;
  }

  const [id, ...extra] = rest;
  if (!id || extra.length) {
    write(DEVICES_USAGE);
    return 2;
  }
  if (!UUID.test(id) || !owner) {
    write(`devices: no device ${id}`);
    return 1;
  }
  try {
    await revokeDevice(ctx, owner, id, SYSTEM_ACTOR);
  } catch (error) {
    if (error instanceof DomainError && error.status === 404) {
      write(`devices: no device ${id}`);
      return 1;
    }
    throw error;
  }
  write(`Revoked ${id}: its key no longer works.`);
  return 0;
}
