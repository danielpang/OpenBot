import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const {
  nativeOptions,
  extensionInfo,
  configureProject,
} = require('../../plugins/withOpenBotsNative.cjs');

describe('native target configuration', () => {
  const config = {
    version: '1.2.3',
    ios: { bundleIdentifier: 'dev.openbots.mobile', buildNumber: '123.2' },
  };
  it('uses matching app/extension groups and native version', () => {
    const options = nativeOptions(config);
    expect(options).toMatchObject({
      appGroup: 'group.dev.openbots.mobile',
      keychainGroup: '$(AppIdentifierPrefix)dev.openbots.mobile.push',
    });
    expect(extensionInfo(config, options)).toMatchObject({
      CFBundleShortVersionString: '1.2.3',
      CFBundleVersion: '123.2',
      OpenBotsAppGroup: options.appGroup,
      OpenBotsKeychainAccessGroup: options.keychainGroup,
      NSExtension: { NSExtensionPointIdentifier: 'com.apple.usernotifications.service' },
    });
  });
  it('fails closed for missing bundle ID, malformed entitlements or APNs mode', () => {
    expect(() => nativeOptions({})).toThrow();
    expect(() => nativeOptions(config, { appGroup: '../elsewhere' })).toThrow();
    expect(() => nativeOptions(config, { keychainGroup: 'unprefixed-group' })).toThrow();
    expect(() => nativeOptions(config, { environment: 'sandbox' })).toThrow();
  });
  it('adds one embedded extension and is idempotent against Expo’s real Xcode template', () => {
    const expoRequire = createRequire(require.resolve('expo/config-plugins'));
    const configRequire = createRequire(expoRequire.resolve('@expo/config-plugins'));
    const xcode = configRequire('xcode');
    const parser = configRequire('xcode/lib/parser/pbxproj');
    const template = execFileSync(
      'tar',
      [
        '-xOf',
        join(dirname(require.resolve('expo/package.json')), 'template.tgz'),
        'package/ios/HelloWorld.xcodeproj/project.pbxproj',
      ],
      { encoding: 'utf8' },
    );
    const project = xcode.project('/unused/project.pbxproj');
    project.hash = parser.parse(template);
    configureProject(project, config, nativeOptions(config));
    const first = project.writeSync();
    configureProject(project, config, nativeOptions(config));
    expect(project.writeSync()).toBe(first);
    const targets = Object.entries(project.pbxNativeTargetSection()).filter(
      ([id, target]: [string, unknown]) =>
        !id.endsWith('_comment') &&
        String((target as { name?: string }).name).includes('OpenBotsNotificationService'),
    );
    expect(targets).toHaveLength(1);
    expect(first).toContain('OpenBotsNotificationService.appex in Copy Files');
    expect(first).toContain('NotificationService.swift in Sources');
    expect(first).toContain('PrivacyInfo.xcprivacy in Resources');
    expect(first).toContain('APPLICATION_EXTENSION_API_ONLY = YES');
  });
  it('resolves the local Swift push-key module through Expo autolinking', () => {
    const expoRequire = createRequire(require.resolve('expo/package.json'));
    const autolinkingRoot = dirname(expoRequire.resolve('expo-modules-autolinking/package.json'));
    const output = execFileSync(
      process.execPath,
      [
        join(autolinkingRoot, 'bin/expo-modules-autolinking.js'),
        'resolve',
        '--platform',
        'apple',
        '--json',
      ],
      {
        cwd: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
        encoding: 'utf8',
      },
    );
    const result = JSON.parse(output) as {
      modules: { packageName: string; modules: { class: string }[] }[];
    };
    const module = result.modules.find((item) => item.packageName === 'openbots-native');
    expect(module?.modules).toContainEqual({ name: null, class: 'OpenBotsNativeModule' });
  });
});
