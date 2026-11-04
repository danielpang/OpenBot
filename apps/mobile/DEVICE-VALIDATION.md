# Native acceptance and M0 gate

Status: **not yet passed**. Unit/component tests, native project generation and a Hermes bundle export are available; no simulator/device performance or APNs success is inferred from them.

Android JS/export checks (including CI `expo export --platform all`) do not prove an emulator or physical-device run, a Gradle compile, or Play Store readiness. Encrypted push remains iOS-only because the relay is APNs-only. Do not treat those checks as an Android hardware gate pass.

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

## Authoring environment

Xcode 26.4 destination discovery was repaired by installing the matching iOS runtime. A native Debug build was installed and launched on an iPhone 17 Pro iOS 26.2 simulator, and the user confirmed development-build launch and live UI updates on a personal iPhone. These smoke checks do not establish the M0 performance, keyboard-animation, APNs, accessibility, or release-distribution gates. Maestro execution, TestFlight upload and App Store submission remain unverified.
