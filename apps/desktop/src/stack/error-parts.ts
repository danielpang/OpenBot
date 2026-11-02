// How a page reads an error from a stack call (plan 14.4). Kept apart from
// ./bridge.ts, which imports the manager, so the app's pages can import it
// without any Node module.

/**
 * A failed start because another OpenBots stack on this Mac holds the
 * sandbox network: a source checkout's stack and the app's on the same
 * network name, or on overlapping subnets. The page offers to move the app's
 * stack to a network of its own (StackManager.useOwnNetwork).
 */
export const NETWORK_CLASH =
  'Another OpenBots stack on this Mac is using the same network. Stop it, or let the app pick its own network.';

/** The server's fixed address on the sandbox network is another stack's. */
const ADDRESS_IN_USE = /failed to set up container networking: address already in use/i;
/** Compose found the sandbox network by name, made by another project. */
const NOT_CREATED_FOR_PROJECT = /a network with name \S+ exists but was not created for project/i;
/** The sandbox subnet overlaps another network's. */
const POOL_OVERLAPS = /pool overlaps with other one on this address space/i;

/**
 * Whether `compose up` output says the stack's sandbox network clashes with
 * another stack's. `stronglyOnly` leaves out Compose's warning, which shows
 * on a start that failed for another reason too.
 */
export function isNetworkClash(output: string, { stronglyOnly = false } = {}): boolean {
  if (ADDRESS_IN_USE.test(output) || POOL_OVERLAPS.test(output)) return true;
  return !stronglyOnly && NOT_CREATED_FOR_PROJECT.test(output);
}

/** What kind of failure an error is, when the page has an action for it. */
export type StackErrorKind = 'network-clash';

/**
 * An error from a stack call as a page shows it: the sentence, the output
 * after it (a StackError's detail) for "Show details", and its kind when the
 * page offers a way out. Electron puts "Error invoking remote method '…':
 * Error: " before a main process error.
 */
export function errorParts(error: unknown): {
  message: string;
  detail: string | null;
  kind: StackErrorKind | null;
} {
  const text = (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/,
    '',
  );
  const newline = text.indexOf('\n');
  const message = newline < 0 ? text : text.slice(0, newline);
  const detail = newline < 0 ? null : text.slice(newline + 1).trim() || null;
  return { message, detail, kind: message === NETWORK_CLASH ? 'network-clash' : null };
}
