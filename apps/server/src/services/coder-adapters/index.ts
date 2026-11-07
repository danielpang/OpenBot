import type { CoderAgent } from '@openbots/shared';
import { DomainError } from '../../errors.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { piAdapter } from './pi.js';
import type { CoderAdapter } from './types.js';

export * from './types.js';

/** The adapter of every agent of CODER_AGENTS; tests swap one in through it. */
export const CODER_ADAPTERS: Record<CoderAgent, CoderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  pi: piAdapter,
};

export function adapterFor(agent: CoderAgent): CoderAdapter {
  const adapter = Object.hasOwn(CODER_ADAPTERS, agent) ? CODER_ADAPTERS[agent] : undefined;
  // Only a value that skipped validation gets here.
  if (!adapter) throw new DomainError(400, 'CODER_UNSUPPORTED', `${agent} is not a coding agent`);
  return adapter;
}
