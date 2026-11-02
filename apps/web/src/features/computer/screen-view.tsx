import type RFB from '@novnc/novnc';
import { useEffect, useRef, useState } from 'react';
import { vncUrl } from './api.js';
import { useRefreshComputer } from './live.js';

// A Bot's screen through noVNC over the server's `/bots/:id/screen/vnc` proxy
// (plan 9.4). Scaled to fit, never resizing the Bot's display. View-only
// unless the owner has taken the screen over; a dropped connection retries and
// refetches the computer's state, so a computer that went off while this tab
// missed the event shows as off (the proxy never starts it).

const RETRY_MS = 2_000;

/** noVNC loads on first use, keeping it out of the main bundle. */
const loadRfb = () => import('@novnc/novnc').then((module) => module.default);

type Phase = 'connecting' | 'connected' | 'disconnected';

export function ScreenView({
  botId,
  viewOnly,
  label,
  control = false,
}: {
  botId: string;
  viewOnly: boolean;
  label: string;
  /** Takeover's view: the server hands the screen back once it closes for good. */
  control?: boolean;
}) {
  const target = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [attempt, setAttempt] = useState(0);
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  const refresh = useRefreshComputer();

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setPhase('connecting');
    void loadRfb()
      .then((Rfb) => {
        if (cancelled || !target.current) return;
        const screen = new Rfb(target.current, vncUrl(botId, control), {
          wsProtocols: ['binary'],
        });
        screen.viewOnly = viewOnlyRef.current;
        screen.scaleViewport = true;
        screen.resizeSession = false;
        screen.background = 'transparent';
        screen.addEventListener('connect', () => setPhase('connected'));
        screen.addEventListener('disconnect', () => {
          rfb.current = null;
          if (cancelled) return;
          setPhase('disconnected');
          void refresh();
          retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
        });
        rfb.current = screen;
      })
      .catch(() => !cancelled && setPhase('disconnected'));
    return () => {
      cancelled = true;
      clearTimeout(retry);
      rfb.current?.disconnect();
      rfb.current = null;
    };
  }, [botId, control, attempt, refresh]);

  useEffect(() => {
    if (!rfb.current) return;
    rfb.current.viewOnly = viewOnly;
    if (!viewOnly) rfb.current.focus({ preventScroll: true });
  }, [viewOnly, phase]);

  return (
    <div className="relative h-full w-full bg-black/90" data-screen={phase}>
      <div
        ref={target}
        role={viewOnly ? 'img' : 'application'}
        aria-label={label}
        className="h-full w-full [&_canvas]:mx-auto"
      />
      {phase !== 'connected' && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-white/70">
          {phase === 'connecting' ? 'Connecting to the screen…' : 'The screen is not reachable.'}
        </p>
      )}
    </div>
  );
}
