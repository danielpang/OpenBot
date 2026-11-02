import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { botsQuery } from '../bots/queries.js';
import { ComputerOff } from './computer-off.js';
import { useComputer } from './live.js';
import { ScreenView } from './screen-view.js';
import { Takeover } from './takeover.js';

// Preview (K3, plan 9.4): the Bot's screen, view-only, in the pinned right
// panel beside the transcript. Opening it never starts the computer (the
// server refuses to, too): while it is off the panel says so and offers Start.
// The screen shows while the computer runs and opens full screen for takeover.

export function ScreenPreview({ botId }: { botId: string }) {
  const { data, isPending } = useComputer();
  const bots = useQuery(botsQuery);
  const botName = bots.data?.items.find((bot) => bot.id === botId)?.name ?? 'The Bot';
  const [fullScreen, setFullScreen] = useState(false);
  const running = data?.computer?.status === 'running';

  if (!running) {
    if (isPending) return null;
    const status = data?.computer?.status;
    if (
      status === 'creating' ||
      status === 'updating' ||
      status === 'starting' ||
      status === 'stopping'
    ) {
      return (
        <p className="p-4 text-sm text-muted-foreground" role="status">
          {status === 'stopping'
            ? 'The computer is stopping.'
            : status === 'updating'
              ? `Updating the computer. ${botName}'s screen shows once it is up to date.`
              : `The computer is starting. ${botName}'s screen shows once it is up.`}
        </p>
      );
    }
    return (
      <div className="p-4">
        <ComputerOff text={`The computer is off. Start it to see ${botName}'s screen.`} />
      </div>
    );
  }

  return (
    <div className="p-3">
      <div className="relative aspect-video overflow-hidden rounded-md border">
        {!fullScreen && <ScreenView botId={botId} viewOnly label={`${botName}'s screen`} />}
        <button
          type="button"
          aria-label="Open full screen"
          className="absolute inset-0 cursor-zoom-in"
          onClick={() => setFullScreen(true)}
        />
      </div>
      {fullScreen && (
        <Takeover botId={botId} botName={botName} onClose={() => setFullScreen(false)} />
      )}
    </div>
  );
}
