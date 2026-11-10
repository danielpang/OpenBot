# iOS app notes

Liquid Glass details and open release work for the iPhone and iPad app, moved from [apps/mobile/README.md](../../apps/mobile/README.md).

## Liquid Glass

On iOS 26+, OpenBots uses UIKit's native floating tab bar with SF Symbols and the existing Inbox badge. Chat headers let messages scroll beneath native glass navigation controls, with a soft system scroll-edge effect protecting the title. Bot details use the native `info.circle` button; group membership uses `person.2`. The composer, attachment menu, create control and jump-to-latest control use `expo-glass-effect`'s **regular** native material. The composer floats over the transcript rather than occupying an opaque strip below it; measured scroll padding keeps the final message and scroll indicator clear of multiline drafts and attachment menus. Message cards, approval content, search fields and settings stay opaque; glass is reserved for navigation and controls, following [Apple's adoption guidance](https://developer.apple.com/documentation/technologyoverviews/liquid-glass).

- Build with **Xcode 26 or later** to see Liquid Glass. iOS 17 remains the deployment target: earlier systems retain their native tab bar and opaque custom controls.
- `src/components/glass.tsx` centralizes capability checks and live accessibility preferences. Reduce Transparency or Increase Contrast selects opaque custom surfaces. Material layers do not intercept touches or appear in VoiceOver, and changing preferences does not remount the composer input. Custom glass adds no morphing/scale animations; system tab animations follow iOS accessibility settings.
- The native tabs own scroll-view safe-area adjustments. Do not wrap the tab navigator in another safe-area inset or give its bar an opaque background. Scrollable pages use automatic content inset adjustment so the final row remains reachable above the floating bar.
- Rebuild the development client after installing dependencies: `pnpm --filter @openbots/mobile prebuild`, then `pnpm --filter @openbots/mobile ios`. A JavaScript reload alone is not a native rebuild. For an OTA release, bump the native app version/runtime before publishing a bundle requiring changed native dependencies.

See the Liquid Glass checks in [DEVICE-VALIDATION.md](../../apps/mobile/DEVICE-VALIDATION.md) for the device acceptance matrix.

## Remaining release work

- Complete the physical M0 gate, VoiceOver/Dynamic Type review and Maestro server-backed flows. Native Debug build, installation and welcome-screen launch have been verified on the iPhone 17 Pro iOS 26.2 simulator with Xcode 26.4. Physical camera scanning, APNs delivery and authenticated server-backed flows still require device/server validation.
- Provision EAS/Apple credentials, register export compliance for the custom tunnel crypto, configure universal links, supply App Store screenshots/support URL and a working reviewer demo server, then run TestFlight and App Review.
- Maintain the Expo tooling security overrides: patched Zod 4, Glob and esbuild versions, plus the local deepmerge prototype-poisoning fix until upstream publishes a patched release. Installed-package regression tests cover Expo schema compatibility and deepmerge; `pnpm-workspace.yaml` records the scoped audit exception for the local patch. Markdown, linkifier and URL-decoder dependencies also use patched versions. Recheck all overrides on Expo upgrades.
- A fresh ownerless server can be paired with an owner name; provider/model credentials and first-run setup still finish on the desktop. The mobile app can create Bots once the server is configured.
- Per-kind push preference controls, device rename and account revocation UI beyond forgetting the local host remain follow-up work. Revocation is available in the server's Devices settings.
- Share extension, App Intents, WidgetKit, Live Activities, Android shipping, and the separate responsive web redesign are not part of this first native implementation.

The minimum server version is currently `0.0.0`, matching the repository's development release. New optional routes (notably approvals) tolerate 404; capabilities without a version remain usable. Raise `OLDEST_SERVER_VERSION` with an explicit server compatibility decision when releases become versioned.
