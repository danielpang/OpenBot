import { createAgentClient } from './agent-client.js';
import { waitForAgent } from './docker.js';
import type { ComputerProvider, MachineStatus } from './types.js';

// The remote provider (plan 9.2): a control agent already running on some
// machine (a VM, a spare box), reached at its URL with its token. OpenBots
// cannot create, start or stop that machine; `start` only waits for the agent
// and `stop` leaves it running.

export interface RemoteProviderOptions {
  url: string;
  token: string;
  readyTimeoutMs?: number;
}

export function createRemoteProvider({
  url,
  token,
  readyTimeoutMs = 10_000,
}: RemoteProviderOptions): ComputerProvider {
  const provider: ComputerProvider = {
    name: 'remote',
    create: async (spec) => ({
      provider: 'remote',
      containerId: null,
      agentUrl: url,
      agentToken: token,
      volumeName: spec.volumeName,
    }),
    start: (ref) => waitForAgent(provider.agent(ref), readyTimeoutMs, 500),
    stop: async () => {},
    destroy: async () => {},
    async status(ref): Promise<MachineStatus> {
      try {
        return (await provider.agent(ref).health()).ok ? 'running' : 'stopped';
      } catch {
        return 'stopped';
      }
    },
    // The token is the configured one, whatever an older row holds.
    agent: (ref) => createAgentClient({ url: ref.agentUrl, token }),
  };
  return provider;
}
