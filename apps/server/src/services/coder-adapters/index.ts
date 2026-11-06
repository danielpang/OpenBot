import type { CoderAgent } from '@openbots/shared';
import { DomainError } from '../../errors.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { piAdapter } from './pi.js';
import type { CoderAdapter } from './types.js';

export * from './types.js';

// The adapters this build knows. Phase 1 registers Claude Code; Codex and pi
// follow in Phase 3 (design doc, Build plan).
const ADAPTERS: Partial<Record<CoderAgent, CoderAdapter>> = { claude: claudeAdapter };
ADAPTERS.codex = codexAdapter;
ADAPTERS.pi = piAdapter;

export function registerCoderAdapter(adapter: CoderAdapter): void {
  ADAPTERS[adapter.agent] = adapter;
}

export function adapterFor(agent: CoderAgent): CoderAdapter {
  const adapter = ADAPTERS[agent];
  if (!adapter) {
    throw new DomainError(400, 'CODER_UNSUPPORTED', `${agent} is not available in this build yet`);
  }
  return adapter;
}

export function hasCoderAdapter(agent: CoderAgent): boolean {
  return agent in ADAPTERS;
}
