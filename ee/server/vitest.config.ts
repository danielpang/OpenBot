import { defaultServerConditions } from 'vite';
import { defineProject } from 'vitest/config';
import shared, { sourceConditions } from '../../vitest.shared.ts';

// As apps/server: Node's resolution without the bundler-only `module` condition.
const conditions = [...sourceConditions, ...defaultServerConditions.filter((c) => c !== 'module')];

export default defineProject({
  ...shared,
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: { ...shared.test, hookTimeout: 30_000, setupFiles: ['./src/test-setup.ts'] },
});
