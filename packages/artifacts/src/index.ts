import { packageName } from '@openbots/shared';

// Artifacts (plan 12.1, 18.4), shared by the server and the viewer: line
// diffs and their `+14 −10` summaries, unified-diff patches, and mime types.
// Storage and versions live in the server (`apps/server/src/services/
// artifacts.ts`) on the files store; the web viewer shows `lineDiff`.

export const PACKAGE_NAME = packageName('artifacts');

export * from './diff.js';
export * from './mime.js';
