import type { CodingSessionHost } from '@openbots/widgets/react';
import { codingSessionLog, codingSessionTerminal, decideApproval, terminalSearch } from './api.js';

// What a `coding_session` widget asks of the web app: approvals go through
// the approvals route, Open terminal asks the server where to attach and
// opens the Computer page's terminal there, View log reads the session's log.

/** The Computer page's URL with its terminal attached as the server said. */
export function computerTerminalHref(attach: Parameters<typeof terminalSearch>[0]): string {
  return `/computer?${new URLSearchParams(terminalSearch(attach)).toString()}`;
}

export function codingSessionHost(navigate: (href: string) => void): CodingSessionHost {
  return {
    decideApproval,
    async openTerminal(sessionId) {
      const attach = await codingSessionTerminal(sessionId);
      navigate(computerTerminalHref(attach));
    },
    loadLog: codingSessionLog,
  };
}
