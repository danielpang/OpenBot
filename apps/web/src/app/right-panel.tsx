import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// The on-demand right panel (PRD section 5): one at a time, closed by default.
// The activity log opens in it (features/transcript/panel.tsx remembers which
// panel each Bot had open); later leaves open the computer preview, artifact
// viewer or a thread in it. `id` names what is open, for toggles.

interface RightPanel {
  content: ReactNode | null;
  id: string | null;
  open(content: ReactNode, id?: string): void;
  close(): void;
}

const RightPanelContext = createContext<RightPanel | null>(null);

export function RightPanelProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<{ content: ReactNode; id: string | null } | null>(null);
  const open = useCallback(
    (content: ReactNode, id?: string) => setPanel({ content, id: id ?? null }),
    [],
  );
  const close = useCallback(() => setPanel(null), []);
  const value = useMemo(
    () => ({ content: panel?.content ?? null, id: panel?.id ?? null, open, close }),
    [panel, open, close],
  );
  return <RightPanelContext value={value}>{children}</RightPanelContext>;
}

export function useRightPanel(): RightPanel {
  const panel = useContext(RightPanelContext);
  if (!panel) throw new Error('useRightPanel outside RightPanelProvider');
  return panel;
}
