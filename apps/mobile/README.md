# OpenBots for iOS

Expo SDK 55 / React Native companion to the OpenBots server. The app lives in the pnpm workspace and uses the existing API client, event/widget schemas, avatars and Noise tunnel. Requires iOS 17 or later. No analytics or crash collection is configured.

## Run

From the repository root, using Node 22 and the pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm --filter @openbots/mobile prebuild
pnpm --filter @openbots/mobile ios
pnpm --filter @openbots/mobile dev
```

Use a development build, not Expo Go: the shared push-key module and Notification Service Extension are native targets. `ios/` is generated and ignored. `expo prebuild --platform ios --no-install` regenerates it without running CocoaPods. Full compilation needs a working Xcode installation, an installed iOS SDK and CocoaPods. Physical-device builds also need Apple provisioning for the app and extension.

Choose **Scan a QR code** to open the camera: pairing codes open pairing confirmation, and plain HTTPS server-origin codes prefill the sign-in form. Scanning a server URL does not bypass authentication. Choose **Enter manually** to type the server URL. The simulator cannot scan a physical QR code; use a pasted pairing link or enter the URL there.

Connect by scanning or pasting a five-minute pairing link from the desktop/server, or sign in to an HTTPS server with email/password. Password sign-in creates a one-use device pairing and discards the temporary session. API-key connection is also available, but push requires a paired device. Public and local direct URLs require HTTPS; private servers can use the encrypted relay without opening inbound ports.

### Shared relay

The default shared relay is **https://openbots-relay.fly.dev**. Encrypted tunnels use its WebSocket endpoint, `wss://openbots-relay.fly.dev`; this is not an OpenBots server address to enter in the sign-in form.

Pairing codes without a relay use this default, and previously paired hosts without a saved relay can fall back to it when direct HTTPS is unavailable. A custom relay explicitly included in a pairing code always takes precedence. The pairing confirmation shows the selected relay. Pinned server keys and device keys are still required; plain URL/API-key connections remain direct-only.

The host must register with the same relay. Configure the OpenBots server with:

```sh
OPENBOTS_RELAY_URL=wss://openbots-relay.fly.dev
```

Restart the server after configuring it, then generate a fresh pairing code. The iOS default does not configure or register the host automatically. Direct HTTPS remains preferred when reachable; relay traffic is encrypted end-to-end using the paired server key.

`EXPO_PUBLIC_OPENBOTS_CLOUD_URL` configures the managed-account sign-in destination. That option is disabled when unset. No hosted service URL is assumed.

### Clean release builds (no developer tools)

Development builds intentionally include Expo's launcher, floating Tools button, source explorer and developer menu. Release builds omit that development UI and bundle JavaScript into the app, so they do not need Metro.

To build and run the clean experience locally, from the repository root:

```sh
pnpm --filter @openbots/mobile ios:release --device YOUR_SIMULATOR_UUID
```

This replaces the development build on the selected simulator with a Release build. Use `pnpm --filter @openbots/mobile ios` to return to development mode.

For EAS builds, run these from `apps/mobile` with EAS CLI installed and configured:

```sh
eas build --platform ios --profile simulator-release # clean simulator .app
eas build --platform ios --profile preview           # TestFlight
eas build --platform ios --profile production        # App Store release
```

The release profiles explicitly disable `developmentClient`. Store builds still require Apple signing, EAS project configuration and the release prerequisites below; a simulator build cannot be submitted to the App Store.

### Open the workspace when building in Xcode

After generating `ios/` and installing CocoaPods, open the workspace from the repository root:

```sh
open apps/mobile/ios/OpenBots.xcworkspace
```

Do not open `OpenBots.xcodeproj` directly: it excludes the Pods project, causing missing `.modulemap` errors and `No such module 'Expo'`. Close the standalone project window and use the workspace window, which includes both **OpenBots** and **Pods** in the project navigator. Select the **OpenBots** scheme and your device, then build/run.

App icon changes require regenerating the native assets with `pnpm exec expo prebuild --platform ios` from `apps/mobile`, then rebuilding the native app; a Metro reload alone cannot update the installed icon.

### Xcode cannot find the simulator destination (exit 70)

The build SDK and simulator OS are separate. The installed iOS 26.4 SDK can be selected for a build targeting an existing iOS 26.2 simulator; do not change the app's minimum deployment target to select a simulator. First list available devices with `xcrun simctl list devices available`, then explicitly select the simulator SDK and the desired device from the repository root:

```sh
xcodebuild -workspace apps/mobile/ios/OpenBots.xcworkspace \
  -scheme OpenBots -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=YOUR_SIMULATOR_UUID' \
  build
```

Keep simulator signing enabled (Xcode uses local ad-hoc signing); disabling it can remove simulated Keychain entitlements and break secure storage. This is a diagnostic build command, not a workaround for every exit-70 failure. If Xcode still lists only an ineligible destination with `iOS 26.4 is not installed`, inspect **Xcode → Settings → Components** and the scheme's available destinations. The original Expo failure already named an iOS 26.2 device, so selecting that UUID again alone does not fix the underlying platform eligibility problem.

If installing an additional runtime is wanted, the command for an iOS 26.4 runtime on Apple silicon is:

```sh
xcodebuild -downloadPlatform iOS -buildVersion 26.4 -architectureVariant arm64
xcrun simctl list devices available
pnpm --filter @openbots/mobile ios --device
```

The command above targets Apple silicon. For an Intel Mac, use `-architectureVariant universal`. A reported Xcode 26.x issue can return `not available for download` when a version is specified without an explicit architecture variant ([developer report and workaround](https://developer.apple.com/forums/thread/812146)). If the specific version still cannot be found, use Xcode's Components settings to inspect the available downloads, or omit `-buildVersion` to let Xcode select its default iOS runtime.

Verified locally with Xcode 26.4: installing its matching iOS 26.4 runtime restored destination discovery, including the existing iPhone 17 Pro on iOS 26.2. OpenBots then built, installed and rendered its welcome screen on that existing simulator.

Wait for installation to finish, then choose an available simulator in Expo's device picker. If the download command itself reports `Unable to connect to simulator`, use Xcode's Components settings. This destination error happens before compilation; changing the app's deployment target or Apple signing team does not install the missing component.

## Included

- QR, custom-scheme and universal-link pairing; multiple saved hosts; independent Keychain credentials; revocable device registration.
- Direct HTTPS with encrypted relay fallback and pinned Noise keys; authenticated REST, realtime subscriptions and binary preview sockets.
- Bots, pinning, new Bots and groups, group membership, native FlashList transcripts, streaming markdown, threads, reactions, photos/files, mentions and native keyboard dictation.
- Native approval, question, sign-in and Routine widgets; Inbox scans all chat pages and groups, with a pending count.
- Bot activity, Routine controls, read-only About, image/text/HTML/PDF Artifacts and view-only noVNC preview. WebViews receive no owner key; preview has a single allowlisted socket and Artifacts cannot access the network or app bridge.
- SQLite roster/transcript snapshots, per-host cache isolation, reconnect resync, socket teardown in background, and Face ID/passcode lock on launch and after five minutes away.
- Direct APNs registration, encrypted notification decryption in Swift, exact conversation/thread links and authenticated approval actions; cached Bot avatar attachments.
- EAS development/simulator/TestFlight/production profiles and a `v*` release workflow. OTA is enabled only when an EAS project ID is configured, with runtime version pinned to the native app version.

## Validate

```sh
pnpm --filter @openbots/mobile test       # Vitest logic/integration + native RNTL components
pnpm --filter @openbots/mobile typecheck
pnpm --filter @openbots/mobile lint
pnpm --filter @openbots/mobile check:sdk
pnpm --filter @openbots/mobile build      # noVNC bundle, Metro export, Hermes bytecode
```

PR CI includes a separately named **iOS unit tests and bundle** job running SDK compatibility, typecheck, lint, Vitest logic/integration tests, Jest native component tests, and the iOS/Hermes export on Linux. The workspace-wide `pnpm test` also includes both mobile suites. These are automated JavaScript/component checks, not a native Xcode or physical-device test run.

Tests exercise real encrypted tunnel HTTP, native fetch-stream compatibility, pairing/sign-in, credential origin isolation, cache/lifecycle races, transcript delta gaps and resync pagination, widget actions/composer, push encryption and routing, native target generation/autolinking, and the preview bridge. They do not establish device frame rate, APNs delivery, WKWebView rendering or App Store acceptance.

The development-only `/dev/transcript-spike` route provides 500 messages with replayed markdown deltas for the M0 hardware gate. Maestro flows live in `maestro/`. Run the performance and push checks in [DEVICE-VALIDATION.md](DEVICE-VALIDATION.md) on an iPhone 12 and a signed physical device before external TestFlight. The M0 gate remains open until those checks pass.

## Release configuration

See `.github/workflows/release-mobile.yml` and `eas.json`. Configure an EAS project, Apple app/team identifiers, App Store Connect credentials, and provisioning for `dev.openbots.mobile` plus `dev.openbots.mobile.notifications` (or your configured bundle prefix). The plugin supplies EAS extension metadata and shared Keychain/App Group entitlements. Configure the associated-domain file on `openbots.dev` for your team and app ID before relying on universal links; QR scans and the custom scheme work independently.

The version bump script updates the root, desktop and mobile packages together. Release build numbers come from the workflow run and attempt. Missing release credentials produce only a JavaScript export; a partially configured signing environment fails rather than implying a signed build. No upload or submission happens during local development.

## Remaining release work

- Complete the physical M0 gate, VoiceOver/Dynamic Type review and Maestro server-backed flows. Native Debug build, installation and welcome-screen launch have been verified on the iPhone 17 Pro iOS 26.2 simulator with Xcode 26.4. Physical camera scanning, APNs delivery and authenticated server-backed flows still require device/server validation.
- Provision EAS/Apple credentials, register export compliance for the custom tunnel crypto, configure universal links, supply App Store screenshots/support URL and a working reviewer demo server, then run TestFlight and App Review.
- Maintain the Expo tooling security overrides: patched Zod 4, Glob and esbuild versions, plus the local deepmerge prototype-poisoning fix until upstream publishes a patched release. Installed-package regression tests cover Expo schema compatibility and deepmerge; `docs/SECURITY.md` records the scoped audit exception for the local patch. Markdown, linkifier and URL-decoder dependencies also use patched versions. Recheck all overrides on Expo upgrades.
- A fresh ownerless server can be paired with an owner name; provider/model credentials and first-run setup still finish on the desktop. The mobile app can create Bots once the server is configured.
- Per-kind push preference controls, device rename and account revocation UI beyond forgetting the local host remain follow-up work. Revocation is available in the server's Devices settings.
- Share extension, App Intents, WidgetKit, Live Activities, Android shipping, and the separate responsive web redesign are not part of this first native implementation.

The minimum server version is currently `0.0.0`, matching the repository's development release. New optional routes (notably approvals) tolerate 404; capabilities without a version remain usable. Raise `OLDEST_SERVER_VERSION` with an explicit server compatibility decision when releases become versioned.
