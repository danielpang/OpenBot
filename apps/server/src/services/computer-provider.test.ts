import type * as Computer from '@openbots/computer';
import type { DockerProviderOptions } from '@openbots/computer';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../context.js';
import { loadConfig } from '../config.js';
import { generateMasterKey } from '../secrets.js';
import { computerProvider } from './computer.js';

// Which provider the server builds from its configuration: the docker one
// gets the sandbox network compose made for this stack (K6).

const made = vi.hoisted(() => [] as DockerProviderOptions[]);
vi.mock('@openbots/computer', async (original) => {
  const actual = await original<typeof Computer>();
  return {
    ...actual,
    createDockerProvider: (options: DockerProviderOptions) => {
      made.push(options);
      return actual.createDockerProvider(options);
    },
  };
});

const depsWith = (env: Record<string, string>) =>
  ({
    config: loadConfig({
      OPENBOTS_MASTER_KEY: generateMasterKey(),
      DATABASE_URL: 'postgres://openbots:openbots@localhost:5432/openbots',
      DOCKER_HOST: 'tcp://docker-guard:2375',
      ...env,
    }),
    logger: { warn: () => {} },
  }) as unknown as AppDeps;

describe('computerProvider', () => {
  it('gives the docker provider the configured sandbox network', () => {
    made.length = 0;
    computerProvider(
      depsWith({
        OPENBOTS_SANDBOX_NETWORK: 'openbots-app-sandbox-254',
        OPENBOTS_SANDBOX_BRIDGE: 'openbots-a-254',
      }),
    );
    expect(made).toEqual([
      {
        dockerHost: 'tcp://docker-guard:2375',
        network: { name: 'openbots-app-sandbox-254', bridge: 'openbots-a-254' },
      },
    ]);
  });

  it('gives it openbots-sbx when nothing is configured', () => {
    made.length = 0;
    computerProvider(depsWith({}));
    expect(made[0]!.network).toEqual({ name: 'openbots-sbx', bridge: 'openbots-sbx' });
  });
});
