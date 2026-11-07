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
