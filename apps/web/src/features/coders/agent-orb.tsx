import { useId } from 'react';
import type { CodingSessionEntry, CodingSessionStatus } from '@openbots/shared';
import './agent-orb.css';

/** The transcript reports actions, not private reasoning. Thinking is a working indicator. */
export function sessionActivity(
  status: CodingSessionStatus,
  entries: readonly CodingSessionEntry[],
) {
  if (status === 'settled' || status === 'failed' || status === 'stopped') return null;
  if (status === 'waiting')
    return { label: 'Waiting for approval or agent availability', state: 'paused' };
  if (status === 'queued') return { label: 'Queued', state: 'paused' };
  if (status === 'starting') return { label: 'Starting agent…', state: 'shaping' };
  const last = entries.at(-1)?.event;
  const tool = last?.type === 'tool_use' ? last.name : last?.type === 'command' ? 'bash' : null;
  return {
    label: tool ? `Working · ${tool}` : 'Thinking…',
    state: !tool
      ? 'shaping'
      : /read|grep|glob|search|fetch|ls|find/i.test(tool)
        ? 'searching'
        : /edit|write|patch/i.test(tool)
          ? 'composing'
          : 'working',
  };
}

/** Bento-inspired inline orb, with the same visual vocabulary as the native app. */
export function AgentOrb({ label, state }: { label: string; state: string }) {
  const gradient = useId();
  return (
    <div role="status" className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
      <svg
        aria-hidden="true"
        className="coding-agent-orb"
        data-state={state}
        width="24"
        height="24"
        viewBox="0 0 32 32"
      >
        <defs>
          <radialGradient id={gradient} cx="35%" cy="25%" r="75%">
            <stop offset="0" stopColor="#d5f2ff" />
            <stop offset=".45" stopColor="#72acbd" />
            <stop offset="1" stopColor="#304b68" />
          </radialGradient>
        </defs>
        <circle cx="16" cy="16" r="13" fill={`url(#${gradient})`} />
        <ellipse
          cx="16"
          cy="16"
          rx="7"
          ry="12"
          transform="rotate(35 16 16)"
          fill="none"
          stroke="#e0f7ff"
          strokeOpacity=".65"
        />
        <ellipse
          cx="16"
          cy="16"
          rx="12"
          ry="5"
          transform="rotate(-25 16 16)"
          fill="none"
          stroke="#e0f7ff"
          strokeOpacity=".45"
        />
      </svg>
      <span>{label}</span>
    </div>
  );
}
