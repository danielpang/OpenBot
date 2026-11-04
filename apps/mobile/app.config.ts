import type { ConfigContext, ExpoConfig } from 'expo/config';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: packageVersion } = require('./package.json') as { version: string };
const releaseVersion = process.env.OPENBOTS_MOBILE_VERSION ?? packageVersion;
const version = releaseVersion.split('-')[0]!;
const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'OpenBots',
  slug: 'openbots',
  icon: './assets/icon.png',
  scheme: 'openbots',
  version,
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  platforms: ['ios', 'android'],
  runtimeVersion: { policy: 'appVersion' },
  ...(projectId
    ? {
        updates: { url: `https://u.expo.dev/${projectId}`, checkAutomatically: 'ON_LOAD' },
      }
    : { updates: { enabled: false } }),
  ios: {
    bundleIdentifier: process.env.OPENBOTS_IOS_BUNDLE_ID ?? 'dev.openbots.mobile',
    buildNumber: process.env.OPENBOTS_IOS_BUILD_NUMBER ?? '1',
    supportsTablet: true,
    associatedDomains: ['applinks:openbots.dev'],
    infoPlist: {
      ITSAppUsesNonExemptEncryption: true,
      NSFaceIDUsageDescription: 'Unlock your OpenBots servers and conversations.',
      NSCameraUsageDescription: 'Scan an OpenBots pairing code or attach a photo.',
      NSPhotoLibraryUsageDescription: 'Attach photos to a conversation with your Bots.',
    },
  },
  android: {
    package: process.env.OPENBOTS_ANDROID_PACKAGE ?? 'dev.openbots.mobile',
    versionCode: Number.parseInt(process.env.OPENBOTS_ANDROID_VERSION_CODE ?? '1', 10),
    adaptiveIcon: {
      foregroundImage: './assets/icon.png',
    },
    intentFilters: [
      {
        action: 'VIEW',
        category: ['BROWSABLE', 'DEFAULT'],
        data: [{ scheme: 'openbots' }],
      },
      {
        action: 'VIEW',
        autoVerify: true,
        category: ['BROWSABLE', 'DEFAULT'],
        data: [{ scheme: 'https', host: 'openbots.dev', path: '/pair' }],
      },
    ],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-sqlite',
    'expo-notifications',
    [
      'expo-camera',
      { cameraPermission: 'Scan an OpenBots pairing code.', recordAudioAndroid: false },
    ],
    [
      'expo-image-picker',
      { photosPermission: 'Attach photos to your Bots.', microphonePermission: false },
    ],
    ['expo-local-authentication', { faceIDPermission: 'Unlock your OpenBots conversations.' }],
    [
      'expo-build-properties',
      { android: { minSdkVersion: 24 }, ios: { deploymentTarget: '17.0' } },
    ],
    [
      './plugins/withOpenBotsNative.cjs',
      {
        environment:
          process.env.OPENBOTS_APNS_ENVIRONMENT === 'production' ? 'production' : 'development',
      },
    ],
  ],
  extra: {
    releaseVersion,
    apnsEnvironment:
      process.env.OPENBOTS_APNS_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    ...(projectId ? { eas: { projectId } } : {}),
    cloudUrl: process.env.EXPO_PUBLIC_OPENBOTS_CLOUD_URL ?? null,
  },
});
