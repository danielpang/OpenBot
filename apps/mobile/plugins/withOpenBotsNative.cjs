const fs = require('node:fs');
const path = require('node:path');
const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins');
const plist = require('@expo/plist');

const TARGET = 'OpenBotsNotificationService';
const unquote = (value) => String(value ?? '').replace(/^"|"$/g, '');
const quoted = (value) => JSON.stringify(String(value));
const unique = (values) => [...new Set(values)];

function nativeOptions(config, options = {}) {
  const bundleId = config.ios?.bundleIdentifier;
  if (!bundleId || !/^[a-zA-Z0-9.-]+$/.test(bundleId)) {
    throw new Error('OpenBots native plugin requires ios.bundleIdentifier');
  }
  const appGroup = options.appGroup ?? `group.${bundleId}`;
  const keychainGroup = options.keychainGroup ?? `$(AppIdentifierPrefix)${bundleId}.push`;
  if (!/^group\.[a-zA-Z0-9.-]+$/.test(appGroup)) throw new Error('Invalid OpenBots App Group');
  if (!/^(\$\(AppIdentifierPrefix\)|[A-Z0-9]+\.)[a-zA-Z0-9.-]+$/.test(keychainGroup)) {
    throw new Error('Invalid OpenBots Keychain access group');
  }
  const environment = options.environment ?? 'development';
  if (!['development', 'production'].includes(environment))
    throw new Error('Invalid APNs environment');
  return { bundleId, appGroup, keychainGroup, environment };
}

function extensionInfo(config, options) {
  return {
    CFBundleDisplayName: 'OpenBots Notifications',
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundleName: '$(PRODUCT_NAME)',
    CFBundlePackageType: 'XPC!',
    CFBundleShortVersionString: config.version ?? '1.0.0',
    CFBundleVersion: config.ios?.buildNumber ?? '1',
    OpenBotsKeychainAccessGroup: options.keychainGroup,
    OpenBotsAppGroup: options.appGroup,
    NSExtension: {
      NSExtensionPointIdentifier: 'com.apple.usernotifications.service',
      NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).NotificationService',
    },
  };
}

function configureProject(project, config, options) {
  let target = Object.entries(project.pbxNativeTargetSection()).find(
    ([id, value]) => !id.endsWith('_comment') && unquote(value.name) === TARGET,
  );
  if (!target) {
    const added = project.addTarget(
      TARGET,
      'app_extension',
      TARGET,
      `${options.bundleId}.notifications`,
    );
    const group = project.addPbxGroup([], TARGET, TARGET);
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', added.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', added.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', added.uuid);
    project.addSourceFile('NotificationService.swift', { target: added.uuid }, group.uuid);
    project.addResourceFile('PrivacyInfo.xcprivacy', { target: added.uuid }, group.uuid);
    // Swift automatically links CryptoKit, Security and UserNotifications.
    target = [added.uuid, added.pbxNativeTarget];
  }
  const [, extension] = target;
  const appTarget = project.getFirstTarget().firstTarget;
  const lists = project.pbxXCConfigurationList();
  const configurations = project.pbxXCBuildConfigurationSection();
  const mainConfigRef = lists[appTarget.buildConfigurationList]?.buildConfigurations?.[0]?.value;
  const mainSettings = configurations[mainConfigRef]?.buildSettings ?? {};
  for (const reference of lists[extension.buildConfigurationList].buildConfigurations) {
    const settings = configurations[reference.value].buildSettings;
    Object.assign(settings, {
      INFOPLIST_FILE: quoted(`${TARGET}/Info.plist`),
      CODE_SIGN_ENTITLEMENTS: quoted(`${TARGET}/${TARGET}.entitlements`),
      PRODUCT_BUNDLE_IDENTIFIER: quoted(`${options.bundleId}.notifications`),
      IPHONEOS_DEPLOYMENT_TARGET: '17.0',
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: quoted('1,2'),
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      SKIP_INSTALL: 'YES',
      GENERATE_INFOPLIST_FILE: 'NO',
      CURRENT_PROJECT_VERSION: quoted(config.ios?.buildNumber ?? '1'),
      MARKETING_VERSION: quoted(config.version ?? '1.0.0'),
      CODE_SIGN_STYLE: mainSettings.CODE_SIGN_STYLE ?? 'Automatic',
    });
    if (config.ios?.appleTeamId || mainSettings.DEVELOPMENT_TEAM) {
      settings.DEVELOPMENT_TEAM = config.ios?.appleTeamId ?? mainSettings.DEVELOPMENT_TEAM;
    }
  }
  return project;
}

function withOpenBotsNative(config, rawOptions = {}) {
  const options = nativeOptions(config, rawOptions);
  config.ios ??= {};
  config.ios.privacyManifests = {
    ...config.ios.privacyManifests,
    NSPrivacyTracking: false,
    NSPrivacyTrackingDomains: [],
    NSPrivacyCollectedDataTypes: [],
  };
  // Advertise the target before prebuild so EAS can provision both App IDs.
  config.extra ??= {};
  config.extra.eas ??= {};
  config.extra.eas.build ??= {};
  config.extra.eas.build.experimental ??= {};
  config.extra.eas.build.experimental.ios ??= {};
  const extensions = config.extra.eas.build.experimental.ios.appExtensions ?? [];
  config.extra.eas.build.experimental.ios.appExtensions = [
    ...extensions.filter((extension) => extension.targetName !== TARGET),
    {
      targetName: TARGET,
      bundleIdentifier: `${options.bundleId}.notifications`,
      entitlements: {
        'com.apple.security.application-groups': [options.appGroup],
        'keychain-access-groups': [options.keychainGroup],
      },
    },
  ];
  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.security.application-groups'] = unique([
      ...(mod.modResults['com.apple.security.application-groups'] ?? []),
      options.appGroup,
    ]);
    mod.modResults['keychain-access-groups'] = unique([
      ...(mod.modResults['keychain-access-groups'] ?? []),
      options.keychainGroup,
    ]);
    mod.modResults['aps-environment'] = options.environment;
    return mod;
  });
  config = withInfoPlist(config, (mod) => {
    mod.modResults.OpenBotsKeychainAccessGroup = options.keychainGroup;
    mod.modResults.OpenBotsAppGroup = options.appGroup;
    return mod;
  });
  config = withDangerousMod(config, [
    'ios',
    async (mod) => {
      const root = mod.modRequest.projectRoot;
      const destination = path.join(mod.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(
        path.join(root, 'native', TARGET, 'NotificationService.swift'),
        path.join(destination, 'NotificationService.swift'),
      );
      fs.copyFileSync(
        path.join(root, 'native', 'PrivacyInfo.xcprivacy'),
        path.join(destination, 'PrivacyInfo.xcprivacy'),
      );
      fs.writeFileSync(
        path.join(destination, 'Info.plist'),
        plist.default.build(extensionInfo(mod, options)),
      );
      fs.writeFileSync(
        path.join(destination, `${TARGET}.entitlements`),
        plist.default.build({
          'com.apple.security.application-groups': [options.appGroup],
          'keychain-access-groups': [options.keychainGroup],
        }),
      );
      return mod;
    },
  ]);
  return withXcodeProject(config, (mod) => {
    mod.modResults = configureProject(mod.modResults, mod, options);
    return mod;
  });
}

module.exports = withOpenBotsNative;
module.exports.nativeOptions = nativeOptions;
module.exports.extensionInfo = extensionInfo;
module.exports.configureProject = configureProject;
