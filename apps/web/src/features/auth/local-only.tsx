import { AuthCard } from './auth-form.js';

// /sign-in and /sign-up when the Mac app signs the owner in itself (auth
// `local`): there is nothing to fill in. The app's main process signs the
// window in again whenever it lands here, so this shows only in a browser.

export const LOCAL_ONLY_TITLE = 'Open OpenBots from the Mac app';

export function LocalOnly() {
  return (
    <AuthCard title={LOCAL_ONLY_TITLE}>
      <p className="text-center text-sm text-muted-foreground">
        This OpenBots server runs on your Mac, and the app signs you in.
      </p>
    </AuthCard>
  );
}
