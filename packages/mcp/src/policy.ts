import { loadCatalog } from './catalog.js';
import type { TransportConfig } from './types.js';

// The admin block list (T3) and per-Bot tool permissions (T1), as pure
// functions over rows the server loads.
//
// A block rule is a URL or command pattern. Patterns are globs (`*` matches
// anything, case-insensitive, anchored) tested against an HTTP connector's URL
// and its host, and against a stdio connector's command line, so
// `https://*.slack.com/*`, `*.slack.com` and `*server-postgres*` all work.
// Built-in connectors have no URL or command, so no pattern blocks them.

export interface BlockRule {
  urlPattern: string;
}

export interface BlockTarget {
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
  const subs = subjects(target.config);
  if (!subs.length) return null;
  for (const rule of rules) {
    const re = globToRegExp(rule.urlPattern);
    if (subs.some((s) => re.test(s))) return rule;
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
