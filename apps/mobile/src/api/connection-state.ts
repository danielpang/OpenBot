import { createContext } from 'react';

/** Connection errors are owned by the provider's single offline notice. */
export const ConnectionErrorsContext = createContext(false);

export class OfflineError extends Error {
  constructor() {
    super('You’re offline. Reconnect to refresh this conversation.');
    this.name = 'OfflineError';
  }
}

export function isConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    error instanceof OfflineError ||
    /offline|network request failed|failed to fetch|fetch failed|disconnected|connection (?:closed|lost|failed)|timed? ?out/i.test(
      message,
    )
  );
}

export const RECONNECT_NOTICE_AFTER = 3;
