import { defaultServerConditions } from 'vite';
import { defineProject } from 'vitest/config';
import shared, { sourceConditions } from '../../vitest.shared.ts';

// Like the shared config, but resolving packages the way Node does, without
// the bundler-only `module` condition: some server dependencies
// (OpenTelemetry, via better-auth) ship a `module` build only a bundler loads.
const conditions = [...sourceConditions, ...defaultServerConditions.filter((c) => c !== 'module')];

export default defineProject({
  ...shared,
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  // Most suites build a test app (PGlite and its migrations) in beforeAll,
  // which outlasts the default 10s when the whole turbo run shares the machine.
  test: { ...shared.test, hookTimeout: 30_000, setupFiles: ['./src/test-setup.ts'] },
});
