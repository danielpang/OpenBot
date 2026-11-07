// What the build tells the app (plan 14.4). A release build sets
// OPENBOTS_CLOUD_URL, the hosted OpenBots server behind "Sign in to an OpenBots
// account", and electron-builder.publish.cjs writes it into the packaged
// package.json as `openbots.cloudUrl`. A development run reads the variable
// itself. Without it the choice is shown, but disabled.

/** Side-by-side previews must not claim production deep links or Docker resources. */
export function isPreviewBuild(packageJson: unknown): boolean {
  return (packageJson as { openbots?: { preview?: unknown } } | null)?.openbots?.preview === true;
}

/** The hosted server's origin when `value` is an https URL (http only for this Mac, in development). */
export function parseCloudUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.origin;
}

/**
 * The cloud URL: the packaged app's from its package.json, a development
 * run's from the environment. A packaged app ignores the environment, so a
 * variable set on the Mac cannot send the account sign-in to another server.
 */
export function cloudUrl(options: {
  packaged: boolean;
  packageJson?: unknown;
  env: NodeJS.ProcessEnv;
}): string | null {
  if (!options.packaged) return parseCloudUrl(options.env.OPENBOTS_CLOUD_URL);
  const config = (options.packageJson as { openbots?: { cloudUrl?: unknown } } | null)?.openbots;
  return parseCloudUrl(config?.cloudUrl);
}
