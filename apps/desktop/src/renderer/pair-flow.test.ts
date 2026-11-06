import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairRelayStatus, PairRelayView } from '../ipc.js';
import { createPairFlow, LINK_POLL_MS, LINK_WAIT_MS, relayChanged } from './pair-flow.js';

const SHARED = 'wss://relay.openbots.example';
const CODE = { link: 'openbots://pair#v=1', expiresAt: '2026-01-01T00:05:00.000Z', skewMs: 0 };

// The link watch runs on timers, so every test here owns the clock.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeBridge(relay: Partial<PairRelayView> = {}) {
  let paired: ((name: string) => void) | null = null;
  const view: PairRelayView = { local: true, sharedUrl: SHARED, current: SHARED, ...relay };
  const pair = {
    relay: vi.fn(async () => view),
    setRelay: vi.fn(async (url: string) => ({ ...view, current: url })),
    code: vi.fn(async () => CODE),
    relayStatus: vi.fn(async (): Promise<PairRelayStatus> => ({ status: 'linked', error: null })),
    onPaired: vi.fn((listener: (name: string) => void) => {
      paired = listener;
      return () => (paired = null);
    }),
    close: vi.fn(),
  };
  return { bridge: { pair }, pair, paired: (name: string) => paired?.(name) };
}

describe('Pair your phone', () => {
  it('shows a code straight away, through the relay in use', async () => {
    for (const relay of [{}, { local: false, current: null }]) {
      const { bridge, pair } = fakeBridge(relay);
      const flow = createPairFlow(bridge);
      await flow.start();
      expect(flow.store.get()).toMatchObject({ step: 'code', code: CODE, making: false });
      expect(pair.setRelay).not.toHaveBeenCalled();
    }
  });

  it('says which phone paired while the code shows, then stops listening on close', async () => {
    const { bridge, pair, paired } = fakeBridge();
    const flow = createPairFlow(bridge);
    paired('Too early');
    expect(flow.store.get().paired).toBeNull();
    await flow.start();
    paired('Dana’s iPhone');
    expect(flow.store.get()).toMatchObject({ step: 'paired', paired: 'Dana’s iPhone' });
    flow.close();
    expect(pair.close).toHaveBeenCalled();
  });

  it('opens the Relay view from under the code on This Mac only', async () => {
    const remote = createPairFlow(fakeBridge({ local: false }).bridge);
    await remote.start();
    remote.changeRelay();
    expect(remote.store.get().step).toBe('code');
    const local = createPairFlow(fakeBridge().bridge);
    await local.start();
    local.changeRelay();
    expect(local.store.get()).toMatchObject({ step: 'relay', url: SHARED, code: null });
  });
});

describe('the server’s link to the relay', () => {
  it('holds the code back until the server is linked, then shows it', async () => {
    const { bridge, pair } = fakeBridge();
    pair.relayStatus
      .mockResolvedValueOnce({ status: 'off', error: null })
      .mockResolvedValueOnce({ status: 'connecting', error: null });
    const flow = createPairFlow(bridge);
    await flow.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.store.get()).toMatchObject({ step: 'code', code: CODE, link: 'waiting' });
    await vi.advanceTimersByTimeAsync(LINK_POLL_MS);
    expect(flow.store.get().link).toBe('waiting');
    await vi.advanceTimersByTimeAsync(LINK_POLL_MS);
    expect(flow.store.get()).toMatchObject({ link: 'linked', linkError: null });
    flow.close();
  });

  it('says why when the server reports it cannot reach the relay, and recovers once it can', async () => {
    const { bridge, pair } = fakeBridge({ current: 'wss://relay.openbots.dev' });
    pair.relayStatus.mockResolvedValue({
      status: 'connecting',
      error: 'getaddrinfo ENOTFOUND relay.openbots.dev',
    });
    const flow = createPairFlow(bridge);
    await flow.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.store.get()).toMatchObject({
      step: 'code',
      link: 'failed',
      linkError:
        'Your server could not connect to the relay at relay.openbots.dev: getaddrinfo ENOTFOUND relay.openbots.dev.',
    });
    pair.relayStatus.mockResolvedValue({ status: 'linked', error: null });
    await vi.advanceTimersByTimeAsync(LINK_POLL_MS);
    expect(flow.store.get()).toMatchObject({ link: 'linked', linkError: null });
    flow.close();
  });

  it('gives a server that reports no reason 15 seconds before it says it has not connected', async () => {
    const { bridge, pair } = fakeBridge();
    pair.relayStatus.mockResolvedValue({ status: 'connecting', error: null });
    const flow = createPairFlow(bridge);
    await flow.start();
    await vi.advanceTimersByTimeAsync(LINK_WAIT_MS - LINK_POLL_MS);
    expect(flow.store.get().link).toBe('waiting');
    await vi.advanceTimersByTimeAsync(LINK_POLL_MS);
    expect(flow.store.get()).toMatchObject({
      link: 'failed',
      linkError: 'Your server has not connected to the relay at relay.openbots.example.',
    });
    flow.close();
  });

  it('keeps waiting through a status it could not read', async () => {
    const { bridge, pair } = fakeBridge();
    pair.relayStatus.mockRejectedValueOnce(new Error('Sign in to OpenBots first.'));
    const flow = createPairFlow(bridge);
    await flow.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.store.get()).toMatchObject({ link: 'waiting', linkError: null });
    await vi.advanceTimersByTimeAsync(LINK_POLL_MS);
    expect(flow.store.get().link).toBe('linked');
    flow.close();
  });

  it('watches no link when the server has no relay, and stops when the window closes', async () => {
    const { bridge, pair } = fakeBridge({ local: false, current: null });
    const flow = createPairFlow(bridge);
    await flow.start();
    await vi.advanceTimersByTimeAsync(LINK_POLL_MS * 3);
    expect(flow.store.get()).toMatchObject({ step: 'code', code: CODE, link: 'none' });
    expect(pair.relayStatus).not.toHaveBeenCalled();

    const watched = fakeBridge();
    const linked = createPairFlow(watched.bridge);
    await linked.start();
    await vi.advanceTimersByTimeAsync(LINK_POLL_MS);
    const asked = watched.pair.relayStatus.mock.calls.length;
    expect(asked).toBeGreaterThan(0);
    linked.close();
    await vi.advanceTimersByTimeAsync(LINK_POLL_MS * 3);
    expect(watched.pair.relayStatus.mock.calls.length).toBe(asked);
  });
});

describe('the Relay view', () => {
  it('shows the shared relay by default, and Save does nothing until it changes', async () => {
    const { bridge, pair } = fakeBridge();
    const flow = createPairFlow(bridge, 'relay');
    await flow.start();
    expect(flow.store.get()).toMatchObject({ step: 'relay', url: SHARED });
    expect(relayChanged(flow.store.get())).toBe(false);
    flow.save();
    expect(flow.store.get().step).toBe('relay');
    expect(pair.code).not.toHaveBeenCalled();
  });

  it('asks once more, then sets the relay and offers to pair again', async () => {
    const { bridge, pair } = fakeBridge();
    const flow = createPairFlow(bridge, 'relay');
    await flow.start();
    flow.setUrl('  wss://mine.example  ');
    flow.save();
    expect(flow.store.get().step).toBe('confirm');
    expect(pair.setRelay).not.toHaveBeenCalled();
    flow.back();
    expect(flow.store.get()).toMatchObject({ step: 'relay', url: '  wss://mine.example  ' });
    flow.save();
    await flow.apply();
    expect(pair.setRelay).toHaveBeenCalledWith('wss://mine.example');
    expect(flow.store.get()).toMatchObject({ step: 'saved' });
    expect(flow.store.get().relay?.current).toBe('wss://mine.example');
    await flow.newCode();
    expect(flow.store.get()).toMatchObject({ step: 'code', code: CODE });
  });

  it('goes back to the shared relay from the owner’s own', async () => {
    const { bridge } = fakeBridge({ current: 'wss://mine.example' });
    const flow = createPairFlow(bridge, 'relay');
    await flow.start();
    expect(flow.store.get().url).toBe('wss://mine.example');
    flow.useShared();
    expect(flow.store.get().url).toBe(SHARED);
    expect(relayChanged(flow.store.get())).toBe(true);
  });

  it('asks for an address when the box is empty, and shows a refused one', async () => {
    const { bridge, pair } = fakeBridge();
    pair.setRelay.mockRejectedValueOnce(
      new Error("Error invoking remote method 'openbots:pair:set-relay': Error: Not a relay."),
    );
    const flow = createPairFlow(bridge, 'relay');
    await flow.start();
    flow.setUrl(' ');
    flow.save();
    expect(flow.store.get().error).toMatch(/wss:\/\//);
    flow.setUrl('wss://bad.example');
    flow.save();
    await flow.apply();
    expect(flow.store.get()).toMatchObject({ step: 'relay', error: 'Not a relay.' });
  });
});
