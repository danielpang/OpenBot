import { defaultServerConditions } from 'vite';
import { defineProject } from 'vitest/config';
import shared, { sourceConditions } from '../../vitest.shared.ts';

// Like the shared config, but resolving packages the way Node does, without
// the bundler-only `module` condition: prom-client's optional
// `@opentelemetry/api` ships a `module` build only a bundler loads.
const conditions = [...sourceConditions, ...defaultServerConditions.filter((c) => c !== 'module')];

// The relay's tests run real sockets, and the first test of a file also pays
// for the relay's start. In CI they share the runner with every other
// package's tests, so 5 seconds is not always enough.
export default defineProject({
  ...shared,
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: { ...shared.test, testTimeout: 30_000, hookTimeout: 30_000 },
});
