# Native acceptance and M0 gate

Status: **not yet passed**. Unit/component tests, native project generation and a Hermes bundle export are available; no simulator/device performance or APNs success is inferred from them.

## Hardware spike

1. Use a signed development build on iPhone 12 (record iOS, app commit and build number).
2. Open `openbots://dev/transcript-spike` or navigate to `/dev/transcript-spike` in development. Run the 500-message transcript replay while scrolling; test keyboard interactions in a real conversation using the checklist below. Profile frame time with Instruments; record dropped frames and sustained 60fps behavior. Do not use the JS test duration as a frame-rate measurement.
3. Pair with a real Mac host that has no public URL. Confirm Noise pinning, relay HTTP and `/ws` subscriptions on Wi-Fi and cellular. Repeat after switching networks and after suspending the phone; compare all messages with the server after resync.
4. Complete the encrypted-push checklist in [maestro/push-device-checklist.md](maestro/push-device-checklist.md), including locked-device decryption and exact message/thread/host navigation.
5. Install an EAS preview build through TestFlight. Record provisioning for both App IDs, shared Keychain/App Group access, and OTA runtime matching.

## Functional pass

Walk pairing (QR, pasted link and universal link), invalid/expired/reused codes, password and API-key sign-in, multiple hosts, failed login, first owner setup, revoked device and no-network launch. Cached Bot and chat transcripts should be readable; sending and downloads must report that a connection is needed.

Send text, a photo and a document. Verify mention targeting, attachments received by a Bot, streaming reconnect/delta deduplication, threads and reactions. Answer every native widget and confirm the server records the exact action. Check Inbox requests from group chats and threads, including requests older than 100 messages and requests resolved elsewhere.

View Activity, run/enable/disable a Routine, preview an Artifact, and open the Bot screen preview. Confirm preview never permits keyboard/pointer control, all traffic works through relay mode, and backgrounding closes the preview socket. Artifact HTML is deliberately self-contained: external scripts/assets/network requests are blocked.

Use VoiceOver, large Dynamic Type, light/dark mode, reduced motion, hardware keyboard, native dictation, a small-screen phone and an iPad. Verify readable errors, retry, keyboard avoidance, touch targets and focus after navigation. Open from notifications when terminated and when app-locked; cancelling authentication must never issue a decision request.

## Chat composer / keyboard pass

- Tap the compact Message field: the composer should follow the keyboard with no jump or extra home-indicator gap. Repeat with predictive text and dictation enabled.
- Drag down through the transcript to dismiss the keyboard interactively; reverse the gesture halfway to cancel dismissal. The composer must remain attached to the keyboard throughout.
- Read older messages while a reply streams: keep the reading position, then use **Jump to latest message** to return. Repeat with the keyboard open.
- Type several lines (including large Dynamic Type); the field should grow up to its cap, then scroll internally without hiding the arrow send button.
- Use **+** to select a photo/file or insert a mention. Cancel the picker, remove an attachment, and send an attachment-only message. The keyboard should not dismiss when tapping Send.
- Confirm the arrow is announced as **Send** in VoiceOver, and that sending disables duplicate sends and attachment actions. Simulate a failed send and confirm the draft remains intact.
- Repeat in light/dark mode, landscape, Reduce Motion, with a hardware keyboard, and on iPad (including its floating keyboard). Automated component tests cover inset calculations and controls, not native frame pacing or gesture tracking.

## Liquid Glass acceptance

Run on an iOS 26+ iPhone and iPad, and an iOS 17/18 device or simulator. Build with Xcode 26+. These are manual acceptance checks, not assertions made by component tests.

- Verify the native **OpenBots / Inbox / Settings** tabs, selected SF Symbols, pending-count badge, tab reselection, and navigation back from a conversation. Pairing and offline server management must still work.
- Scroll each tab to both ends. Check the title clears the status bar and the final row clears the floating tab bar, with no doubled top/bottom safe area. Repeat in landscape and resized iPad windows.
- Scroll a conversation underneath the header and input. Confirm the native back/info controls float above content with a soft top scroll edge, and that the composer refracts the messages beneath it rather than sitting in a solid bottom strip. Tap **ⓘ** from both the Bot route and a direct chat link; both must open that Bot’s details. Group chats must still open membership controls.
- In light and dark appearances, inspect the composer, attachment menu, create button and jump-to-latest button. They should use native regular glass on iOS 26; message content and settings cards should not become glass. On older iOS, controls should have a legible opaque surface.
- Toggle **Reduce Transparency** and **Increase Contrast** while a draft is open. The custom material should become opaque immediately, without losing text, focus, attachments or cursor position. Turn settings off and verify glass returns. Check system tab adaptation as well.
- Repeat with **Reduce Motion**, VoiceOver and accessibility text sizes. The material itself must never receive accessibility focus; controls retain their labels and at least 44-point targets. The native tab bar remains expanded rather than adding scroll-triggered motion.
- Complete the composer/keyboard pass above, including mention suggestions, uploading/error states and long drafts. Test that glass layers do not swallow presses or block native text selection.
- Profile a long streaming conversation on physical hardware. Check scrolling and input responsiveness before treating the visual update as release-ready.

## Appearance preference acceptance

- Choose **Settings → Appearance → Dark** while iOS is Light, then reverse the combination. Check all tabs, navigation controls, message text, composer, keyboard, sheets and status bar. No white-on-white or dark-on-dark labels should appear.
- Relaunch and switch servers: the selected mode should persist. Change the device appearance while an explicit mode is selected; the app should retain its choice.
- Select **System**, then change iOS appearance while the app is open and while it is backgrounded. It should follow the system again. Repeat with Reduce Transparency and Increase Contrast enabled.
- Open attachment options and type a long multiline draft under each mode. Ensure the final message and jump-to-latest control remain above the measured composer and scroll indicators do not run underneath it.

## Authoring environment

Xcode 26.4 destination discovery was repaired by installing the matching iOS runtime. A native Debug build was installed and launched on an iPhone 17 Pro iOS 26.2 simulator, and the user confirmed development-build launch and live UI updates on a personal iPhone. These smoke checks do not establish the M0 performance, keyboard-animation, APNs, accessibility, or release-distribution gates. Maestro execution, TestFlight upload and App Store submission remain unverified.
