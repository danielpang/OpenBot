import { Button } from '@openbots/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { botsQuery } from '../bots/queries.js';
import { computerQuery, screenOf, setScreenControl, type ComputerState } from './api.js';
import { useComputer } from './live.js';
import { ScreenView } from './screen-view.js';

// Takeover (K3, plan 9.4): the Bot's screen full screen with exactly two
// controls. "Take control" makes the view interactive and the Bot's screen
// actions wait; "Hand back" returns the screen and leaves full screen. Who has
// the screen follows `screen.control`, so a hand back from another tab shows.
// Opened from a sign-in request (K8) it takes control at once, on the
// sign-in page.

export function Takeover({
  botId,
  botName,
  onClose,
  takeOnOpen,
}: {
  botId: string;
  botName: string;
  onClose(): void;
  /** Take control as soon as it opens, the browser on `url` when given. */
  takeOnOpen?: { url?: string };
}) {
  const { data } = useComputer();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inControl = !!screenOf(data, botId)?.controlledByUserId;
  const held = useRef(false);
  held.current = inControl;

  const control = async (action: 'take' | 'release', url?: string) => {
    setPending(true);
    setError(null);
    try {
      const screen = await setScreenControl(botId, action, url);
      queryClient.setQueryData(computerQuery.queryKey, (state: ComputerState | undefined) =>
        state?.computer
          ? {
              ...state,
              computer: {
                ...state.computer,
                screens: [...state.computer.screens.filter((s) => s.id !== screen.id), screen],
              },
            }
          : state,
      );
      held.current = action === 'take';
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setPending(false);
    }
  };

  const handBack = async () => {
    if (!held.current || (await control('release'))) onClose();
  };

  const opened = useRef(false);
  useEffect(() => {
    if (!takeOnOpen || opened.current) return;
    opened.current = true;
    void control('take', takeOnOpen.url);
    // Once per opening, whatever the later renders.
  }, []);

  // Escape leaves while the view is only watching; in control, keys go to the screen.
  useEffect(() => {
    if (inControl) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inControl, onClose]);

  // Leaving full screen any other way still hands the screen back.
  useEffect(
    () => () => {
      if (held.current) void setScreenControl(botId, 'release').catch(() => {});
    },
    [botId],
  );

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${botName}'s screen`}
      className="fixed inset-0 z-50 flex flex-col bg-black"
    >
      <div className="min-h-0 flex-1">
        <ScreenView
          botId={botId}
          control
          viewOnly={!inControl}
          label={`${botName}'s screen${inControl ? ', you have control' : ''}`}
        />
      </div>
      <footer className="flex items-center justify-center gap-3 bg-background px-4 py-3">
        <p className="mr-auto text-sm text-muted-foreground" role="status">
          {error ??
            (inControl
              ? `You have the screen. ${botName} waits until you hand it back.`
              : `${botName} has the screen.`)}
        </p>
        <Button disabled={pending || inControl} onClick={() => void control('take')}>
          Take control
        </Button>
        <Button variant="outline" disabled={pending} onClick={() => void handBack()}>
          Hand back
        </Button>
      </footer>
    </div>,
    document.body,
  );
}

/** Takeover for a sign-in request (K8): the named Bot's screen, taken at once on `url`. */
export function SignInTakeover({
  botId,
  url,
  onClose,
}: {
  botId: string;
  url?: string;
  onClose(): void;
}) {
  const bots = useQuery(botsQuery);
  const botName = bots.data?.items.find((bot) => bot.id === botId)?.name ?? 'The Bot';
  return (
    <Takeover botId={botId} botName={botName} onClose={onClose} takeOnOpen={url ? { url } : {}} />
  );
}
