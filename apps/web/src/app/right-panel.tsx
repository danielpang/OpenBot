import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// The on-demand right panel (PRD section 5): one at a time, closed by default.
// The activity log opens in it (features/transcript/panel.tsx remembers which
// panel each Bot had open); later leaves open the computer preview, artifact
// viewer or a thread in it, and the sidebar opens the coding sessions drawer
// in it, wide. `id` names what is open, for toggles; `openId()` reads it
// outside a render, for an effect that must not replace another's panel.

/** The coding sessions drawer's id (CA15): a Bot page leaves it open across Bots. */
export const CODING_SESSIONS_PANEL = 'coding-sessions';

export type RightPanelWidth = 'default' | 'wide';

interface RightPanel {
  content: ReactNode | null;
  id: string | null;
  width: RightPanelWidth;
  open(content: ReactNode, id?: string, options?: { width?: RightPanelWidth }): void;
  close(): void;
  openId(): string | null;
}

const RightPanelContext = createContext<RightPanel | null>(null);

export function RightPanelProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<{
    content: ReactNode;
    id: string | null;
    width: RightPanelWidth;
  } | null>(null);
  const current = useRef<string | null>(null);
  const open = useCallback(
    (content: ReactNode, id?: string, options?: { width?: RightPanelWidth }) => {
      current.current = id ?? null;
      setPanel({ content, id: id ?? null, width: options?.width ?? 'default' });
    },
    [],
  );
  const close = useCallback(() => {
    current.current = null;
    setPanel(null);
  }, []);
  const openId = useCallback(() => current.current, []);
  const value = useMemo(
    () => ({
      content: panel?.content ?? null,
      id: panel?.id ?? null,
      width: panel?.width ?? 'default',
      open,
      close,
      openId,
    }),
    [panel, open, close, openId],
  );
  return <RightPanelContext value={value}>{children}</RightPanelContext>;
}

export function useRightPanel(): RightPanel {
  const panel = useContext(RightPanelContext);
  if (!panel) throw new Error('useRightPanel outside RightPanelProvider');
  return panel;
}

// The panel's width (resizable): the user drags its left edge, or uses the
// arrow keys on the handle, and the width is remembered per kind of panel.

/** Starting widths in pixels: Tailwind's w-96 and w-[34rem]. */
export const PANEL_WIDTHS: Record<RightPanelWidth, number> = { default: 384, wide: 544 };
export const MIN_PANEL_WIDTH = 320;
/** What the page beside the panel keeps, with the sidebar. */
const KEEP_FOR_PAGE = 600;

/** A width the window can take: at least MIN_PANEL_WIDTH, leaving the page its room. */
export function clampPanelWidth(width: number, viewport: number): number {
  const max = Math.max(MIN_PANEL_WIDTH, viewport - KEEP_FOR_PAGE);
  return Math.round(Math.min(max, Math.max(MIN_PANEL_WIDTH, width)));
}

const storageKey = (kind: RightPanelWidth) => `openbots.rightPanel.width.${kind}`;

/** The width the user last left this kind of panel at, or its starting width. */
export function storedPanelWidth(kind: RightPanelWidth): number {
  try {
    const saved = Number(localStorage.getItem(storageKey(kind)));
    if (Number.isFinite(saved) && saved > 0) return saved;
  } catch {
    // Storage can be unavailable; the starting width will do.
  }
  return PANEL_WIDTHS[kind];
}

export function storePanelWidth(kind: RightPanelWidth, width: number | null) {
  try {
    if (width == null) localStorage.removeItem(storageKey(kind));
    else localStorage.setItem(storageKey(kind), String(width));
  } catch {
    // Not remembered; the panel still resizes.
  }
}
