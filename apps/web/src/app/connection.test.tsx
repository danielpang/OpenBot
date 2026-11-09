// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeStatusContext, type RealtimeStatus } from '../features/transcript/realtime.js';
import { ConnectionIndicator, Indicator } from './connection-indicator.js';
import { indicatorState } from './connection.js';
import type { DesktopConnection, DesktopConnectionInfo } from './platform.js';

// The Mac app's connection indicator (plan 14.4): which kind of connection,
// the live state, and the menu's actions.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const open: RealtimeStatus = { status: 'open', everOpen: true };
const lost: RealtimeStatus = { status: 'closed', everOpen: true };
const first: RealtimeStatus = { status: 'connecting', everOpen: false };

const cloud: DesktopConnectionInfo = {
  kind: 'cloud',
  label: 'OpenBots account',
  host: 'app.openbots.example',
  url: 'https://app.openbots.example',
};
const remote: DesktopConnectionInfo = {
  kind: 'remote',
  label: 'Self-hosted',
  host: 'openbots.example.com',
  url: 'https://openbots.example.com',
};
const local = (state: 'running' | 'unhealthy' | 'stopped'): DesktopConnectionInfo => ({
  kind: 'local',
  label: 'This Mac',
  host: 'localhost:3000',
  url: 'http://localhost:3000',
  stack: { state, text: state === 'running' ? 'Running on OrbStack.' : 'Not started.' },
});

describe('indicatorState', () => {
  it('names each kind of connection, with the host for a server elsewhere', () => {
    expect(indicatorState(cloud, open)).toEqual({
      title: 'OpenBots account',
      label: 'OpenBots account',
      status: 'Connected',
      tone: 'normal',
      tooltip: 'OpenBots account (app.openbots.example): Connected',
    });
    expect(indicatorState(remote, open).tooltip).toBe(
      'Self-hosted (openbots.example.com): Connected',
    );
    expect(indicatorState(local('running'), open).tooltip).toBe('This Mac (Docker): Connected');
    expect(indicatorState(local('running'), open).label).toBe('This Mac');
    const paired = { ...remote, label: 'Paired', host: "Ada's MacBook" };
    expect(indicatorState(paired, open)).toMatchObject({
      title: 'Paired',
      label: 'Paired',
      tooltip: "Paired (Ada's MacBook): Connected",
    });
    // Any other label is the Mac app's own wording for a kind the web app already names.
    expect(indicatorState({ ...remote, label: 'Something' }, open).label).toBe('Self-hosted');
  });

  it('says connecting at first and reconnecting once a connection was lost', () => {
    expect(indicatorState(remote, first)).toMatchObject({ status: 'Connecting…', tone: 'normal' });
    expect(indicatorState(remote, lost)).toMatchObject({
      status: 'Reconnecting…',
      tone: 'warning',
    });
    expect(indicatorState(cloud, { status: 'connecting', everOpen: true })).toMatchObject({
      status: 'Reconnecting…',
    });
  });

  it("shows This Mac's stack stopped or unhealthy", () => {
    expect(indicatorState(local('stopped'), lost)).toMatchObject({
      status: 'Stopped',
      tone: 'problem',
    });
    expect(indicatorState(local('unhealthy'), open)).toMatchObject({
      status: 'Not healthy',
      tone: 'warning',
    });
    // The server answers: a stale stack check does not say it stopped.
    expect(indicatorState(local('stopped'), open).status).toBe('Connected');
  });

  it('uses no dashes in its copy', () => {
    for (const info of [cloud, remote, local('stopped'), local('unhealthy')]) {
      for (const realtime of [open, lost, first]) {
        expect(indicatorState(info, realtime).tooltip).not.toMatch(/[–—]| - /);
      }
    }
  });
});

function fakeConnection(info: DesktopConnectionInfo) {
  return {
    info: vi.fn(async () => info),
    change: vi.fn(async () => undefined),
    start: vi.fn(async () => ({ ...info, stack: { state: 'running' as const, text: 'Running.' } })),
    stop: vi.fn(async () => undefined),
    showLogs: vi.fn(async () => undefined),
  } satisfies DesktopConnection;
}

describe('the connection indicator', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    delete (window as { openbots?: unknown }).openbots;
  });

  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const trigger = () => document.querySelector<HTMLElement>('[data-tone]');

  async function render(info: DesktopConnectionInfo, realtime = open) {
    const connection = fakeConnection(info);
    await act(async () =>
      root.render(
        <RealtimeStatusContext value={realtime}>
          <Indicator connection={connection} defaultOpen />
        </RealtimeStatusContext>,
      ),
    );
    return connection;
  }

  it('does not appear in a browser', async () => {
    await act(async () => root.render(<ConnectionIndicator />));
    expect(host.innerHTML).toBe('');
  });

  it("appears in the Mac app from the bridge's connection", async () => {
    const connection = fakeConnection(remote);
    (window as { openbots?: unknown }).openbots = {
      platform: { kind: 'desktop', os: 'darwin', version: '1.0.0', nativeNotifications: true },
      onNavigate: () => () => {},
      connection,
    };
    await act(async () => root.render(<ConnectionIndicator />));
    // Outside the shell's realtime provider the connection has not opened yet.
    expect(trigger()?.getAttribute('aria-label')).toBe(
      'Self-hosted (openbots.example.com): Connecting…',
    );
    expect(connection.info).toHaveBeenCalled();
  });

  it('offers only Change connection for a self-hosted server or an account', async () => {
    for (const info of [remote, cloud]) {
      const connection = await render(info);
      expect(items().map((i) => i.textContent)).toEqual(['Change connection…']);
      expect(document.body.textContent).not.toMatch(/Docker|Start|Stop|logs/);
      act(() => items()[0]!.click());
      expect(connection.change).toHaveBeenCalled();
      act(() => root.render(null));
    }
  });

  it("shows the connection's short name beside the icon", async () => {
    await render(local('running'));
    expect(trigger()?.textContent).toBe('This Mac');
    act(() => root.render(null));
    await render(remote);
    expect(trigger()?.textContent).toBe('Self-hosted');
  });

  it('is coloured only for a problem', async () => {
    await render(remote, open);
    expect(trigger()?.dataset.tone).toBe('normal');
    expect(trigger()?.className).toContain('text-muted-foreground');
    act(() => root.render(null));
    await render(remote, lost);
    expect(trigger()?.dataset.tone).toBe('warning');
    expect(trigger()?.getAttribute('aria-label')).toBe(
      'Self-hosted (openbots.example.com): Reconnecting…',
    );
  });

  it("offers This Mac's Start, Show logs and Change connection when the stack is stopped", async () => {
    const connection = await render(local('stopped'), lost);
    expect(trigger()?.dataset.tone).toBe('problem');
    expect(items().map((i) => i.textContent)).toEqual(['Start', 'Show logs', 'Change connection…']);
    await act(async () => items()[0]!.click());
    expect(connection.start).toHaveBeenCalled();
  });

  it("offers This Mac's Stop and Show logs while it runs", async () => {
    const connection = await render(local('running'));
    expect(items().map((i) => i.textContent)).toEqual(['Stop', 'Show logs', 'Change connection…']);
    act(() => items()[0]!.click());
    expect(connection.stop).toHaveBeenCalled();
    act(() => root.render(null));
    const again = await render(local('running'));
    act(() => items()[1]!.click());
    expect(again.showLogs).toHaveBeenCalled();
  });

  it('asks again while the server does not answer', async () => {
    vi.useFakeTimers();
    try {
      const connection = await render(local('stopped'), lost);
      expect(connection.info).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(connection.info).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
