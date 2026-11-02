import { applyPatch, createPatch, diffLines, parsePatch } from 'diff';

// Line diffs for text Artifacts (plan 12.1, 18.4): the `+14 −10` summary a
// version stores, which the activity label reuses, and unified-diff patches
// the Bot sends with `update_artifact` instead of the whole content.

export interface DiffSummary {
  added: number;
  removed: number;
  /** `+14 −10` (U+2212 minus), as stored in `artifact_versions.summary`. */
  summary: string;
}

/** Diffs taking longer than this count every line as changed. */
const DIFF_TIMEOUT_MS = 2_000;

export function formatDiffSummary(added: number, removed: number): string {
  return `+${added} −${removed}`;
}

/** Lines added and removed going from `before` to `after`. */
export function diffSummary(before: string, after: string): DiffSummary {
  const changes = diffLines(before, after, { timeout: DIFF_TIMEOUT_MS });
  let added = 0;
  let removed = 0;
  if (changes) {
    for (const change of changes) {
      if (change.added) added += change.count;
      else if (change.removed) removed += change.count;
    }
  } else {
    added = lineCount(after);
    removed = lineCount(before);
  }
  return { added, removed, summary: formatDiffSummary(added, removed) };
}

export function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** A patch that is not a unified diff, patches several files, or does not fit the content. */
export class PatchError extends Error {
  override name = 'PatchError';
}

/** Applies a unified diff (one file, `@@` hunks) to `source`; throws `PatchError` when it does not fit. */
export function applyUnifiedPatch(source: string, patch: string): string {
  let parsed;
  try {
    parsed = parsePatch(patch);
  } catch (error) {
    throw new PatchError(`The patch is not a valid unified diff: ${(error as Error).message}`);
  }
  if (parsed.length !== 1 || !parsed[0]!.hunks.length) {
    throw new PatchError(
      parsed.length > 1
        ? 'The patch changes more than one file; send one Artifact at a time'
        : 'The patch has no hunks; send a unified diff with @@ hunk headers',
    );
  }
  const result = applyPatch(source, parsed[0]!);
  if (result === false) {
    throw new PatchError(
      'The patch does not apply to the current version; read the Artifact again and send ' +
        'a new patch or the whole content',
    );
  }
  return result;
}

/**
 * The owner's edit of `base` replayed onto `latest`, a newer version saved
 * meanwhile (A2): the changes from `base` to `edited` as a patch, applied to
 * `latest`. Null when they overlap what changed in `latest`, so they do not fit.
 */
export function rebaseEdit(base: string, edited: string, latest: string): string | null {
  if (edited === base) return latest;
  if (latest === base) return edited;
  // One line of context, so an edit next to (not on) a line that changed still fits.
  const patch = createPatch('artifact', base, edited, '', '', { context: 1 });
  const result = applyPatch(latest, patch);
  return result === false ? null : result;
}

export interface DiffLine {
  type: 'added' | 'removed' | 'same';
  text: string;
}

/** `before` to `after` line by line, for the viewer's diff between two versions. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const changes = diffLines(before, after, { timeout: DIFF_TIMEOUT_MS });
  if (!changes) {
    return [
      ...splitLines(before).map((text) => ({ type: 'removed' as const, text })),
      ...splitLines(after).map((text) => ({ type: 'added' as const, text })),
    ];
  }
  return changes.flatMap((change) => {
    const type = change.added ? 'added' : change.removed ? 'removed' : 'same';
    return splitLines(change.value).map((text) => ({ type, text }));
  });
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}
