import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, openBotsServer } from './fake-fetch.js';
import { checkServer, entryPath, ServerCheckError, waitUntilReady } from './server-check.js';

const URL_ = 'https://openbots.example.com';

describe('checkServer', () => {
  it('reports whether an OpenBots server needs its first-run setup', async () => {
    await expect(checkServer(fakeFetch(openBotsServer(URL_, true)), URL_)).resolves.toEqual({
      url: URL_,
      setupRequired: true,
    });
    await expect(checkServer(fakeFetch(openBotsServer(URL_)), URL_)).resolves.toEqual({
      url: URL_,
      setupRequired: false,
    });
  });

  it('says when the server cannot be reached', async () => {
    await expect(checkServer(fakeFetch({}), URL_)).rejects.toThrow(
      'Could not reach openbots.example.com. Check the address, and that the server is running.',
    );
  });

  it('says when something else answers', async () => {
    const notOpenBots = /answered, but it is not an OpenBots server/;
    // A web page, a server without the setup route, and one that redirects.
    await expect(
      checkServer(fakeFetch({ [`${URL_}/healthz`]: { status: 200 } }), URL_),
    ).rejects.toThrow(notOpenBots);
    await expect(
      checkServer(
        fakeFetch({
          [`${URL_}/healthz`]: { status: 200, body: { status: 'ok' } },
          [`${URL_}/api/v1/setup`]: { status: 404, body: {} },
        }),
        URL_,
      ),
    ).rejects.toThrow(notOpenBots);
    await expect(
      checkServer(fakeFetch({ [`${URL_}/healthz`]: { status: 302 } }), URL_),
    ).rejects.toThrow(ServerCheckError);
  });

  it('does not follow redirects', async () => {
    const fetch = fakeFetch(openBotsServer(URL_));
    await checkServer(fetch, URL_);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });

  it('opens setup until the server has a user, then sign-in', () => {
    expect(entryPath(true)).toBe('/setup');
    expect(entryPath(false)).toBe('/sign-in');
  });
});

describe('waitUntilReady', () => {
  it('polls /readyz until the server is ready', async () => {
    const fetch = fakeFetch({
      [`${URL_}/readyz`]: [
        'down',
        { status: 503, body: { status: 'not_ready' } },
        { status: 200, body: { status: 'ready' } },
      ],
    });
    const sleep = vi.fn(async () => undefined);
    await waitUntilReady(fetch, URL_, { sleep, intervalMs: 5 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it('gives up after the timeout', async () => {
    let now = 0;
    const fetch = fakeFetch({});
    await expect(
      waitUntilReady(fetch, URL_, {
        timeoutMs: 10,
        intervalMs: 4,
        now: () => now,
        sleep: async (ms) => void (now += ms),
      }),
    ).rejects.toThrow(/not ready yet/);
  });
});
