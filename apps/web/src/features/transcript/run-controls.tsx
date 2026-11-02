import { Button } from '@openbots/ui';
import { useState } from 'react';
import { cancelRun, type BotState } from './api.js';

// Stop (plan 5.7): shown only while the Bot is thinking or working. A blocked
// Bot shows the event row the server posted in the transcript, nothing here.

export function StopControl({ state }: { state: BotState | undefined }) {
  const [stopping, setStopping] = useState<string | null>(null);
  const runId = state?.runId;
  if (!runId || (state.state !== 'thinking' && state.state !== 'working')) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={stopping === runId}
      onClick={() => {
        setStopping(runId);
        cancelRun(runId).catch(() => setStopping(null));
      }}
    >
      Stop
    </Button>
  );
}
