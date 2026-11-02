import { isComputerTool } from '@openbots/shared';
import type { SVGProps } from 'react';
import type { Bot } from '../bots/queries.js';

// Status (I5, K3, plan 9.4): a green dot on the title bar's Preview button
// while the Bot's current tool is a computer tool, and the computer glyph.

export function ComputerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" strokeLinecap="round" />
    </svg>
  );
}

/** Whether the Bot is using its computer right now. */
export const computerActive = (state: Bot['state']) =>
  state.state === 'working' && isComputerTool(state.currentTool);

/**
 * The green dot on the title bar's Preview button while the Bot is using its
 * computer, with the current action as its tooltip; nothing otherwise.
 */
export function ComputerActiveDot({ bot }: { bot: Bot }) {
  if (!computerActive(bot.state)) return null;
  return (
    <span
      role="img"
      aria-label="Using its computer"
      title={bot.state.currentAction ?? 'Using its computer'}
      data-active
      className="absolute top-1 right-1 size-2 rounded-full bg-emerald-500 ring-2 ring-background"
    />
  );
}
