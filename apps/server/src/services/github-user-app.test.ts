import { afterEach, describe, expect, it, vi } from 'vitest';
import * as net from '../builtins/net.js';
import { userAppRepositories } from './github-user-app.js';

const install = {
  id: 99,
  app_slug: 'test-app',
  suspended_at: null,
  permissions: { contents: 'write' },
};
const repo = (id: number) => ({
  id,
  full_name: `org/repo-${id}`,
  private: true,
  permissions: { push: true },
});
afterEach(() => vi.restoreAllMocks());

describe('user/installation repository traversal', () => {
  it('paginates both installations and repositories without trusting Link header destinations', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.github.com');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ghu_test');
      if (url.pathname === '/user') return Response.json({ id: 1, login: 'owner' });
      const page = Number(url.searchParams.get('page'));
      expect(url.searchParams.get('per_page')).toBe('100');
      if (url.pathname === '/user/installations')
        return Response.json({
          installations:
            page === 1
              ? Array.from({ length: 100 }, (_, i) => ({
                  ...install,
                  id: i + 1,
                  app_slug: 'other-app',
                }))
              : [install],
        });
      expect(url.pathname).toBe('/user/installations/99/repositories');
      return Response.json(
        {
          repositories:
            page === 1 ? Array.from({ length: 100 }, (_, i) => repo(i + 1)) : [repo(101)],
        },
        { headers: { link: '<https://evil.example/steal>; rel="next"' } },
      );
    });
    vi.spyOn(net, 'netFetch').mockReturnValue(fetch);
    const result = await userAppRepositories({}, 'ghu_test', 'test-app');
    expect(result.repositories).toHaveLength(101);
    expect(result.repositories.at(-1)).toMatchObject({ fullName: 'org/repo-101', push: true });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(net.netFetch).toHaveBeenCalledWith(
      expect.objectContaining({ allowlist: ['api.github.com'], maxRedirects: 0 }),
    );
  });

  it('does not expose HTTP provider bodies containing credentials', async () => {
    vi.spyOn(net, 'netFetch').mockReturnValue(async () =>
      Response.json({ message: 'ghu_private-token' }, { status: 401 }),
    );
    await expect(userAppRepositories({}, 'ghu_private-token', 'test-app')).rejects.toMatchObject({
      githubStatus: 401,
      message:
        'GitHub did not accept this repository authorization. Reconnect GitHub or check the installation.',
    });
  });

  it('refuses malformed installation IDs instead of turning them into bearer destinations', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/user')
        ? Response.json({ id: 1, login: 'owner' })
        : Response.json({ installations: [{ ...install, id: '../escape' }] }),
    );
    vi.spyOn(net, 'netFetch').mockReturnValue(fetch);
    await expect(userAppRepositories({}, 'ghu_test', 'test-app')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
