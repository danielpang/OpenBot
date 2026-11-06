import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Static checks on the release configuration. None of this can be packaged,
// signed or notarized here (that needs macOS and the Apple secrets), so the
// tests validate the files those steps read.

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoDir = resolve(desktopDir, '../..');
const read = (path: string) => readFileSync(path, 'utf8');

interface BuilderConfig {
  extends: string;
  productName: string;
  afterSign: string;
  extraResources: { from: string; to: string }[];
  mac: {
    target: unknown[];
    hardenedRuntime: boolean;
    notarize: boolean;
    entitlements: string;
  };
  dmg: { artifactName: string };
}

interface PublishModule {
  (): { publish: Record<string, unknown>[] };
  DEFAULT_REPOSITORY: string;
  releaseRepository(env?: Record<string, string | undefined>): {
    owner: string;
    repo: string;
    slug: string;
  };
  publishConfig(env?: Record<string, string | undefined>): {
    publish: Record<string, unknown>[];
  };
  cloudUrl(env?: Record<string, string | undefined>): string | null;
  updaterDependency(): Record<string, string>;
  appConfig(env?: Record<string, string | undefined>): Record<string, unknown>;
  builderConfig(env?: Record<string, string | undefined>): Record<string, unknown>;
}

interface WorkflowStep {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  'runs-on'?: string;
  if?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, string>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  on: Record<string, unknown>;
  permissions?: unknown;
  jobs: Record<string, WorkflowJob>;
}

const builderConfig = parse(read(join(desktopDir, 'electron-builder.yml'))) as BuilderConfig;
const require = createRequire(import.meta.url);
const publishModule = require(join(desktopDir, 'electron-builder.publish.cjs')) as PublishModule;
const updaterVersion = (
  JSON.parse(read(require.resolve('electron-updater/package.json'))) as { version: string }
).version;

// app-builder-lib is electron-builder's dependency, not ours: resolve it from there.
function appBuilderLib<T>(path: string): T {
  const fromBuilder = createRequire(require.resolve('electron-builder'));
  return createRequire(fromBuilder.resolve('app-builder-lib'))(path) as T;
}
const workflowFile = (name: string) =>
  parse(read(join(repoDir, '.github/workflows', name))) as Workflow;

describe('electron-builder.yml', () => {
  // Loading app-builder-lib cold takes seconds when the whole suite runs at once.
  it("passes electron-builder's own configuration schema", async () => {
    const { validateConfiguration } = appBuilderLib<{
      validateConfiguration(config: unknown, logger: unknown): Promise<void>;
    }>('./util/config/config.js');
    const logger = { isEnabled: false, add: () => undefined };
    await expect(validateConfiguration(builderConfig, logger)).resolves.toBeUndefined();
    const merged = { ...builderConfig, extends: null, ...publishModule.publishConfig({}) };
    await expect(validateConfiguration(merged, logger)).resolves.toBeUndefined();
    // And the check is real: an option electron-builder does not know fails it.
    await expect(validateConfiguration({ ...builderConfig, zip: {} }, logger)).rejects.toThrow(
      /unknown property 'zip'/,
    );
  }, 30_000);

  it('builds a universal DMG and the zip electron-updater needs', () => {
    expect(builderConfig.mac.target).toEqual([
      { target: 'dmg', arch: 'universal' },
      { target: 'zip', arch: 'universal' },
    ]);
  });

  it('updates from the v<version> GitHub Release of GITHUB_REPOSITORY, or the default repository', () => {
    expect(builderConfig.extends).toBe('./electron-builder.publish.cjs');
    expect(publishModule.DEFAULT_REPOSITORY).toBe('danielpang/OpenBots');
    expect(publishModule.publishConfig({}).publish).toEqual([
      {
        provider: 'github',
        owner: 'danielpang',
        repo: 'OpenBots',
        tagNamePrefix: 'v',
        releaseType: 'draft',
      },
    ]);
    expect(publishModule.releaseRepository({ GITHUB_REPOSITORY: 'ada/OpenBots-fork' })).toEqual({
      owner: 'ada',
      repo: 'OpenBots-fork',
      slug: 'ada/OpenBots-fork',
    });
    for (const bad of ['', 'no-slash', 'a/b/c', 'a b/c', '../x']) {
      expect(publishModule.releaseRepository({ GITHUB_REPOSITORY: bad }).slug).toBe(
        'danielpang/OpenBots',
      );
    }
  });

  it('resolves the publish settings the way electron-builder loads them', async () => {
    const { getConfig } = appBuilderLib<{
      getConfig(dir: string, path: null, options: null): Promise<{ publish: unknown }>;
    }>('./util/config/config.js');
    const saved = process.env.GITHUB_REPOSITORY;
    try {
      delete process.env.GITHUB_REPOSITORY;
      expect(await getConfig(desktopDir, null, null)).toMatchObject({
        publish: [{ provider: 'github', owner: 'danielpang', repo: 'OpenBots' }],
      });
      process.env.GITHUB_REPOSITORY = 'ada/OpenBots-fork';
      expect(await getConfig(desktopDir, null, null)).toMatchObject({
        publish: [{ provider: 'github', owner: 'ada', repo: 'OpenBots-fork' }],
      });
    } finally {
      if (saved === undefined) delete process.env.GITHUB_REPOSITORY;
      else process.env.GITHUB_REPOSITORY = saved;
    }
  }, 30_000);

  it('writes OPENBOTS_CLOUD_URL into the packaged package.json, and nothing without it', () => {
    const dependencies = { 'electron-updater': updaterVersion };
    expect(publishModule.appConfig({})).toEqual({ extraMetadata: { dependencies } });
    expect(publishModule.appConfig({ OPENBOTS_CLOUD_URL: ' ' })).toEqual({
      extraMetadata: { dependencies },
    });
    expect(
      publishModule.appConfig({ OPENBOTS_CLOUD_URL: 'https://app.openbots.example/x' }),
    ).toEqual({
      extraMetadata: { dependencies, openbots: { cloudUrl: 'https://app.openbots.example' } },
    });
    // A bad value fails the build rather than ship a broken sign-in.
    for (const bad of ['nope', 'http://app.openbots.example', 'https://u:p@app.openbots.example']) {
      expect(() => publishModule.cloudUrl({ OPENBOTS_CLOUD_URL: bad })).toThrow(
        /OPENBOTS_CLOUD_URL/,
      );
    }
    expect(
      publishModule.builderConfig({ OPENBOTS_CLOUD_URL: 'https://app.openbots.example' }),
    ).toMatchObject({
      publish: [{ provider: 'github' }],
      extraMetadata: { openbots: { cloudUrl: 'https://app.openbots.example' } },
    });
  });

  it('resolves the cloud URL the way electron-builder loads the configuration', async () => {
    const { getConfig } = appBuilderLib<{
      getConfig(dir: string, path: null, options: null): Promise<{ extraMetadata?: unknown }>;
    }>('./util/config/config.js');
    const saved = process.env.OPENBOTS_CLOUD_URL;
    try {
      delete process.env.OPENBOTS_CLOUD_URL;
      expect((await getConfig(desktopDir, null, null)).extraMetadata).toEqual({
        dependencies: { 'electron-updater': updaterVersion },
      });
      process.env.OPENBOTS_CLOUD_URL = 'https://app.openbots.example';
      expect(await getConfig(desktopDir, null, null)).toMatchObject({
        extraMetadata: { openbots: { cloudUrl: 'https://app.openbots.example' } },
      });
    } finally {
      if (saved === undefined) delete process.env.OPENBOTS_CLOUD_URL;
      else process.env.OPENBOTS_CLOUD_URL = saved;
    }
  }, 30_000);

  it("gives electron-builder electron-updater's installed version in place of catalog:", async () => {
    const manifest = JSON.parse(read(join(desktopDir, 'package.json'))) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['electron-updater']).toBe('catalog:');
    expect(updaterVersion).toMatch(/^\d+\.\d+\.\d+/);
    // electron-builder's own check passes on the metadata it packages.
    const { checkMetadata } = appBuilderLib<{
      checkMetadata(metadata: unknown, dev: unknown, file: string, devFile: string): void;
    }>('./util/packageMetadata.js');
    const merged = {
      ...manifest,
      dependencies: { ...manifest.dependencies, ...publishModule.updaterDependency() },
    };
    expect(() => checkMetadata(manifest, manifest, 'package.json', 'package.json')).toThrow(
      /electron-updater/,
    );
    expect(() => checkMetadata(merged, merged, 'package.json', 'package.json')).not.toThrow();
  });

  it('signs with the hardened runtime and notarizes only through the afterSign hook', () => {
    expect(builderConfig.mac.hardenedRuntime).toBe(true);
    expect(builderConfig.mac.notarize).toBe(false);
    expect(builderConfig.afterSign).toBe('./dist/release/notarize.js');
    // The hook is compiled from this source by `pnpm build`.
    expect(existsSync(join(desktopDir, 'src/release/notarize.ts'))).toBe(true);
    const entitlements = read(join(desktopDir, builderConfig.mac.entitlements));
    expect(entitlements).toContain('com.apple.security.cs.allow-jit');
  });

  it('bundles the compose stack the stack manager expects', () => {
    const resources = builderConfig.extraResources;
    const stack = resources.filter((r) => r.to.startsWith('stack/'));
    expect(stack.map((r) => r.to).sort()).toEqual([
      'stack/docker-compose.tunnels.yml',
      'stack/docker-compose.yml',
      'stack/env.example',
    ]);
    for (const { from } of stack) expect(existsSync(join(desktopDir, from))).toBe(true);
  });

  it('bundles no web build: the main window loads the web app from its server', () => {
    expect(builderConfig.extraResources.map((r) => r.to.split('/')[0]).sort()).toEqual([
      'stack',
      'stack',
      'stack',
      'tray',
    ]);
    expect(builderConfig.extraResources.some((r) => r.from.includes('web'))).toBe(false);
  });

  it('names the DMG the way the cask and workflow expect', () => {
    expect(builderConfig.dmg.artifactName).toBe('${productName}-${version}-universal.${ext}');
    expect(builderConfig.productName).toBe('OpenBots');
  });
});

interface ComposeService {
  image?: string;
  build?: { context: string; dockerfile: string };
  profiles?: string[];
}

interface ImagesWorkflow {
  jobs: {
    image: {
      strategy: { matrix: { include: { image: string; context: string; dockerfile: string }[] } };
    };
  };
}

describe('the bundled compose stack', () => {
  const services = (file: string) =>
    (parse(read(join(repoDir, 'docker', file))) as { services: Record<string, ComposeService> })
      .services;
  const bundled = { ...services('docker-compose.yml'), ...services('docker-compose.tunnels.yml') };
  const images = workflowFile('release-images.yml') as unknown as ImagesWorkflow;
  const published = images.jobs.image.strategy.matrix.include;

  it('names an image for every service it starts, since it runs `up --no-build`', () => {
    const started = Object.entries(bundled).filter(([, s]) => !s.profiles?.length);
    expect(started.map(([name]) => name)).toContain('sandbox-firewall');
    for (const [name, service] of started) expect(service.image, name).toBeTruthy();
  });

  it('pulls each OpenBots image from the release workflow, built from the same Dockerfile', () => {
    for (const [name, service] of Object.entries(bundled)) {
      const own = /^\$\{OPENBOTS_IMAGE_PREFIX[^}]*\}\/([a-z-]+):\$\{OPENBOTS_VERSION/.exec(
        service.image ?? '',
      );
      if (!own) continue;
      const entry = published.find((p) => p.image === own[1]);
      expect(
        entry,
        `${name} pulls ${own[1]}, which release-images.yml does not build`,
      ).toBeDefined();
      if (service.build) {
        expect(join(entry!.context, '.')).toBe(join(service.build.context, '.'));
        expect(entry!.dockerfile).toBe(join(service.build.context, service.build.dockerfile));
      }
    }
    expect(published.map((p) => p.image).sort()).toEqual([
      'computer',
      'relay',
      'sandbox-firewall',
      'server',
      'standalone',
    ]);
  });
});

describe('release workflow', () => {
  const release = workflowFile('release.yml');
  const mac = workflowFile('release-mac.yml');
  const macJob = mac.jobs.mac!;
  const step = (name: string) => macJob.steps!.find((s) => s.name === name)!;

  it('releases on v<version> tags and dry-runs pull requests that change the release files', () => {
    expect(release.on.push).toEqual({ tags: ['v[0-9]+.[0-9]+.[0-9]+*'] });
    const paths = (release.on.pull_request as { paths: string[] }).paths;
    for (const path of [
      '.github/workflows/release*.yml',
      'docker/**',
      'apps/desktop/electron-builder*',
    ]) {
      expect(paths).toContain(path);
    }
    // Nothing is granted by default; each job asks for what it needs.
    expect(release.permissions).toEqual({});
  });

  it('publishes only from a tag, after the images, the Mac app and the bundle', () => {
    const { jobs } = release;
    for (const name of ['images', 'mac']) {
      expect(jobs[name]!.if).toBe("needs.version.outputs.publish == 'true'");
      expect(jobs[name]!.with!.publish).toBe(true);
      expect(jobs[`${name}-dry-run`]!.if).toBe("needs.version.outputs.publish != 'true'");
      expect(jobs[`${name}-dry-run`]!.with!.publish).toBe(false);
      expect(jobs[`${name}-dry-run`]!.uses).toBe(jobs[name]!.uses);
    }
    expect(jobs.release!.needs).toEqual(['version', 'images', 'mac', 'bundle']);
    expect(jobs.release!.if).toBe("needs.version.outputs.publish == 'true'");
    // Write access only where it is used.
    expect(jobs.release!.permissions).toEqual({ contents: 'write' });
    expect(jobs.images!.permissions).toEqual({ contents: 'read', packages: 'write' });
    for (const name of ['version', 'images-dry-run', 'mac', 'mac-dry-run', 'bundle']) {
      expect(jobs[name]!.permissions, name).toEqual({ contents: 'read' });
    }
  });

  it('derives tagged versions without comparing committed manifests', () => {
    const run = release.jobs.version!.steps!.find(
      (s) => s.name === 'Resolve the release version',
    )!.run!;
    expect(run).toContain('release-version.mjs from-tag "$tag"');
    expect(run).toContain('release-version.mjs current');
    expect(run).not.toContain('release-version.mjs check');
  });

  it('stamps every fresh build checkout before packaging or creating Docker contexts', () => {
    const stamp = step('Stamp the release version into the build checkout');
    expect(stamp.run).toBe('node scripts/release-version.mjs stamp "v$VERSION"');
    expect(macJob.env!.VERSION).toBe('${{ inputs.version }}');
    expect(macJob.steps!.indexOf(stamp)).toBeLessThan(
      macJob.steps!.indexOf(step('Build the desktop shell')),
    );
    const images = workflowFile('release-images.yml').jobs.image!;
    const imageStamp = images.steps!.find(
      (s) => s.name === 'Stamp the release version into the build context',
    )!;
    expect(imageStamp.env!.VERSION).toBe('${{ inputs.version }}');
    expect(imageStamp.run).toContain('release-version.mjs stamp "v$VERSION"');
    for (const build of images.steps!.filter((s) =>
      s.uses?.startsWith('docker/build-push-action'),
    )) {
      expect(images.steps!.indexOf(imageStamp)).toBeLessThan(images.steps!.indexOf(build));
      // A Git context would ignore checkout mutations. All builds must use path contexts.
      expect(build.with!.context).toBe('${{ matrix.context }}');
    }
    const mobile = workflowFile('release-mobile.yml').jobs.mobile!;
    const mobileStamp = mobile.steps!.find((s) => s.name === 'Stamp the tagged release version')!;
    expect(mobileStamp.run).toContain('release-version.mjs stamp "$RELEASE_TAG"');
    expect(mobileStamp.run).toContain('release-version.mjs current');
    expect(mobileStamp.env!.IS_TAG).toBe("${{ github.ref_type == 'tag' }}");
    for (const name of ['Build workspace packages', 'Build signed IPA with EAS']) {
      expect(mobile.steps!.indexOf(mobileStamp)).toBeLessThan(
        mobile.steps!.findIndex((s) => s.name === name),
      );
    }
  });

  it('passes the Apple secrets to the tag build only', () => {
    expect(Object.keys(release.jobs.mac!.secrets ?? {}).sort()).toEqual([
      'APPLE_API_ISSUER',
      'APPLE_API_KEY_ID',
      'APPLE_API_KEY_P8_BASE64',
      'MAC_CERTS_P12_BASE64',
      'MAC_CERTS_PASSWORD',
    ]);
    expect(release.jobs['mac-dry-run']!.secrets).toBeUndefined();
  });

  it('pins every action to a commit', () => {
    for (const file of ['release.yml', 'release-images.yml', 'release-mac.yml']) {
      const text = read(join(repoDir, '.github/workflows', file));
      for (const [, ref] of text.matchAll(/uses: ([^\s#]+)/g)) {
        if (ref!.startsWith('./')) continue;
        expect(ref, `${file}: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it('builds the Mac app on macOS with the cloud URL from a repository variable', () => {
    expect(macJob['runs-on']).toMatch(/^macos-/);
    expect(macJob.env!.OPENBOTS_CLOUD_URL).toBe('${{ vars.OPENBOTS_CLOUD_URL }}');
  });

  it('signs and notarizes from CI secrets when all are set, and requires notarization', () => {
    const signed = step('Package, sign and notarize');
    expect(signed.if).toBe("steps.signing.outputs.signed == 'true'");
    expect(signed.run).toContain('electron-builder --mac --universal --publish never');
    expect(signed.env).toMatchObject({
      CSC_LINK: '${{ secrets.MAC_CERTS_P12_BASE64 }}',
      CSC_KEY_PASSWORD: '${{ secrets.MAC_CERTS_PASSWORD }}',
      APPLE_API_KEY_ID: '${{ secrets.APPLE_API_KEY_ID }}',
      APPLE_API_ISSUER: '${{ secrets.APPLE_API_ISSUER }}',
      OPENBOTS_REQUIRE_NOTARIZATION: '1',
    });
    expect(step('Write the App Store Connect API key').run).toContain('APPLE_API_KEY=');
    expect(step('Verify the signature, Gatekeeper and the stapled ticket').run).toContain(
      'stapler validate',
    );
    const decide = step('Decide whether to sign');
    expect(Object.keys(decide.env!).filter((k) => k !== 'PUBLISH')).toEqual(
      Object.keys(release.jobs.mac!.secrets!),
    );
  });

  it('builds the dry run ad-hoc signed, and never publishes from electron-builder', () => {
    const unsigned = step('Package unsigned');
    expect(unsigned.if).toBe("steps.signing.outputs.signed != 'true'");
    // Ad-hoc signed even in a pull request, where electron-builder otherwise skips signing.
    expect(unsigned.env).toEqual({
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_FOR_PULL_REQUEST: 'true',
    });
    expect(unsigned.run).toContain('-c.mac.identity=-');
    expect(unsigned.run).toContain('--publish never');
    expect(JSON.stringify(unsigned)).not.toContain('secrets.');
    expect(mac.on.workflow_call).toMatchObject({ outputs: { signed: {} } });
  });

  it('refuses to release an unsigned Mac app, which electron-updater could never update', () => {
    const decide = step('Decide whether to sign').run!;
    expect(decide).toContain('A release must be signed and notarized');
    expect(decide).not.toContain('::warning::');
    const releaseSteps = release.jobs.release!.steps!;
    const refuse = releaseSteps.find((s) => s.name === 'Refuse an unsigned Mac app')!;
    expect(refuse.if).toBe("env.SIGNED != 'true'");
    expect(refuse.run).toContain('exit 1');
    // The update manifest is always part of a release.
    const check = releaseSteps.find((s) => s.name === 'Check the assets and write SHA256SUMS')!;
    expect(check.run).toMatch(/expected=\([^)]*latest-mac\.yml/);
  });

  it('retries an existing tag by hand, building that tag’s commit in every job', () => {
    const dispatch = release.on.workflow_dispatch as { inputs: Record<string, { type: string }> };
    expect(dispatch.inputs.tag!.type).toBe('string');
    const version = release.jobs.version!;
    expect(version.outputs!.ref).toBe('${{ steps.version.outputs.ref }}');
    const versionRun = version.steps!.find((s) => s.name === 'Resolve the release version')!.run!;
    expect(versionRun).toContain('Only the newest tag');
    expect(versionRun).toContain('echo "ref=$(git rev-parse HEAD)"');
    // The tag comes in through the environment, never into the script's text.
    expect(versionRun).not.toContain('inputs.tag');
    for (const name of ['images', 'mac']) {
      expect(release.jobs[name]!.with!.ref, name).toBe('${{ needs.version.outputs.ref }}');
    }
    for (const name of ['bundle', 'release']) {
      const checkout = release.jobs[name]!.steps!.find((s) =>
        s.uses?.startsWith('actions/checkout'),
      );
      expect(checkout!.with!.ref, name).toBe('${{ needs.version.outputs.ref }}');
    }
    for (const file of ['release-images.yml', 'release-mac.yml']) {
      const called = workflowFile(file);
      for (const job of Object.values(called.jobs)) {
        for (const s of job.steps ?? []) {
          if (s.uses?.startsWith('actions/checkout')) {
            expect(s.with!.ref, file).toBe('${{ inputs.ref }}');
          }
        }
      }
    }
  });

  it('publishes the GitHub Release only once every file is on it, the update manifest last', () => {
    const publish = release.jobs.release!.steps!.find(
      (s) => s.name === 'Publish the GitHub Release',
    )!.run!;
    expect(publish).toContain('gh release create "$TAG" --draft --verify-tag');
    const others = publish.indexOf('! -name latest-mac.yml');
    const manifest = publish.indexOf('"$assets/latest-mac.yml"');
    const live = publish.indexOf('--draft=false');
    expect(others).toBeGreaterThan(-1);
    expect(manifest).toBeGreaterThan(others);
    expect(live).toBeGreaterThan(manifest);
  });

  it('renders the cask from the template and the DMG name electron-builder produces', () => {
    const run = step('Render the Homebrew cask').run!;
    expect(run).toContain('release/OpenBots-$VERSION-universal.dmg');
    expect(run).toContain('packaging/homebrew/openbots.rb.template');
    // The cask points at the repository the release goes to.
    expect(run).toContain("require('./electron-builder.publish.cjs').releaseRepository().slug");
    expect(run).toContain('s#{{REPOSITORY}}#$repo#g');
  });
});

describe('Homebrew cask template', () => {
  const template = read(join(desktopDir, 'packaging/homebrew/openbots.rb.template'));

  it('has exactly the placeholders the workflow fills', () => {
    expect([...new Set(template.match(/\{\{[A-Z0-9_]+\}\}/g))].sort()).toEqual([
      '{{REPOSITORY}}',
      '{{SHA256}}',
      '{{VERSION}}',
    ]);
  });

  it('downloads the DMG from the v<version> release of the release repository', () => {
    expect(template).toContain(
      'https://github.com/{{REPOSITORY}}/releases/download/v#{version}/OpenBots-#{version}-universal.dmg',
    );
    expect(template).not.toContain('danielpang');
    expect(template).toContain('app "OpenBots.app"');
  });
});
