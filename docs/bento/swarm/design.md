# Android Expo companion

The person asked for an Android app using Expo, matching the existing iOS Expo companion. There is no second app to create. `apps/mobile` is already the Expo project; it is gated to iOS today.

## Current state (main / this branch)

- `apps/mobile/app.config.ts` line 19: `platforms: ['ios']`.
- Scripts, EAS, CI, and the native module are iOS-only (`OpenBotsNative` is Swift; the notification service is an iOS app extension).
- Pairing POST hardcodes `platform: 'ios'` in `apps/mobile/src/hosts/pairing.ts`.
- `registerDevicePush` returns `'unsupported'` when `Platform.OS !== 'ios'`.
- Server and shared schema already allow `platform: 'ios' | 'android' | 'desktop'`.
- The hosted relay sends push only through APNs. There is no FCM implementation.

## What to build

Same Expo package, second platform.

1. **Project.** Add `android` to `platforms`. Set `android.package` from `OPENBOTS_ANDROID_PACKAGE` defaulting to `dev.openbots.mobile`, `versionCode` from `OPENBOTS_ANDROID_VERSION_CODE` defaulting to `1`, adaptive icon from `./assets/icon.png`, and intent filters for the `openbots` scheme plus `https://openbots.dev/pair` App Links (path `/pair`). Keep the existing iOS block, APNs plugin, and NSE wiring unchanged. Extend `expo-build-properties` with an Android min SDK (use Expo SDK 55's default unless a higher floor is required; do not lower the iOS 17 deployment target).
2. **Scripts and EAS.** Add `android` / `android:release` / `prebuild:android` next to the iOS scripts. Keep `prebuild` as iOS so a Mac without the Android SDK still works. Change `build` so it exports both platforms (for example `expo export --platform all`) after `build-preview.mjs`, so the existing CI mobile job covers Android. Add Android fields on the existing EAS profiles. Do not require Play Console secrets.
3. **Runtime.** `pairHost` sends `platform: Platform.OS === 'android' ? 'android' : 'ios'`. Update `pairing.test.ts` so the existing case still expects `ios` and a new case (or a parameterized one) expects `android` when `Platform.OS` is mocked. App-lock failure text in `appLock.ts` must not say "iOS Settings". Settings and sign-in defaults that say "iOS Settings", "Face ID", or default the device name to "My iPhone" must be platform-aware (`settings.tsx`, `provider.tsx` sign-in default, onboarding already uses "My phone" off iOS). Leave `registerDevicePush` returning `'unsupported'` on Android; add or extend a test so that cannot regress into a fake APNs registration.
4. **CI and docs.** The `mobile` job in `.github/workflows/ci.yml` must keep SDK/typecheck/lint/test and must export Android as well as iOS. README should document Android run/prebuild/EAS commands and state that encrypted push remains iOS-only because the relay is APNs-only. Do not claim Play Store or FCM support.

## Out of scope

- FCM, a Kotlin notification listener, Android Keystore push-key sharing, or any relay/server push change.
- Play Store listing, signing setup, or a new GitHub release workflow for Play.
- A separate Android app package or new screens.
- Changing iOS APNs, the Notification Service Extension, or `withOpenBotsNative.cjs` iOS behavior.

## Finished looks like

`pnpm --filter @openbots/mobile test`, `typecheck`, and `lint` pass. `pnpm --filter @openbots/mobile build` exports iOS and Android. Existing iOS native-plugin tests still pass. An Android developer can `prebuild:android` and `android` the same way iOS uses `prebuild` and `ios`.

## Review bar

Each leaf must do what this note asked, cover new behavior with tests, introduce no bugs a reviewer can name with file and line, and read clearly. If owner-visible UI copy or layout changes, attach a screenshot artifact.