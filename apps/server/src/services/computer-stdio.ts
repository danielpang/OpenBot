import type { McpStdioLaunch } from '@openbots/computer';
import { RestartSkipped, type ComputerStdioSpec } from '@openbots/mcp';
import type { AppDeps } from '../context.js';
import {
  agentFor,
  computerAvailable,
  getComputer,
  startComputer,
  touchComputer,
} from './computer.js';

// Stdio connectors in their owner's computer (OPENBOTS_STDIO_RUNNER=computer,
// the managed service's default). Each connector's server runs in the
// computer of the account that owns it, in the organization it belongs to:
// one computer per (organization, owner), its own container, firewall and
// egress rules, so no two accounts or organizations share a process or a
// filesystem. Starting the session starts the computer when it is off,
// through the same path a Bot's first computer tool takes (status events,
// audit); a restart after a crash never does, so a server whose computer was
// stopped stays down until it is next used. While the server is busy the
// computer counts as used, so the idle sweep does not stop it mid-call.
//
// When there is no computer, or it does not start, the session fails with a
// short message, which the manager stores as the connector's last error: it
// never falls back to running the server on this host.

export const NO_COMPUTER =
  'This connector runs in your computer, and this server has no computer set up.';

/** Marks the computer used at most this often while a server is busy. */
export const STDIO_TOUCH_MS = 30_000;

type Owner = { id: string; workspaceId: string };
/** The connectors service's deps; the computer needs the event bus as well. */
type Deps = Pick<AppDeps, 'db' | 'config' | 'logger'> & Partial<Pick<AppDeps, 'infra'>>;

/** The computer stdio host's channel for one session of one connector. */
export function computerStdioSpec(
  deps: Deps,
  owner: Owner,
  launch: McpStdioLaunch,
  { restart }: { restart: boolean },
): ComputerStdioSpec {
  // The computer service uses no more of AppDeps than `Deps` and the bus.
  const full = deps as AppDeps;
  let computerId: string | undefined;
  let touched = 0;
  return {
    async launch(handlers) {
      const computer = await computerFor(full, owner, restart);
      computerId = computer.id;
      touched = Date.now();
      return agentFor(full, computer).mcpStdio(launch, handlers);
    },
    onActivity() {
      if (!computerId || Date.now() - touched < STDIO_TOUCH_MS) return;
      touched = Date.now();
      touchComputer(full, computerId).catch((error: unknown) =>
        full.logger.warn({ err: error, computerId }, 'marking the computer used failed'),
      );
    },
  };
}

async function computerFor(deps: AppDeps, owner: Owner, restart: boolean) {
  if (!deps.infra || !computerAvailable(deps)) throw new Error(NO_COMPUTER);
  if (restart) {
    const computer = await getComputer(deps, owner);
    if (computer?.status !== 'running') throw new RestartSkipped('The computer is not running.');
    return computer;
  }
  try {
    return (await startComputer(deps, owner)).computer;
  } catch (error) {
    // A plain error, so the manager records it on the connector.
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
  }
}
