import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const expo = createRequire(require.resolve('expo/package.json'));
const config = createRequire(expo.resolve('@expo/config/package.json'));
const cli = createRequire(expo.resolve('@expo/cli/package.json'));

describe('EAS build toolchain', () => {
  it.each(['development', 'simulator', 'simulator-release', 'preview', 'production'])(
    'pins the workspace-compatible Node and pnpm versions for %s',
    (profile) => {
      type Profile = { extends?: string; node?: string; pnpm?: string };
      const eas = JSON.parse(readFileSync(new URL('../../eas.json', import.meta.url), 'utf8')) as {
        build: Record<string, Profile>;
      };
      const root = JSON.parse(
        readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
      ) as {
        packageManager: string;
      };
      const nodeMajor = readFileSync(new URL('../../../../.nvmrc', import.meta.url), 'utf8').trim();
      function resolve(name: string, seen = new Set<string>()): Profile {
        if (seen.has(name)) throw new Error(`Cyclic EAS profile: ${name}`);
        seen.add(name);
        const config = eas.build[name];
        if (!config) throw new Error(`Missing EAS profile: ${name}`);
        return { ...(config.extends ? resolve(config.extends, seen) : {}), ...config };
      }
      const resolved = resolve(profile);
      expect(resolved.node).toMatch(/^\d+\.\d+\.\d+$/);
      expect(resolved.node?.split('.')[0]).toBe(nodeMajor);
      expect(`pnpm@${resolved.pnpm}`).toBe(root.packageManager);
    },
  );
});

describe('Expo tooling security overrides', () => {
  it.each([
    'docker/server.Dockerfile',
    'docker/computer.Dockerfile',
    'docker/relay.Dockerfile',
    'docker/standalone.Dockerfile',
    'ee/server/Dockerfile',
  ])('copies security patches before every dependency fetch in %s', (file) => {
    const source = readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');
    const fetches = source.match(/^RUN pnpm fetch /gm) ?? [];
    const patchedFetches = source.match(/^COPY patches \.\/patches\nRUN pnpm fetch /gm) ?? [];
    expect(fetches.length).toBeGreaterThan(0);
    expect(patchedFetches.length).toBe(fetches.length);
  });
  it.each(['deepmerge', 'deepmerge/dist/umd.js'])(
    'blocks poisoned source and target keys in %s, including nested objects',
    (entry) => {
      const merge = config(entry) as (target: object, source: object) => Record<string, unknown>;
      const poisoned = JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true},"safe":1}',
      );
      for (const result of [
        merge({}, poisoned),
        merge(poisoned, {}),
        merge(Object.create(null), poisoned),
      ]) {
        expect(result.safe).toBe(1);
        expect(result.polluted).toBeUndefined();
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        for (const key of ['__proto__', 'constructor', 'prototype'])
          expect(Object.hasOwn(result, key)).toBe(false);
      }
      const result = merge({ nested: poisoned }, { other: [poisoned] });
      expect(result.nested).toEqual({ safe: 1 });
      expect(result.other).toEqual([{ safe: 1 }]);
      expect(
        merge({ ios: { a: true }, plugins: ['one'] }, { ios: { b: true }, plugins: ['two'] }),
      ).toEqual({ ios: { a: true, b: true }, plugins: ['one', 'two'] });
    },
  );

  it('keeps Expo CLI plugin validation compatible with patched Zod 4', () => {
    const { PluginSchema, DevToolsPluginOutputSchema } = cli(
      './build/src/start/server/DevToolsPlugin.schema.js',
    );
    expect(cli('zod/package.json').version).toMatch(/^4\./);
    expect(
      PluginSchema.safeParse({ packageName: 'test-plugin', packageRoot: '/tmp/plugin' }).success,
    ).toBe(true);
    expect(PluginSchema.safeParse({ packageName: '', packageRoot: '/tmp/plugin' }).success).toBe(
      false,
    );
    expect(
      DevToolsPluginOutputSchema.safeParse([{ type: 'text', text: 'Hello', level: 'info' }])
        .success,
    ).toBe(true);
    expect(
      DevToolsPluginOutputSchema.safeParse([{ type: 'image', url: 'not-a-url' }]).success,
    ).toBe(false);
  });
});
