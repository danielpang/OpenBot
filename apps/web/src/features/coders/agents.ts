import type { CoderAgent } from '@openbots/shared';
import type { CoderAccount } from './api.js';

// The one thing about a coding agent the server's account view does not say:
// a note the Settings card shows under its name. How it signs in and whether
// it takes Check come from the view (`signIn`, `checkAvailable`).

const NOTES: Partial<Record<CoderAgent, string>> = {
  pi: 'pi signs in from its own terminal: run pi, type /login and pick a provider. A ChatGPT plan, a Claude plan, GitHub Copilot and the other providers pi lists all work; Anthropic bills a Claude plan used through pi as extra usage, not against the plan. You can also use an API key from Settings > Models.',
};

/** A note the card shows under the agent's name, when there is one. */
export const agentNote = (account: Pick<CoderAccount, 'agent'>): string | undefined =>
  NOTES[account.agent];
