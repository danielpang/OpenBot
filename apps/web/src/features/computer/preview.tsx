import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { botsQuery } from '../bots/queries.js';
import { ComputerOff } from './computer-off.js';
import { useComputer, useStartComputer } from './live.js';
import { ScreenView } from './screen-view.js';
import { Takeover } from './takeover.js';

// Computer (K3, plan 9.4): the Bot's screen, view-only, in the pinned right
// panel beside the transcript. Opening the panel starts a computer that is
// off, once, and only while the tab is in view, so a stale tab in the
// background never boots the sandbox. A computer that goes off while the
// panel is open stays off, with Start (it was stopped on purpose, or for
// being idle). The screen shows while the computer runs and opens full
// screen for takeover.

export function ScreenPreview({ botId }: { botId: string }) {
  const { data, isPending } = useComputer();
  const bots = useQuery(botsQuery);
  const botName = bots.data?.items.find((bot) => bot.id === botId)?.name ?? 'The Bot';
  const [fullScreen, setFullScreen] = useState(false);
  const status = data?.computer?.status;
  const running = status === 'running';
  const busy =
    status === 'creating' ||
    status === 'updating' ||
    status === 'starting' ||
    status === 'stopping';
  const off = !isPending && data?.available !== false && !running && !busy;
  const start = useStartComputer();
  const startOnce = useRef<'waiting' | 'done'>('waiting');

  useEffect(() => {
    // Only the panel's first look: off later means someone stopped it.
    if (startOnce.current === 'done' || isPending) return;
    if (!off) {
      startOnce.current = 'done';
      return;
    }
    const startNow = () => {
      if (document.visibilityState !== 'visible' || startOnce.current === 'done') return;
      startOnce.current = 'done';
      start.mutate();
    };
    startNow();
    document.addEventListener('visibilitychange', startNow);
    return () => document.removeEventListener('visibilitychange', startNow);
  }, [off, isPending, start]);

  if (!running) {
    if (isPending) return null;
    if (start.isPending) {
      return (
        <p className="p-4 text-sm text-muted-foreground" role="status">
          {`The computer is starting. ${botName}'s screen shows once it is up.`}
        </p>
      );
    }
    if (busy) {
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
