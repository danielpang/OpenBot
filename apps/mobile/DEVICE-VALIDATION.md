# Native acceptance and M0 gate

Status: **not yet passed**. Unit/component tests, native project generation and a Hermes bundle export are available; no simulator/device performance or APNs success is inferred from them.

## Hardware spike

1. Use a signed development build on iPhone 12 (record iOS, app commit and build number).
2. Open `openbots://dev/transcript-spike` or navigate to `/dev/transcript-spike` in development. Run the 500-message transcript replay while scrolling and using the keyboard. Profile frame time with Instruments; record dropped frames and sustained 60fps behavior. Do not use the JS test duration as a frame-rate measurement.
3. Pair with a real Mac host that has no public URL. Confirm Noise pinning, relay HTTP and `/ws` subscriptions on Wi-Fi and cellular. Repeat after switching networks and after suspending the phone; compare all messages with the server after resync.
4. Complete the encrypted-push checklist in [maestro/push-device-checklist.md](maestro/push-device-checklist.md), including locked-device decryption and exact message/thread/host navigation.
5. Install an EAS preview build through TestFlight. Record provisioning for both App IDs, shared Keychain/App Group access, and OTA runtime matching.

## Functional pass

Walk pairing (QR, pasted link and universal link), invalid/expired/reused codes, password and API-key sign-in, multiple hosts, failed login, first owner setup, revoked device and no-network launch. Cached Bot and chat transcripts should be readable; sending and downloads must report that a connection is needed.

Send text, a photo and a document. Verify mention targeting, attachments received by a Bot, streaming reconnect/delta deduplication, threads and reactions. Answer every native widget and confirm the server records the exact action. Check Inbox requests from group chats and threads, including requests older than 100 messages and requests resolved elsewhere.

View Activity, run/enable/disable a Routine, preview an Artifact, and open the Bot screen preview. Confirm preview never permits keyboard/pointer control, all traffic works through relay mode, and backgrounding closes the preview socket. Artifact HTML is deliberately self-contained: external scripts/assets/network requests are blocked.

Use VoiceOver, large Dynamic Type, light/dark mode, reduced motion, hardware keyboard, native dictation, a small-screen phone and an iPad. Verify readable errors, retry, keyboard avoidance, touch targets and focus after navigation. Open from notifications when terminated and when app-locked; cancelling authentication must never issue a decision request.

## Authoring environment

The local Xcode installation failed before compilation while loading `IDESimulatorFoundation`, reporting an incompatible symbol in `DVTDownloads`. No signed app build, simulator launch, Maestro execution, physical-device gate, TestFlight upload or App Store submission was completed. The notification Swift source did pass a standalone simulator-SDK typecheck. Repair/select a working Xcode installation before the native acceptance run.
