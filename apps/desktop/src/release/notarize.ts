import { join } from 'node:path';
import type {
  NotarizeOptions,
  NotaryToolApiKeyCredentials,
  NotaryToolPasswordCredentials,
} from '@electron/notarize';

// electron-builder `afterSign` hook (electron-builder.yml): notarizes the signed
// .app with @electron/notarize before the DMG and zip are made, so both carry
// a stapled ticket. Credentials come from CI secrets as environment variables,
// the same names electron-builder's own integration reads (that integration is
// turned off with `mac.notarize: false` so it does not run twice):
//
//   App Store Connect API key (preferred):
//     APPLE_API_KEY      path to the AuthKey_XXXX.p8 file
//     APPLE_API_KEY_ID   key ID
//     APPLE_API_ISSUER   issuer UUID (team keys)
//   or Apple ID:
//     APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
//
// With neither set the build is left un-notarized (the unsigned dev build),
// unless OPENBOTS_REQUIRE_NOTARIZATION=1, which the release workflow sets so a
// missing secret fails the release instead of shipping an app Gatekeeper blocks.

export type NotarizeCredentials = NotaryToolApiKeyCredentials | NotaryToolPasswordCredentials;

export function notarizeCredentials(env: NodeJS.ProcessEnv): NotarizeCredentials | null {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = env;
  if (APPLE_API_KEY && APPLE_API_KEY_ID) {
    return {
      appleApiKey: APPLE_API_KEY,
      appleApiKeyId: APPLE_API_KEY_ID,
      ...(APPLE_API_ISSUER ? { appleApiIssuer: APPLE_API_ISSUER } : {}),
    };
  }
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = env;
  if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    return {
      appleId: APPLE_ID,
      appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
      teamId: APPLE_TEAM_ID,
    };
  }
  return null;
}

/** The subset of electron-builder's AfterPackContext the hook reads. */
export interface AfterSignContext {
  electronPlatformName: string;
  appOutDir: string;
  packager: { appInfo: { productFilename: string } };
}

export interface AfterSignDeps {
  env?: NodeJS.ProcessEnv;
  notarize?: (options: NotarizeOptions) => Promise<void>;
  log?: (message: string) => void;
}

export async function notarizeApp(context: AfterSignContext, deps: AfterSignDeps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((message: string) => console.log(`  • ${message}`));
  if (context.electronPlatformName !== 'darwin') return;

  const credentials = notarizeCredentials(env);
  if (credentials == null) {
    if (env.OPENBOTS_REQUIRE_NOTARIZATION === '1') {
      throw new Error(
        'Notarization credentials are missing: set APPLE_API_KEY, APPLE_API_KEY_ID and ' +
          'APPLE_API_ISSUER, or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.',
      );
    }
    log('skipping notarization: no Apple credentials in the environment');
    return;
  }

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const notarize = deps.notarize ?? (await import('@electron/notarize')).notarize;
  log(`notarizing ${appPath}`);
  await notarize({ appPath, ...credentials });
  log('notarized and stapled');
}

export default function afterSign(context: AfterSignContext): Promise<void> {
  return notarizeApp(context);
}
