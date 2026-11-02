import { createHash } from 'node:crypto';
import type { ProviderKind, ProviderProtocol } from '@openbots/shared';

// Tool-name normalization (plan section 19, "provider differences in tool
// naming"). Tools keep their OpenBots names (`github__create_issue`,
// `edit_file`); the map rewrites them to what a provider accepts on the way
// out and back on the way in, so the agent never sees a provider's spelling.

export interface ToolNameRules {
  maxLength: number;
  /** Characters a name may contain. */
  allowed: RegExp;
  /** Gemini requires a letter or underscore first. */
  mustStartWithLetter: boolean;
}

const OPENAI_RULES: ToolNameRules = {
  maxLength: 64,
  allowed: /[a-zA-Z0-9_-]/,
  mustStartWithLetter: false,
};

const ANTHROPIC_RULES: ToolNameRules = {
  maxLength: 64,
  allowed: /[a-zA-Z0-9_-]/,
  mustStartWithLetter: false,
};

const GOOGLE_RULES: ToolNameRules = {
  maxLength: 64,
  allowed: /[a-zA-Z0-9_.:-]/,
  mustStartWithLetter: true,
};

export function toolNameRules(provider: {
  kind: ProviderKind;
  protocol: ProviderProtocol;
}): ToolNameRules {
  if (provider.protocol === 'anthropic_compatible') return ANTHROPIC_RULES;
  if (provider.protocol === 'openai_compatible') return OPENAI_RULES;
  switch (provider.kind) {
    case 'anthropic':
      return ANTHROPIC_RULES;
    case 'google':
      return GOOGLE_RULES;
    default:
      return OPENAI_RULES;
  }
}

export interface ToolNameMap {
  /** OpenBots name to the name sent to the provider. */
  toProvider(name: string): string;
  /** A provider's tool-call name back to the OpenBots name; unknown names pass through. */
  fromProvider(name: string): string;
  /** Every renamed tool, OpenBots name to provider name. */
  renamed: ReadonlyMap<string, string>;
}

function sanitize(name: string, rules: ToolNameRules): string {
  let out = [...name].map((ch) => (rules.allowed.test(ch) ? ch : '_')).join('');
  if (rules.mustStartWithLetter && !/^[a-zA-Z_]/.test(out)) out = `_${out}`;
  return out || '_';
}

function shortHash(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8);
}

/**
 * Builds a reversible map for one request's tool set. Names that already fit
 * are unchanged; others are sanitized and, when too long or colliding, cut
 * and suffixed with a hash of the original so the result is stable.
 */
export function createToolNameMap(names: Iterable<string>, rules: ToolNameRules): ToolNameMap {
  const all = [...new Set(names)];
  const out = new Map<string, string>();
  const back = new Map<string, string>();
  // Names that already fit claim themselves first so they never get renamed.
  const fits = (n: string) => n.length <= rules.maxLength && sanitize(n, rules) === n;
  for (const name of all.filter(fits)) {
    out.set(name, name);
    back.set(name, name);
  }
  for (const name of all.filter((n) => !fits(n))) {
    let candidate = sanitize(name, rules);
    if (candidate.length > rules.maxLength || back.has(candidate)) {
      const suffix = `_${shortHash(name)}`;
      candidate = candidate.slice(0, rules.maxLength - suffix.length) + suffix;
    }
    for (let i = 2; back.has(candidate); i += 1) {
      const suffix = `_${shortHash(`${name}#${i}`)}`;
      candidate = candidate.slice(0, rules.maxLength - suffix.length) + suffix;
    }
    out.set(name, candidate);
    back.set(candidate, name);
  }
  const renamed = new Map([...out].filter(([from, to]) => from !== to));
  return {
    toProvider: (name) => out.get(name) ?? sanitize(name, rules).slice(0, rules.maxLength),
    fromProvider: (name) => back.get(name) ?? name,
    renamed,
  };
}
