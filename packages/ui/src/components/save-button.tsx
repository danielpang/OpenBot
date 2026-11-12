import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import type { VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils.js';
import { Button, type buttonVariants } from './button.js';

export type SaveState = 'idle' | 'saving' | 'saved';

/** How long the check stays on a form that stays open. */
export const SAVED_SHOWN_MS = 1600;
/** How long a form that closes once saved waits, so the check is seen first. */
export const SAVED_CLOSE_MS = 700;

/** The parts of a TanStack Query mutation that drive a SaveButton. */
interface SaveLike {
  isPending: boolean;
  isSuccess: boolean;
  submittedAt: number;
}

/**
 * The SaveButton's state from a mutation: saving while pending, then saved for
 * a moment after each success. `afterCheck` runs a close (a form unmounting,
 * an editor going back to view) once the check has shown.
 */
export function useSaveState(mutation: SaveLike) {
  const { isPending, isSuccess, submittedAt } = mutation;
  const [expired, setExpired] = useState<number | null>(null);
  useEffect(() => {
    if (!isSuccess) return;
    const timer = setTimeout(() => setExpired(submittedAt), SAVED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [isSuccess, submittedAt]);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const afterCheck = useCallback((close: () => void) => {
    timers.current.push(setTimeout(close, SAVED_CLOSE_MS));
  }, []);

  const state: SaveState = isPending
    ? 'saving'
    : isSuccess && expired !== submittedAt
      ? 'saved'
      : 'idle';
  return { state, afterCheck };
}

/**
 * A save button that confirms in place: a spinner while saving, then green
 * with a drawn check and "Saved". It keeps the width of its widest label, so
 * nothing beside it moves.
 */
export function SaveButton({
  state,
  savedLabel = 'Saved',
  children,
  className,
  disabled,
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { state: SaveState; savedLabel?: string }) {
  const layer = (shown: boolean) =>
    cn(
      'col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5',
      !shown && 'invisible',
    );
  return (
    <>
      <Button
        {...props}
        data-save-state={state}
        aria-busy={state === 'saving' || undefined}
        disabled={disabled || state !== 'idle'}
        className={cn(
          state !== 'idle' && 'disabled:opacity-100',
          state === 'saved' && 'border-transparent bg-green-700 text-white hover:bg-green-700',
          state === 'saved' && 'motion-safe:transition-colors motion-safe:duration-200',
          className,
        )}
      >
        <span className="grid">
          <span className={layer(state === 'idle')} aria-hidden={state !== 'idle' || undefined}>
            {children}
          </span>
          <span className={layer(state === 'saving')} aria-hidden="true">
            <SavingGlyph />
          </span>
          <span className={layer(state === 'saved')} aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              {state === 'saved' && (
                <path
                  d="M20 6 9 17l-5-5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pathLength={1}
                  className="save-check"
                />
              )}
            </svg>
            {/* Drawn by CSS so the button's text stays its label; the status line below speaks it. */}
            <span data-label={savedLabel} className="after:content-[attr(data-label)]" />
          </span>
        </span>
      </Button>
      {/* Present from the start, so screen readers announce the change; outside the button so its name stays its label. */}
      <span role="status" className="sr-only">
        {state === 'saving' ? 'Saving' : state === 'saved' ? savedLabel : ''}
      </span>
    </>
  );
}

function SavingGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      className="animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
