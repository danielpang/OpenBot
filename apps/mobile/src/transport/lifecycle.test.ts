import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MobileTransport } from './index';
import { TransportLifecycle } from './lifecycle';

const transport = (): MobileTransport => ({
  kind: 'direct',
  baseUrl: 'https://example.com',
  fetch,
  createSocket: vi.fn(),
  createBinarySocket: vi.fn(),
  close: vi.fn(),
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe('TransportLifecycle', () => {
  it('closes background connections and resyncs on every foreground connection', async () => {
    const first = transport();
    const second = transport();
    const connected = vi.fn();
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const lifecycle = new TransportLifecycle({ connect, onConnected: connected });
    lifecycle.setActive(true);
    await settle();
    lifecycle.setActive(false);
    expect(first.close).toHaveBeenCalledOnce();
    lifecycle.setActive(true);
    await settle();
    expect(connected.mock.calls.map(([item]) => item)).toEqual([first, second]);
    lifecycle.close();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('disposes a late handshake instead of publishing it after backgrounding', async () => {
    const late = transport();
    let resolve!: (value: MobileTransport) => void;
    const connected = vi.fn();
    const lifecycle = new TransportLifecycle({
      connect: () =>
        new Promise((done) => {
          resolve = done;
        }),
      onConnected: connected,
    });
    lifecycle.setActive(true);
    lifecycle.setActive(false);
    resolve(late);
    await settle();
    expect(late.close).toHaveBeenCalledOnce();
    expect(connected).not.toHaveBeenCalled();
  });

  it('retries with bounded backoff and cancels pending retries in background', async () => {
    vi.useFakeTimers();
    const connect = vi.fn().mockRejectedValue(new Error('offline'));
    const lifecycle = new TransportLifecycle({
      connect,
      onConnected: vi.fn(),
      backoffMs: 100,
      maxBackoffMs: 200,
    });
    lifecycle.setActive(true);
    await settle();
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(3);
    lifecycle.setActive(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
