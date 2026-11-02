import { createDockerProvider, type ComputerProvider } from '@openbots/computer';
import {
  mockDocker,
  startFakeAgent,
  type FakeAgent,
  type MockDocker,
} from '@openbots/computer/testing';
import type { AppDeps } from './context.js';
import { setComputerProvider } from './services/computer.js';

// A computer for server tests: the docker provider over a mocked dockerode,
// whose containers' agent is an in-process fake (no daemon). The fake accepts
// the token the server generated for the container, so the
// sealed-token round trip is exercised.

export interface TestComputer {
  agent: FakeAgent;
  docker: MockDocker;
  provider: ComputerProvider;
  close(): Promise<void>;
}

export async function useTestComputer(deps: AppDeps): Promise<TestComputer> {
  const agent = await startFakeAgent({ token: 'not-yet-created' });
  const docker = mockDocker();
  const inner = createDockerProvider({ docker, agentUrl: () => agent.url, pollMs: 5 });
  const provider: ComputerProvider = {
    ...inner,
    async create(spec) {
      const ref = await inner.create(spec);
      agent.token = spec.agentToken;
      return ref;
    },
  };
  setComputerProvider(deps, provider);
  return { agent, docker, provider, close: () => agent.close() };
}
