// The native About panel defaults to Info.plist's version and build number,
// which shows "0.0.0 (0.0.0)" in an unstamped local build. Releases use the
// packaged version stamped from the release tag; local builds use a Git-tag
// baseline embedded at build time and are explicitly marked as development.
export function aboutPanelOptions(options: {
  packaged: boolean;
  appVersion: string;
  buildVersion: string;
}) {
  const release = options.packaged && options.appVersion !== '0.0.0';
  const version = release ? options.appVersion : options.buildVersion;
  return {
    applicationName: 'OpenBots',
    applicationVersion: release
      ? version
      : version === '0.0.0'
        ? 'Development build'
        : `${version} (development)`,
    // Suppress the native panel's duplicate parenthesized bundle build number.
    version: '',
    copyright: 'Copyright © OpenBots contributors',
  };
}
