import { useCallback } from 'react';

// A chat's dock (the composer and what sits on it) floats over the end of the
// conversation in Liquid Glass (packages/ui styles.css, `chat-dock` and
// `chat-scroll`): the conversation scrolls on under it and shows through the
// glass. The dock's height, kept in `--dock-height` on its parent, is the room
// the conversation leaves at its end so its last message clears the dock.

/** A ref for the dock element; it measures the dock while it is mounted. */
export function useChatDock<T extends HTMLElement>() {
  return useCallback((dock: T | null) => {
    const host = dock?.parentElement;
    if (!dock || !host) return;
    const measure = () => host.style.setProperty('--dock-height', `${dock.offsetHeight}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(dock);
    return () => {
      observer?.disconnect();
      host.style.removeProperty('--dock-height');
    };
  }, []);
}
