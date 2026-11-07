import type { CoderAgent } from '@openbots/shared';
import { CODER_ADAPTERS, type CoderAdapter, type CoderSignIn } from '../../coder-adapters/index.js';

// Adapter helpers for tests: the PTY sign-in of an adapter that has one, and
// a stand-in adapter swapped into the registry for one file's tests.

/** The adapter's PTY sign-in; throws for one that signs in in its terminal. */
export function ptySignIn(adapter: CoderAdapter): Extract<CoderSignIn, { kind: 'pty' }> {
  if (adapter.signIn.kind !== 'pty') throw new Error(`${adapter.agent} has no PTY sign-in`);
  return adapter.signIn;
}

/** Puts `adapter` in the registry for its agent; returns what puts the real one back. */
export function useCoderAdapter(adapter: CoderAdapter): () => void {
  const agent: CoderAgent = adapter.agent;
  const real = CODER_ADAPTERS[agent];
  CODER_ADAPTERS[agent] = adapter;
  return () => {
    CODER_ADAPTERS[agent] = real;
  };
}
