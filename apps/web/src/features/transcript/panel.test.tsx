// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RightPanelProvider, useRightPanel } from '../../app/right-panel.js';
import { readPanel, useBotPanel, useFocusThread, writePanel, type BotPanel } from './panel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let show: (panel: BotPanel | null) => void;
function BotView({ botId }: { botId: string }) {
  show = useBotPanel(botId);
  return null;
}
const CHAT = '00000000-0000-4000-8000-0000000000c1';
const ROOT = '00000000-0000-4000-8000-0000000000aa';
function LinkedView({ botId }: { botId: string }) {
  const show = useBotPanel(botId);
  useFocusThread(show, CHAT, ROOT, 7);
  return null;
}
function Slot() {
  const { content } = useRightPanel();
  return content ? <aside>{content}</aside> : null;
}

let root: Root;
let host: HTMLElement;
const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
function render(botId: string | null) {
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RightPanelProvider>
          {botId && <BotView botId={botId} />}
          <Slot />
        </RightPanelProvider>
      </QueryClientProvider>,
    ),
  );
}
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

describe('the right panel per Bot', () => {
  it('opens the thread a link points at over the remembered panel', () => {
    writePanel('a', { kind: 'activity', runId: 'run-1' });
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <RightPanelProvider>
            <LinkedView botId="a" />
            <Slot />
          </RightPanelProvider>
        </QueryClientProvider>,
      ),
    );
    expect(host.querySelector('aside h2')?.textContent).toBe('Thread');
    expect(readPanel('a')).toEqual({ kind: 'thread', chatId: CHAT, rootId: ROOT });
  });

  it('opens one panel, remembers it per Bot, and closes', () => {
    render('a');
    expect(host.querySelector('aside')).toBeNull();
    act(() => show({ kind: 'activity', runId: 'run-1' }));
    expect(host.querySelector('aside h2')?.textContent).toBe('Activity');
    expect(readPanel('a')).toEqual({ kind: 'activity', runId: 'run-1' });

    render('b');
    expect(host.querySelector('aside')).toBeNull();
    render('a');
    expect(host.querySelector('aside h2')?.textContent).toBe('Activity');

    act(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Close Activity"]')!.click(),
    );
    expect(host.querySelector('aside')).toBeNull();
    expect(readPanel('a')).toBeNull();
  });

  it('closes the panel when the transcript goes away', () => {
    writePanel('a', { kind: 'activity', runId: 'run-1' });
    render('a');
    expect(host.querySelector('aside')).not.toBeNull();
    render(null);
    expect(host.querySelector('aside')).toBeNull();
    expect(readPanel('a')).not.toBeNull();
  });

  it('remembers the computer preview', () => {
    writePanel('a', { kind: 'screen' });
    expect(readPanel('a')).toEqual({ kind: 'screen' });
  });

  it('ignores a malformed stored value', () => {
    localStorage.setItem('openbots.panel.a', '{"kind":"nope"}');
    expect(readPanel('a')).toBeNull();
  });
});
