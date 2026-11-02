import { useEffect } from 'react';
import { onDesktopNew } from './platform.js';

// The sidebar's New (B2). Cmd+N on macOS, Ctrl+N elsewhere, works where the
// page receives it: the Mac app, whose File menu has New with that
// accelerator too. A browser keeps Cmd/Ctrl+N for a new window and never
// passes it to the page, so a browser tab uses Alt+N (Option+N on a Mac).

type Keys = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> &
  Partial<Pick<KeyboardEvent, 'code'>>;

/** Cmd+N on macOS, Ctrl+N elsewhere. */
export function isNewShortcut(event: Keys) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'n'
  );
}

/**
 * Alt+N, Option+N on a Mac: the browser's New. On a Mac, Option+N is a dead
 * key and does not say `n`, so the physical key decides.
 */
export function isNewFallbackShortcut(event: Keys) {
  return (
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    (event.code === 'KeyN' || event.key.toLowerCase() === 'n')
  );
}

const isMac = (platform: string) => /mac|iphone|ipad/i.test(platform);

/** The New shortcut that works here: Cmd/Ctrl+N in the Mac app, Alt+N in a browser. */
export function newShortcutLabel(platform: string, desktop: boolean) {
  if (desktop) return isMac(platform) ? '⌘N' : 'Ctrl+N';
  return isMac(platform) ? '⌥N' : 'Alt+N';
}

/** A text field, where Option+N starts a character such as ñ and must keep doing so. */
function isTextEntry(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Whether a keydown opens New. */
export function opensNew(event: Keys & { target: EventTarget | null }) {
  if (isNewShortcut(event)) return true;
  if (!isNewFallbackShortcut(event)) return false;
  // Alt+N types nothing on Windows or Linux; Option+N in a field composes.
  return !isTextEntry(event.target) || event.key.toLowerCase() === 'n';
}

export function useNewShortcut(onNew: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!opensNew(event)) return;
      event.preventDefault();
      onNew();
    };
    window.addEventListener('keydown', listener);
    const offMenu = onDesktopNew(onNew);
    return () => {
      window.removeEventListener('keydown', listener);
      offMenu();
    };
  }, [onNew]);
}
