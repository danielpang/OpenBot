# OpenBots iOS app plan

A companion to [MOBILE_AND_VM_PLAN.md](MOBILE_AND_VM_PLAN.md), which defines what the app talks to (devices and pairing, the relay, push) and what it must do (M1 to M10). This document weighs the ways to build the app, picks one, and lays out the build.

Sections 1 to 4 compare the options and make the choice. Sections 5 to 8 are the plan for the chosen stack.

---

## 1. What the app has to do

Technical needs, from M1 to M10 and sections 4 to 7 of the main plan, in the order they shape the technology choice:

| #   | Need                                                                                                                                                                                                                                     | Where it comes from   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| N1  | Speak the REST API (about 25 of the OpenAPI routes) and `/ws` (subscribe, events, resync) over two transports: direct https, and the end-to-end encrypted tunnel over the relay's WebSocket                                              | M1, M3, M6, plan 5    |
| N2  | Render a transcript of parts (markdown text, images, files, tool calls, reasoning, widgets, events, Artifact cards, Skill references), streaming deltas as they arrive, with threads and reactions, at 60 fps on a phone a few years old | M4, plan 4.2 and 14.2 |
| N3  | Compose with `@` mentions, photos, files and dictation                                                                                                                                                                                   | M4                    |
| N4  | Answer approvals, questions and sign-in requests in place, and list them in an Inbox                                                                                                                                                     | M4                    |
| N5  | Pair by QR code; hold three secrets (the device key, the Noise static key, the push key) in the Keychain, device-only, one of them shared with the notification extension                                                                | M2, plan 4.5          |
| N6  | Push: register the APNs token; a Notification Service Extension that decrypts the payload (ChaCha20-Poly1305), sets the title and body, attaches the Bot's avatar, and opens the exact message                                           | M5, plan 6            |
| N7  | Screen preview (the view-only noVNC canvas) and HTML Artifacts, which are web code, carried through the tunnel                                                                                                                           | M8                    |
| N8  | Behave in the background: no socket, resync on return, a local cache so transcripts open at once                                                                                                                                         | M6, plan 7.4          |
| N9  | Later: a share extension, App Intents for Siri, a WidgetKit widget, a Live Activity. These are Swift-only APIs whichever stack is chosen                                                                                                 | M9                    |
| N10 | Ship: TestFlight and the App Store from the same `v*` tag as the images and the Mac app; tolerate older self-hosted servers (a route that is missing answers 404, as the Mac app's main process already handles for `GET /approvals`)    | M1, plan 7.1          |
| N11 | Be maintainable by the people who maintain the rest: a TypeScript monorepo (server, web, Mac app, shared packages), one or two people, working with coding agents                                                                        | Plan section 3        |

---

## 2. Options

### 2.1 Expo (React Native, managed workflow with config plugins)

| Need   | How it is met                                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N1     | `@openbots/api-client` as is (its `fetch` and `createSocket` are injected), `@openbots/shared` for the event and part schemas, `packages/tunnel` (pure TypeScript on `@noble/*`) shared with the server's relay adapter. One Noise implementation, tested once     |
| N2     | FlashList for the transcript, a markdown renderer (`react-native-markdown-display` or a renderer over `@openbots/shared`'s parts), Reanimated for the avatar states, `react-native-svg` for `packages/avatars`                                                     |
| N3, N4 | Native text input with a mention picker, `expo-image-picker`, `expo-document-picker`; widgets rendered natively from the `@openbots/widgets` schemas                                                                                                               |
| N5     | `expo-camera` for the QR; `expo-secure-store` with a Keychain access group set by a config plugin so the extension reads the push key                                                                                                                              |
| N6     | `expo-notifications` for the token; the extension is a Swift target added by a config plugin (about 150 lines of Swift with CryptoKit), as Expo apps with rich notifications do today                                                                              |
| N7     | `react-native-webview` with a WebSocket shim bridged over `postMessage` to the tunnel                                                                                                                                                                              |
| N8     | `expo-sqlite` for the cache; `expo-background-task` not relied on                                                                                                                                                                                                  |
| N9     | Each is a Swift target or an Expo module: a share extension (config plugin), App Intents (Expo's `expo-app-intents` or a small module), WidgetKit and ActivityKit through community modules or a module of our own. Native code either way, inside an Expo project |
| N10    | EAS Build and Submit; `expo-updates` for JavaScript-only fixes within a release line; the native build number from the tag                                                                                                                                         |
| N11    | TypeScript, the monorepo's packages, the same test runner (vitest for logic), coding agents at home                                                                                                                                                                |

For: one implementation of the client, the protocol and the notices, shared with the server and the Mac app and covered by their tests; the fastest path to an MVP for this team; Android from the same code when wanted; EAS takes over signing, builds and submission; OTA fixes for a client that has to work against many server versions.

Against: a JavaScript runtime and a 30 to 40 MB binary; list and animation work needs care to feel native (it can, as Paseo's app shows); the Expo SDK moves yearly with Xcode and iOS, so an upgrade is due about once a year; everything in N9 is Swift anyway, so the "one language" claim holds for the app's core, not its extensions.

### 2.2 Bare React Native

The same reuse as Expo, with the Xcode and Gradle projects owned by hand: native changes are edits to those projects instead of config plugins, upgrades go through the React Native upgrade helper, and builds need fastlane or Xcode Cloud unless EAS is added back.

For: no dependency on the Expo SDK's release cycle; every native setting is in plain sight.

Against: everything this app needs from native (N5, N6, N9) works inside an Expo project through config plugins and Expo modules, so bare React Native keeps the costs of React Native and drops the parts Expo automates. It is the right choice when a project must escape Expo, and nothing here needs to.

### 2.3 SwiftUI (native)

| Need   | How it is met                                                                                                                                                                                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1     | Apple's `swift-openapi-generator` from `apps/server/openapi.json` (the server already keeps it current in CI), with a custom `ClientTransport` for the tunnel, which the generator's design allows cleanly. `/ws` events as `Codable` enums written by hand from `packages/shared/src/events.ts` (about 20 event types) and the resync logic reimplemented |
| N1     | The Noise handshake with CryptoKit: X25519, ChaCha20-Poly1305 and SHA-256 are all there, so the suite is `Noise_IK_25519_ChaChaPoly_SHA256` (the main plan is updated to that suite, so both stacks can speak it). `URLSessionWebSocketTask` for the relay and `/ws`                                                                                       |
| N2     | `List` or `UICollectionView` through a representable, `swift-markdown-ui` for text, the parts and widget schemas reimplemented as `Codable` types                                                                                                                                                                                                          |
| N3, N4 | SwiftUI, PhotosPicker, the document picker, native dictation for free                                                                                                                                                                                                                                                                                      |
| N5     | `AVFoundation` or `DataScannerViewController` for the QR; the Keychain and its access group directly                                                                                                                                                                                                                                                       |
| N6     | The extension in the same project and language                                                                                                                                                                                                                                                                                                             |
| N7     | `WKWebView`, with the same `postMessage` bridge                                                                                                                                                                                                                                                                                                            |
| N8     | SwiftData or GRDB                                                                                                                                                                                                                                                                                                                                          |
| N9     | First class: share extension, App Intents, WidgetKit, ActivityKit                                                                                                                                                                                                                                                                                          |
| N10    | Xcode Cloud or fastlane on a macOS runner (the Mac app's release workflow already runs one)                                                                                                                                                                                                                                                                |
| N11    | A second language and toolchain; Xcode projects, provisioning and simulators are slower ground for agents than a TypeScript package, though workable                                                                                                                                                                                                       |

For: the best iOS app of the options: native scrolling, keyboard and haptics with no tuning, the smallest binary and the lowest battery use, and every platform feature in N9 in reach without a bridge. No runtime between the app and the OS. No SDK treadmill beyond Xcode's.

Against: a second implementation of the event protocol, parts, widget schemas, notices and resync rules (about 2,000 to 3,000 lines of Swift) that must be kept in step with `packages/shared` by hand, with no shared tests. Mitigations exist: generate the REST client from the OpenAPI document in CI and fail when it changes; export JSON fixtures from `packages/shared`'s tests (events, parts, notices) and replay them in XCTest. They reduce the drift; they do not remove the second implementation. Android would be a third. Slower to an MVP for this team.

### 2.4 A web shell: Capacitor, or a SwiftUI shell with `WKWebView`, around `apps/web`

Wrap the existing React web app in a native shell with plugins for push, the camera, the Keychain and the share sheet. The tunnel runs in JavaScript inside the WebView (the same `packages/tunnel`), noVNC and Artifacts run as they do on the desktop, and the web app gains the responsive layout it lacks today (its sidebar and right panel are a desktop layout).

For: the fastest to something usable; one UI for web, Mac and phone; the responsive pass also gives the PWA that D4 lists; Android for free.

Against: a WebView transcript does not scroll, bounce, avoid the keyboard or vibrate like a native one, and that is the whole app; the Keychain-to-WebView bridge for the keys is awkward; the extension is still Swift; offline caching needs its own work; App Review's "minimum functionality" rule (4.2) is a risk for a wrapped site, lessened by native push, camera and share. Paseo's own line, "a full client and native, not a WebView", is the right bar for a phone app whose use is chat.

Verdict: not the app. The responsive pass on `apps/web` is worth doing on its own for tablets, phones in a browser and the PWA, and nothing in it is wasted whichever app is built.

### 2.5 Flutter, Kotlin Multiplatform

A third language (Dart or Kotlin) with none of the monorepo's code and no advantage over the options above for this team. Not considered further.

---

## 3. Comparison

How each option meets the needs (5 is best):

| Criterion                                     | Weight |   Expo | Bare RN | SwiftUI | Web shell |
| --------------------------------------------- | -----: | -----: | ------: | ------: | --------: |
| Reuse of the monorepo (N1, N11)               |      3 |      5 |       5 |       1 |         5 |
| Native feel of the chat (N2, N3)              |      3 |      4 |       4 |       5 |         2 |
| Platform features (N5, N6, N9)                |      2 |      3 |       3 |       5 |         2 |
| Tunnel and crypto effort (N1)                 |      1 |      4 |       4 |       4 |         3 |
| Build, signing and release (N10)              |      1 |      5 |       3 |       4 |         4 |
| Maintenance over years                        |      2 |      3 |       2 |       4 |         4 |
| Velocity for this team, agents included (N11) |      2 |      5 |       4 |       3 |         5 |
| Android later                                 |      1 |      5 |       5 |       1 |         5 |
| App Review risk                               |      1 |      5 |       5 |       5 |         3 |
| Time to an MVP                                |      2 |      4 |       3 |       3 |         5 |
| **Weighted total (of 90)**                    |        | **76** |      68 |      62 |        68 |

The total is the weights, so here is what moves it. With reuse weighted 1 and Android 0, and native feel and platform features weighted 3 each, SwiftUI and Expo tie at 64. That is the honest shape of the decision: **Expo wins on shared code, Android and speed; SwiftUI wins on fidelity and platform depth; nothing else separates them much.** Bare React Native is Expo with more upkeep, and the web shell is quick but not the app.

---

## 4. The choice

**Expo, with a Swift native layer, gated by a spike.**

Why: the project's shape. One TypeScript monorepo whose client, protocol, notices and tunnel the app can import rather than rewrite; a Mac app that already took "one UI stack" over native (plan section 3); a team of one or two working with agents, for whom a second language and toolchain is the largest cost on the list; and Android for free later. The extensions in N9 are Swift in either case, so the choice is about the app's core, and the core is a chat client whose logic already exists in TypeScript.

What would flip it to SwiftUI, and should be decided now rather than after the MVP:

1. Android is ruled out for good, and
2. the owner rates native fidelity and platform depth above shared code (section 3's reweighing), or
3. the spike below fails.

The spike (milestone M0 in section 7, two weeks) builds the three things React Native could get wrong before any screen exists: the Noise tunnel through the relay from the phone, a transcript of 500 messages streaming markdown at 60 fps on an iPhone 12, and the extension decrypting a push with a key from the shared Keychain. If any fails without a fix inside the spike, the app is built in SwiftUI from section 2.3's table, and nothing from the spike but the lesson is lost.

---

## 5. Architecture

`apps/mobile`, a workspace package like `apps/desktop`:

```
apps/mobile/
  app/                       expo-router routes
    (onboarding)/            welcome, pair (QR), sign-in by address, account sign-in
    (tabs)/bots, inbox, settings
    bot/[id]/                transcript, activity, preview, artifacts, routines, about
    chat/[id]/               a group's transcript
  src/
    hosts/                   the host store (saved servers, the active one), Keychain access
    transport/               direct (fetch, WebSocket) and tunnel (packages/tunnel) transports, path selection
    api/                     createClient and createWsClient wiring, query hooks lifted from apps/web/src/app/api.ts
    transcript/              part renderers, widget renderers, the composer
    notices/                 the shared watcher driving in-app banners and badge counts
    cache/                   expo-sqlite: messages by chat and seq, Bots, chats, pending approvals
    native/                  the Expo module that hands the push key to the extension's Keychain group
  ios/                       generated by prebuild; the OpenBotsNotificationService target
  plugins/                   config plugins: Keychain access group, the extension target, associated domains
```

| Concern         | Choice                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transports      | `createDirectTransport(url, key)` and `createTunnelTransport(host)` both give `{fetch, createSocket}`; `packages/tunnel` turns `http.req`/`http.body`/`http.res` frames into a `Response` with a streaming body, and `ws.*` frames into the `WebSocketLike` the WS client wants. Path selection as plan 5.6                                                                   |
| State           | TanStack Query with the web app's query keys and its event-to-invalidation rules (`apps/web/src/app/api.ts`), so a `message.delta` patches the cached transcript the same way                                                                                                                                                                                                 |
| Transcript      | FlashList, inverted, keyed by message id; each part a memoized native view; markdown streamed by re-rendering the last message only; images through `expo-image` with the device key in the request headers                                                                                                                                                                   |
| Widgets         | Native renderers for `question`, `login_request`, `approval` and `routine_run` from the `@openbots/widgets` schemas; any other kind shows its title and "Open on the desktop"                                                                                                                                                                                                 |
| Theme           | The colour and type tokens from `@openbots/ui` exported as a JavaScript object and used with `StyleSheet`; no Tailwind runtime on the phone until NativeWind supports Tailwind v4 cleanly. Dark mode follows the system                                                                                                                                                       |
| Avatars         | `packages/avatars` renders SVG; `react-native-svg` draws it and Reanimated plays the `bot.state` motion                                                                                                                                                                                                                                                                       |
| Keychain        | `expo-secure-store` with `keychainAccessGroup` and `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; the push key also written by the native module into the group the extension reads                                                                                                                                                                                                        |
| Push            | `expo-notifications` for permission and the token; the extension in Swift with CryptoKit; categories with Approve and Deny actions on approval notifications, which call `POST /approvals/{id}/decide` through the app on tap                                                                                                                                                 |
| Lock            | `expo-local-authentication`: Face ID or the passcode on launch and after 5 minutes in the background, since the phone holds an owner key (main plan section 9)                                                                                                                                                                                                                |
| Server versions | `GET /api/v1/capabilities` gains `version`; the app carries the oldest server it supports and shows "Update your server" below it, and treats a 404 on a newer route as "not on this server"                                                                                                                                                                                  |
| Telemetry       | None, like the server and Paseo. Crash reports are a later, opt-in decision                                                                                                                                                                                                                                                                                                   |
| Tests           | vitest for `hosts`, `transport`, `cache` and `notices` (plain modules, as the Mac app's are); React Native Testing Library for the transcript and widgets; Maestro flows on the simulator against the server's test app and the relay's Node test client, on the macOS runner                                                                                                 |
| Release         | EAS Build profiles `development` (dev client), `preview` (internal TestFlight) and `production`; `.github/workflows/release-mobile.yml` on each `v*` tag, submitting to TestFlight when the Apple secrets are set, as `release-mac.yml` does for signing. `expo-updates` runtime version equals the native version, so an OTA update only ever lands on the same release line |

---

## 6. Screens

| Screen     | Shows                                                                                                                                     | Actions                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Welcome    | The three ways to connect (M1), as the Mac app's welcome                                                                                  | Scan a QR code, Connect to a server (address, then sign in), Sign in to an OpenBots account         |
| Pair       | The camera, then the server's name and the path found (direct or relay), then the name to pair as                                         | Pair; on a server with no owner (V2), the owner's name, a provider key with Test, and the first Bot |
| Bots       | Pinned, Bots, Groups; avatar animated by `bot.state`, name, label, the current action under it when working                               | Open; New (a Bot from a name and avatar; a group of 2 to 6)                                         |
| Transcript | Title bar (name, label, Preview dot); messages with parts, threads and reactions; the composer                                            | Send text, photos, files; `@`; react; open a thread; answer a widget; the Bot menu                  |
| Bot menu   | Activity (run steps for the current or last run), Preview (view only), Artifacts, Routines, About (model, tools, Skills on or off)        | Run a Routine now; enable or disable it; open an Artifact                                           |
| Inbox      | Pending approvals, questions and sign-in requests across Bots, newest first, each with its Bot and the tool and arguments or the question | Approve, Deny, Answer, Open; the tab's badge is the count                                           |
| Settings   | Hosts (name, kind, path in use, last seen); This device (its name, notifications per kind, Face ID); About                                | Add, switch, remove a host; rename the device; sign out of an account host                          |

Skills (Settings > Skills library): write, edit and delete Skills, fill a new one from a markdown file in Files, and import Skills from a GitHub link.

Not on the phone (M10): Takeover, the terminal, the computer's files, Connectors, Settings > Models, organization administration. Each shows a one-line "On the desktop" where the web app would have it.

---

## 7. Milestones

| Milestone               | Builds                                                                                                                                                                                                                                   | Done when                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 Spike** (2 weeks)  | An Expo dev client with `packages/tunnel`, a throwaway transcript screen fed by a recorded event stream, the extension target, one EAS build to TestFlight                                                                               | The tunnel handshake and a `/ws` subscription work through the hosted relay from the phone; 500 messages stream at 60 fps on an iPhone 12; the extension decrypts a push. Else: SwiftUI (section 4) |
| **M1 Pair and read**    | Welcome and Pair, the host store and Keychain, both transports and path selection, the roster with live state, the transcript read only with streaming, resync on foreground, the cache                                                  | A phone pairs with This Mac over the relay and with a VM over direct https, and reads every chat with the socket dropping and returning                                                             |
| **M2 Act**              | The composer (text, photos, files, mentions, dictation), the widget renderers, approvals, questions and sign-in requests, the Inbox and its badge                                                                                        | Every M4 flow on the phone; a photo sent from the phone reaches the Bot's run as an attachment                                                                                                      |
| **M3 Push**             | Token registration, the extension, deep links, foreground suppression, grouping by Bot, Approve and Deny actions on the notification                                                                                                     | A day with the app closed misses no notice; tapping opens the message; Approve from the Lock Screen decides the approval                                                                            |
| **M4 TestFlight**       | Face ID, offline and error states, host switching, Dynamic Type and VoiceOver on every screen, haptics, the responsive pass on `apps/web` in parallel (section 2.4's verdict)                                                            | External TestFlight with the acceptance list of `docs/UI_REVIEW.md`'s chat controls walked on the phone                                                                                             |
| **M5 Second pass** (M8) | Preview and Artifacts through the WebView bridge, Activity, Routines, groups management, reactions and threads, sign in by address and OpenBots account (plan 7.2)                                                                       | Every M8 item; the three host kinds                                                                                                                                                                 |
| **M6 App Store**        | The privacy manifest (no tracking), screenshots, a support page, a demo server the reviewers can pair with (App Review needs a working account; a project-run server with a pairing link in the review notes), the release on a `v*` tag | Approved and live; the Mac app's "Pair your phone…" links to it                                                                                                                                     |
| **Later** (M9)          | The share extension, App Intents, the WidgetKit widget, the Live Activity, Android from the same code                                                                                                                                    |                                                                                                                                                                                                     |

M0 and M1 need phase 1 of the main plan (devices, relay, pairing) to be usable against a real server; the recorded event stream carries M0's transcript work before that.

---

## 8. Risks

| Risk                                                                     | Mitigation                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The transcript stutters while a long reply streams                       | M0 measures it first; re-render the streaming message only; coalesced deltas (plan 14.2) already bound the event rate; FlashList with fixed item types                                                    |
| JavaScript crypto is too slow on older phones                            | M0 measures it; a Noise handshake is a handful of X25519 operations and the transport is ChaCha20-Poly1305 per frame, which `@noble/ciphers` does at tens of MB/s; fall back to a native module if needed |
| The Keychain access group and the extension are misconfigured in a build | The config plugin is tested by a Maestro flow that sends a push to a TestFlight build in CI                                                                                                               |
| App Review refuses an app that needs a self-hosted server                | A project-run demo server for the reviewers with a pairing link in the notes; the OpenBots account host kind (plan 7.2) gives a plain sign-in too                                                         |
| Self-hosted servers lag the app by months                                | Section 5's version rule; every new route the app uses is optional until the oldest supported server has it                                                                                               |
| The WebView bridge is too slow for the screen preview                    | View only, at the preview's frame rate; over a direct path the WebView may open the socket itself in a later pass                                                                                         |
| The Expo SDK upgrade each year                                           | Pinned SDK per release line; one upgrade milestone a year, as the Mac app has for Electron                                                                                                                |

---

## 9. Decisions to confirm

1. **Expo with the M0 gate** (section 4), or SwiftUI now for fidelity with Android ruled out.
2. **The Noise suite** becomes `Noise_IK_25519_ChaChaPoly_SHA256` in the main plan, so a Swift client can speak it with CryptoKit alone. Recommended; the cost is nil.
3. **Minimum iOS**: 17, for the APIs in N9 and current Expo support.
4. **OTA updates** on, within a release line only.
5. **Telemetry**: none at launch; crash reports as an opt-in decision later.
6. **The demo server** for App Review: who runs it and where (it can be the same VM shape as the main plan's section 8).
