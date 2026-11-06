import {
  CODER_AGENT_LABELS,
  coderProviderFits,
  type CoderAgent,
  type ProviderKind,
} from '@openbots/shared';
import { DomainError } from '../errors.js';
import type { schema } from '../db/client.js';
import type { ProviderRow } from './providers.js';

// An `api_key` account's provider key on its way to the CLI
// (docs/TECHNICAL_PLAN.md 22.13, "Provider keys"): which variables carry it,
// how the session is billed, and the mask it reads as wherever the session's
// output is kept or shown.

type AccountRow = typeof schema.coderAccounts.$inferSelect;

/** What a provider key reads as wherever the session's output is kept or shown. */
export const KEY_MASK = '[key]';

/** `text` with every copy of `key` masked; the text as it is without a key. */
export function maskKey(text: string, key: string | null): string {
  return key && text.includes(key) ? text.split(key).join(KEY_MASK) : text;
}

/** How a session's tokens are billed, from its account's `auth_kind`. */
export function accountBilling(
  account: Pick<AccountRow, 'authKind'> | null | undefined,
): 'subscription' | 'api' | 'unknown' {
  if (account?.authKind === 'subscription') return 'subscription';
  if (account?.authKind === 'api_key') return 'api';
  return 'unknown';
}

/** The provider fields the launch env is made from; `apiKey` is the opened secret. */
export type CoderProvider = Pick<ProviderRow, 'kind' | 'protocol' | 'name'> & {
  baseUrl: string | null;
  apiKey: string | null;
};

const notUsable = (label: string, provider: Pick<CoderProvider, 'name'>, why: string) =>
  new DomainError(
    400,
    'CODER_PROVIDER_UNSUPPORTED',
    `${label} cannot use the ${provider.name} key: ${why}. Pick another provider under Settings > Coding agents, or sign in with a plan.`,
  );

/** pi's variable per native provider kind (CODER_PROVIDER_KINDS.pi lists the same kinds). */
const PI_KEY_VARIABLES: Partial<Record<ProviderKind, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
};

/** Why a provider that does not fit (`coderProviderFits`) is refused, in the CLI's terms. */
function misfit(agent: CoderAgent, provider: CoderProvider): string {
  switch (agent) {
    case 'claude':
      return 'Claude Code takes an Anthropic key only';
    case 'codex':
      return 'Codex takes an OpenAI key only';
    case 'pi':
      return provider.protocol !== 'native'
        ? 'pi does not take a custom endpoint from the environment'
        : 'pi has no variable for this provider';
  }
}

/**
 * The variables that hand an `api_key` account's provider key to the CLI,
 * in the vendor's names: Claude Code reads ANTHROPIC_API_KEY (and
 * ANTHROPIC_BASE_URL), Codex OPENAI_API_KEY or CODEX_API_KEY (and
 * OPENAI_BASE_URL), pi one variable per provider (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY) and no base URL, since pi
 * takes a custom endpoint only from its own models.json. Which providers fit
 * is CODER_PROVIDER_KINDS, as for the Settings picker; anything else is
 * refused with the reason. The values go only into that session's process;
 * never log them.
 */
export function coderProviderEnv(
  agent: CoderAgent,
  provider: CoderProvider,
): Record<string, string> {
  const label = CODER_AGENT_LABELS[agent];
  const key = provider.apiKey?.trim();
  if (!key) throw notUsable(label, provider, 'the provider has no API key');
  if (!coderProviderFits(agent, provider)) {
    throw notUsable(label, provider, misfit(agent, provider));
  }
  const baseUrl = provider.baseUrl?.trim() || null;
  switch (agent) {
    case 'claude':
      return { ANTHROPIC_API_KEY: key, ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}) };
    case 'codex':
      return {
        OPENAI_API_KEY: key,
        CODEX_API_KEY: key,
        ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
      };
    case 'pi': {
      const name = PI_KEY_VARIABLES[provider.kind];
      if (!name) throw notUsable(label, provider, misfit(agent, provider));
      return { [name]: key };
    }
  }
}
