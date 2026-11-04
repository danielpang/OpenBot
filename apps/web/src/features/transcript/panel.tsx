import { Button, XIcon } from '@openbots/ui';
import { useCallback, useEffect, type ReactNode } from 'react';
import { useRightPanel } from '../../app/right-panel.js';
import { ArtifactViewer } from '../artifacts/viewer.js';
import { ScreenPreview } from '../computer/preview.js';
import { ActivityLog } from './activity-log.js';
import { ThreadPanel } from './thread-panel.js';

// Which right panel a Bot's transcript has open (PRD section 5): one at a
// time, closable, remembered per Bot in local storage so coming back to the
// Bot reopens it: the activity log, the artifact viewer (Phase 3) or the
// computer preview (Phase 4) or a thread (Phase 5). A group keeps its panel
// under its chat id where a Bot uses its own id.

export type BotPanel =
  | { kind: 'activity'; runId: string }
  | { kind: 'artifact'; artifactId: string; version?: number }
  | { kind: 'screen' }
  | { kind: 'thread'; chatId: string; rootId: string; focusSeq?: number };

const storageKey = (botId: string) => `openbots.panel.${botId}`;

export function readPanel(botId: string): BotPanel | null {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(botId));
    const panel = raw ? (JSON.parse(raw) as Record<string, unknown> | null) : null;
    if (panel?.kind === 'activity' && typeof panel.runId === 'string') {
      return { kind: 'activity', runId: panel.runId };
    }
    // The viewer reopens on the current version.
    if (panel?.kind === 'artifact' && typeof panel.artifactId === 'string') {
      return { kind: 'artifact', artifactId: panel.artifactId };
    }
    if (panel?.kind === 'screen') return { kind: 'screen' };
    if (
      panel?.kind === 'thread' &&
      typeof panel.chatId === 'string' &&
      typeof panel.rootId === 'string'
    ) {
      return { kind: 'thread', chatId: panel.chatId, rootId: panel.rootId };
    }
    return null;
  } catch {
    return null;
  }
}

export function writePanel(botId: string, panel: BotPanel | null) {
  try {
    if (panel) globalThis.localStorage?.setItem(storageKey(botId), JSON.stringify(panel));
    else globalThis.localStorage?.removeItem(storageKey(botId));
  } catch {
    // Storage may be unavailable (private mode); the panel still opens.
  }
}

/** The right panel's id while this Bot's panel of `kind` is open. */
export const panelId = (botId: string, kind: BotPanel['kind']) => `${kind}:${botId}`;

/** Opens and closes this Bot's right panel. */
export function useShowBotPanel(botId: string) {
  const { open, close } = useRightPanel();

  const show = useCallback(
    (panel: BotPanel | null) => {
      writePanel(botId, panel);
      if (!panel) return close();
      const hide = () => show(null);
      open(
        panel.kind === 'activity' ? (
          <PanelFrame title="Activity" onClose={hide}>
            <ActivityLog key={panel.runId} runId={panel.runId} />
          </PanelFrame>
        ) : panel.kind === 'thread' ? (
          <PanelFrame title="Thread" onClose={hide}>
            <ThreadPanel
              key={`${panel.chatId}:${panel.rootId}:${panel.focusSeq ?? ''}`}
              chatId={panel.chatId}
              rootId={panel.rootId}
              focusSeq={panel.focusSeq}
            />
          </PanelFrame>
        ) : panel.kind === 'screen' ? (
          <PanelFrame title="Computer" onClose={hide}>
            <ScreenPreview botId={botId} />
          </PanelFrame>
        ) : (
          <PanelFrame title="Artifact" onClose={hide}>
            <ArtifactViewer
              key={`${panel.artifactId}:${panel.version ?? ''}`}
              artifactId={panel.artifactId}
              version={panel.version}
            />
          </PanelFrame>
        ),
        panelId(botId, panel.kind),
      );
    },
    [botId, open, close],
  );

  return show;
}

/** `useShowBotPanel`, restoring the remembered panel on mount and closing it on unmount. */
export function useBotPanel(botId: string) {
  const { close } = useRightPanel();
  const show = useShowBotPanel(botId);

  useEffect(() => {
    const remembered = readPanel(botId);
    if (remembered) show(remembered);
    return close;
  }, [botId, show, close]);

  return show;
}

/**
 * Opens the thread a notification or deep link points at (`?thread=`), at
 * the reply `focusSeq`, once the chat is known. It runs after `useBotPanel`
 * restores the remembered panel, so the link wins.
 */
export function useFocusThread(
  show: (panel: BotPanel) => void,
  chatId: string | undefined,
  thread: string | undefined,
  focusSeq: number | undefined,
) {
  useEffect(() => {
    if (chatId && thread) show({ kind: 'thread', chatId, rootId: thread, focusSeq });
  }, [show, chatId, thread, focusSeq]);
}

export function PanelFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h2 className="text-sm font-medium">{title}</h2>
        <Button variant="ghost" size="icon" aria-label={`Close ${title}`} onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <div className="relative min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}
