import { CODER_FEED_LINE_MAX, type CoderEvent } from '@openbots/shared';
import { IGNORED_SESSION_ID, type CoderSessionSpec } from './types.js';

// What every adapter reads its CLI's output with, and the parts of a launch
// they share: the preamble before the owner's prompt and the git identity.

export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** A token count: a finite positive number, rounded; anything else is 0. */
export const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/** Text as one feed line: whitespace collapsed, cut at `max` with an ellipsis. */
export const oneLine = (text: string, max = CODER_FEED_LINE_MAX) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A feed line saying a session id was dropped (`isVendorSessionId`). */
export const ignoredId = (): CoderEvent => ({ type: 'text', text: IGNORED_SESSION_ID });

/** CSI and OSC escapes (OSC 8 links among them), other escapes, and carriage returns. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g;

/** Terminal output as plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** What every preamble says before the owner's prompt, and what an adapter adds to it. */
export interface PreambleOptions {
  /** Lines after the test line, before the summary line: what this agent's sandbox means. */
  notes?: string[];
  /** The plan mode line. */
  plan?: string;
}

const PLAN_LINE = 'This session only plans: do not edit files. Read the code and write a plan.';

export function preamble(spec: CoderSessionSpec, options: PreambleOptions = {}): string {
  const lines = [
    `You are working for OpenBots in the git worktree ${spec.worktreePath}, on the branch ${spec.branch}, made from ${spec.base} of ${spec.repoFullName}.`,
    'Commit as you go, with clear messages.',
    'Do not push: OpenBots pushes the branch after the owner approves.',
    "Run the repository's tests when it has them.",
    ...(options.notes ?? []),
    'Finish with a short summary of what changed and what the owner should verify.',
  ];
  if (spec.coAuthor) {
    lines.push(
      `End every commit message with this trailer line: Co-Authored-By: ${spec.coAuthor.name} <${spec.coAuthor.email}>`,
    );
  }
  if (spec.mode === 'plan') lines.push(options.plan ?? PLAN_LINE);
  return lines.join(' ');
}

/** The Bot as git author and committer of the session's commits (GH8), in git's variables. */
export function gitIdentityEnv(spec: CoderSessionSpec): Record<string, string> {
  if (!spec.gitIdentity) return {};
  const { name, email } = spec.gitIdentity;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * When a rate limit message says the limit resets, as milliseconds from
 * `now`: "try again in 20s" or "in 1m30s", "retry after 30 seconds", a
 * `Retry-After: 30` header, an ISO time after "reset", or Claude Code's
 * "usage limit reached|<epoch seconds>". Null when it says none.
 */
export function rateLimitResetMs(text: string, now = Date.now()): number | null {
  const epoch = /\|(\d{10})\b/.exec(text)?.[1];
  if (epoch) return Math.max(0, Number(epoch) * 1000 - now);
  const iso = /reset\w*(?: at)?\s+(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d)?)/i.exec(text)?.[1];
  if (iso && !Number.isNaN(Date.parse(iso))) return Math.max(0, Date.parse(iso) - now);
  const header = /retry-after:\s*(\d+)/i.exec(text)?.[1];
  if (header) return Number(header) * 1000;
  const span =
    /(?:try again|retry)(?: after| in)?\s+((?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)\s*)+)/i.exec(
      text,
    )?.[1];
  if (!span) return null;
  let total = 0;
  for (const part of span.matchAll(
    /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)/gi,
  )) {
    const unit = part[2]!.toLowerCase();
    const key = unit.startsWith('ms') || unit.startsWith('milli') ? 'ms' : unit[0]!;
    total += Number(part[1]) * (UNIT_MS[key] ?? 1_000);
  }
  return Math.round(total);
}
