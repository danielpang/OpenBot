import { describe, expect, it, vi } from 'vitest';
import type { PairRelayView } from '../ipc.js';
import { createPairFlow, relayChanged } from './pair-flow.js';

const SHARED = 'wss://relay.openbots.example';
const CODE = { link: 'openbots://pair#v=1', expiresAt: '2026-01-01T00:05:00.000Z', skewMs: 0 };

function fakeBridge(relay: Partial<PairRelayView> = {}) {
  let paired: ((name: string) => void) | null = null;
  const view: PairRelayView = { local: true, sharedUrl: SHARED, current: SHARED, ...relay };
  const pair = {
    relay: vi.fn(async () => view),
    setRelay: vi.fn(async (url: string) => ({ ...view, current: url })),
    code: vi.fn(async () => CODE),
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
