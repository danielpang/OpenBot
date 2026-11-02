import { loadCatalog } from './catalog.js';
import type { TransportConfig } from './types.js';

// The admin block list (T3) and per-Bot tool permissions (T1), as pure
// functions over rows the server loads.
//
// A block rule names a catalog entry or a URL pattern. Patterns are globs
// (`*` matches anything, case-insensitive, anchored) tested against an HTTP
// connector's URL and its host, and against a stdio connector's command line,
// so `https://*.slack.com/*`, `*.slack.com` and `*server-postgres*` all work.
// Connectors are matched to catalog entries by URL or package even when they
// were typed in or imported, so a catalog block cannot be dodged by pasting
// the same server as JSON.
//
// The admin allow list (U3) sits in the same rules: a rule with `allow: true`
// names a catalog entry that may be used. While there is at least one, every
// connector that is not one of those entries (custom ones included) counts as
// blocked; the block list still applies on top.

export interface BlockRule {
  catalogId: string | null;
  urlPattern: string | null;
  /** An allow-list entry rather than a block (U3). */
  allow?: boolean;
}

/** What `blockedBy` answers when a non-empty allow list leaves the target out. */
export const NOT_ON_ALLOW_LIST: BlockRule = { catalogId: null, urlPattern: null, allow: false };

export interface BlockTarget {
  catalogId?: string | null;
  config?: TransportConfig | null;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

const normalizeUrl = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

/** The npm or PyPI package a stdio command line runs, without its version. */
function packageOf(args: string[]): string[] {
  return args
    .filter((a) => !a.startsWith('-'))
    .map((a) => a.replace(/(?<=.)@[^/@]+$/, '').replace(/[=<>~]=.*$/, ''));
}

/** The catalog entry a typed-in or imported connector corresponds to, if any. */
export function matchCatalog(config: TransportConfig): string | null {
  for (const entry of loadCatalog().entries) {
    if (config.transport === 'http' && entry.http) {
      if (normalizeUrl(entry.http.url) === normalizeUrl(config.url)) return entry.id;
    }
    if (config.transport === 'stdio' && entry.stdio) {
      const wanted = packageOf(entry.stdio.args).filter((a) => !a.includes('{{'));
      const have = new Set(packageOf(config.args));
      if (wanted.length && wanted.every((p) => have.has(p))) return entry.id;
    }
  }
  return null;
}

function subjects(config: TransportConfig | null | undefined): string[] {
  if (!config) return [];
  if (config.transport === 'http') {
    try {
      return [config.url, new URL(config.url).host];
    } catch {
      return [config.url];
    }
  }
  if (config.transport === 'stdio') return [[config.command, ...config.args].join(' ')];
  return [];
}

/** The first rule that blocks the target, or null. */
export function blockedBy(target: BlockTarget, rules: BlockRule[]): BlockRule | null {
  const catalogIds = new Set<string>();
  if (target.catalogId) catalogIds.add(target.catalogId);
  if (target.config) {
    const matched = matchCatalog(target.config);
    if (matched) catalogIds.add(matched);
  }
  const allowed = rules.filter((r) => r.allow).map((r) => r.catalogId);
  if (allowed.length && !allowed.some((id) => id && catalogIds.has(id))) return NOT_ON_ALLOW_LIST;
  const subs = subjects(target.config);
  for (const rule of rules) {
    if (rule.allow) continue;
    if (rule.catalogId && catalogIds.has(rule.catalogId)) return rule;
    if (rule.urlPattern) {
      const re = globToRegExp(rule.urlPattern);
      if (subs.some((s) => re.test(s))) return rule;
    }
  }
  return null;
}

export interface ToolRule {
  /** Null allows every tool. */
  toolAllowlist: string[] | null;
  toolDenylist: string[];
}

/** Whether a Bot may use a tool: no row means every tool (T1); the denylist wins over the allowlist. */
export function toolPermitted(toolName: string, rule: ToolRule | undefined): boolean {
  if (!rule) return true;
  if (rule.toolDenylist.includes(toolName)) return false;
  return rule.toolAllowlist === null || rule.toolAllowlist.includes(toolName);
}
