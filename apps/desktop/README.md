# @openbots/desktop

The OpenBots Mac app: an Electron shell around the web app (plan section 14.4, Phase 7).

```sh
pnpm --filter @openbots/desktop dev     # electron-vite dev, as .dev/OpenBots.app on macOS (scripts/dev.mjs)
pnpm exec turbo run build --filter=@openbots/desktop   # tsc for src/release, then electron-vite into dist/
cd apps/desktop && pnpm dist:dev       # unsigned .app in release/ (macOS), see RELEASING.md
```

`OPENBOTS_DESKTOP_LOCAL_URL=http://localhost:5173` points the local profile at the web app's Vite dev
server instead of the local stack. `OPENBOTS_CLOUD_URL=https://...` enables "Sign in to an OpenBots
account" in a development run (a release build takes it from the build; see RELEASING.md).

## Testing "Run OpenBots on this Mac" against images built from source

A development run has no release of its own, and until a release is published (and its GHCR
packages made public) pulling the default images fails. Build the three images the local stack
runs, then start the app with `OPENBOTS_IMAGE_PREFIX` and `OPENBOTS_VERSION`, which a development run
writes into the stack's `.env` on every start (a packaged app ignores both):

```sh
docker build -f docker/server.Dockerfile -t openbots-local/server:dev .
docker build -f docker/computer.Dockerfile -t openbots-local/computer:dev .
docker build -f docker/sandbox-firewall.Dockerfile -t openbots-local/sandbox-firewall:dev docker
OPENBOTS_IMAGE_PREFIX=openbots-local OPENBOTS_VERSION=dev pnpm --filter @openbots/desktop dev
```

When every image the stack's services run is already on this Mac, a start skips the pull and
starts with them. The stack lives in `~/Library/Application Support/@openbots/desktop/stack` in a
development run (`.env` there; delete it to start over as on first launch). It runs as the Compose
project `openbots-app`, so a `docker compose up` in a checkout (project `openbots`) is never touched,
and a new `.env` gets the first free port from 3000 up. A new `.env` also gets a sandbox network of
its own (`openbots-app-sandbox-<n>`, bridge `openbots-a-<n>`) on the first `/24` from
`172.30.254.0/24` down to `172.30.1.0/24` that no Docker network on this Mac overlaps (read with
`docker network ls` and `docker network inspect`; `src/stack/network.ts`), so the app's stack runs
beside a checkout's, which keeps `openbots-sbx` on `172.30.255.0/24`. An older `.env` without
`OPENBOTS_SANDBOX_NETWORK` keeps `openbots-sbx` while its containers are on it, and gets its own
network otherwise. When a start fails because another stack holds the network ("Address already in
use", or Compose's "exists but was not created for project" warning), the app says so and offers
"Use a separate network": it stops the app's stack, writes a fresh name and subnet into `.env` and
starts again. The server makes each computer again on the new network at its next start, keeping
its files.

## Layout

- `src/main`: the main process. `index.ts` wires Electron; everything with logic in it is a plain
  module tested without Electron:
  - `profiles.ts`: server profiles in `profiles.json` (userData), and whether the owner has chosen
    a connection. "This Mac" (the local stack, its port from the stack's `.env`) is always there;
    "OpenBots account" is there when the build names a hosted server (`app-config.ts`); any
    self-hosted server can be added.
  - `launcher.ts`: which connection opens, and the three ways to choose one on first launch and
    from "Change connection…". An account or a self-hosted server never touches the stack manager.
    `server-check.ts` checks an address is an OpenBots server (`/healthz`, `/api/v1/setup`) and
    waits for `/readyz`; `../server-url.ts` normalizes the address (https, or http on a private
    network with a warning).
  - `tokens.ts`: the session token per profile, sealed with `safeStorage` (the macOS Keychain) in
    `tokens.json`. The token is better-auth's session cookie. Each profile has its own session
    partition; the shell turns the cookie into a session cookie so Chromium never writes it to disk,
    and puts it back from the token store when a window opens.
  - `connection.ts`: the main process's own connection to the active server (`/ws` and REST, with
    the token as a Cookie header). It feeds notifications and the tray while the window is closed.
  - `notices.ts`: native notifications (N1) for approvals, questions, mentions of the owner,
    Routine exceptions and long tasks that finished (over two minutes), skipped when the focused
    window already shows that chat, with the Bot's avatar (`GET /bots/{id}/avatar.png`) as the
    image. Which events notify is the shared watcher in `packages/shared/src/notices.ts`, which the
    web app's browser notifications use too.
  - `deep-links.ts`: `openbots://bot/{id}/message/{seq}` (and `openbots://chat/{id}/message/{seq}`
    for groups), with `?thread={root id}` for a reply in a thread and `?chat={chat id}` for a
    message in one of the Bot's chats with another Bot, which the web app opens under the Bot's
    transcript. Registered with `setAsDefaultProtocolClient`; notifications and the tray open them.
    `openbots://devices` opens Settings > Devices.
  - `approvals.ts`: the tray menu (N2): the connection's kind and host, pending approvals with
    Approve, Deny and Open, Quick Ask, Pair your phone, Change connection, Check for Updates.
    Pair your phone opens the pairing window (below).
  - `menu.ts`: the app menu's File menu, whose New (`Cmd+N`) opens the web app's New dialog
    through `onNew` on the preload bridge. Its Pair your phone opens the pairing window.
  - `pairing.ts` and `renderer/pair*.ts(x)`: the pairing window. This Mac's stack runs with
    the OpenBots relay by default: a `.env` without `OPENBOTS_RELAY_URL` gets
    `wss://openbots-relay.fly.dev` (or the build's `openbots.relayUrl`, or
    `OPENBOTS_SHARED_RELAY_URL` in development) on its next start. Pair your phone shows the QR
    code from `POST /api/v1/devices/pairings` straight away, with its countdown and the phone's
    name once it pairs (`device.paired` on the main process's socket); closing the window
    cancels a code nobody used. Before the app is signed in, the menu opens Settings > Devices
    instead. The app menu's "Relay…" (or "Change relay" under the code) is the setting for a
    relay of the owner's own: it shows the address in use, warns that a change signs out every
    paired phone and asks once more, then writes `OPENBOTS_RELAY_URL`, runs `compose up` and
    revokes the paired devices, since they reached the Mac through the old relay. On any other
    connection the relay is the server's, and the setting only shows it.
  - `tray-icon.ts`: the menu bar icon, a template image in `resources/tray` rendered from
    `tray.svg` by `pnpm tray-icon` (`scripts/tray-icon.mjs`), with the pending count beside it.
  - `app-icon.ts`: the app icon, a Bot avatar (seed `OpenBots-225`: round, sky, sleepy eyes,
    glasses) on a dark plate. `pnpm app-icon` (`scripts/make-icon.mjs`) renders it with the
    avatars package into `build/` (`icon.svg`, `icon.png` and `icon.icns`, which
    electron-builder packages) and the web app's favicon and apple-touch-icon. In development
    the main process sets `build/icon.png` on the Dock and the main window.
  - `navigation.ts`: the main window stays on the server and the authorization and sign-in pages
    of GitHub and Google sign-in, for navigations and redirects alike; other links, other GitHub
    and Google pages included, open in the browser.
  - `about.ts`: the native About panel uses the packaged version stamped from the release tag.
    Unstamped local builds show the nearest Git release tag embedded at build time, labelled
    development. No Git tags or a source archive shows "Development build" instead of 0.0.0.
    The installed app never runs Git to determine its version.
  - `updater.ts`: electron-updater against the GitHub Releases in `electron-builder.publish.cjs`.
    Adapted from Bento's lifecycle: check 30 seconds after launch and every six hours. An
    OpenBots-styled bottom-right notice uses the app's own theme tokens, with Update for a
    manual installer or Restart and update for a downloaded signed update. No update path uses
    macOS notifications. Dismissal is shared across documents for that version until the app
    restarts; a new version brings the notice back. App and tray menus show checking, downloading,
    ready and preparing states. Manual checks report up-to-date, failed or skipped checks in-app;
    repeated clicks share the request and network lookups time out after 30 seconds.
    `update-service.ts` verifies Developer ID signing before allowing automatic installation,
    requires restart consent (Later is the default), and stages/verifies with native Squirrel
    before disconnecting the app and installing. Ordinary quit never installs an update. The
    independent Docker stack keeps running; any stack upgrade is offered after relaunch.
    Unsigned versioned packages offer the matching universal DMG from their release repository,
    verified to exist before opening the browser. `preload/update-toast.ts` owns the persistent
    notice in the isolated main-frame preload; update IPC is restricted to app pages and the
    active server's top-level page, without exposing installation primitives to the web bridge.
  - `ipc.ts`: the app pages' IPC handlers.
- `src/preload`: the preload (sandboxed, `contextIsolation` on, no Node integration), built as one
  CommonJS file. `bridge.ts` is what it exposes as `window.openbots`: every page gets `platform`,
  `onNavigate`, `onNew` and `connection`, which `apps/web` reads (`src/app/platform.ts`) to hand
  notifications to the shell, follow deep links, open New from the menu and show the sidebar's
  connection icon. `connection` answers only the active server's own page in the main window, and
  its Start, Stop and Show logs only for This Mac. Only the app's own pages also get `profiles`,
  `connect`, `stack` and `quickAsk`, and the main process checks the sender's URL on every one of
  those calls.
- `src/renderer`: the app's own pages. `index.html` is the welcome screen (`welcome.ts`: the three
  ways to connect) on first launch and from "Change connection…". Otherwise it shows why the server
  did not answer, the saved connections and, for "This Mac" only, starts, stops, updates and tails
  the local stack; the main window shows it when the server does not answer, and on launch when
  the app is a newer release than the stack, to update the stack.
  `quick-ask.html` is the quick-ask window (`Cmd+Shift+Space`). The pages are React with Tailwind
  and the web app's theme and components (`@openbots/ui`, its `styles.css`); each page's logic is a
  plain module tested without a DOM (`start-flow.ts`, `quick-ask-flow.ts`, `welcome.ts`,
  `stack-view.ts`) that the views render.
- `src/stack`: the local stack manager. It detects Docker Desktop or OrbStack, starts and stops
  the compose stack bundled in the app (`Contents/Resources/stack`, state and `.env` in userData),
  and tails its logs from a child process. The first start writes `.env` with a master key and
  database password, as `install.sh` does, `OPENBOTS_VERSION` set to the app's version, the first
  free port from 3000 up (`OPENBOTS_HTTP_PORT`, with `OPENBOTS_PUBLIC_URL` to match), the Compose
  project, `openbots-app` (`COMPOSE_PROJECT_NAME`), and a sandbox network of its own on a free
  subnet (`OPENBOTS_SANDBOX_NETWORK` and the rest, `network.ts`). An install from before that
  name, whose containers carry project `openbots` and the app's stack directory as their working
  directory, keeps `openbots`. A start refuses a port another app took and the start page offers a
  free one;
  it pulls only when an image is missing here, and says plainly when the images are not published
  or not public, with Compose's output behind "Show details". When the
  app is a newer release, the next start or Update sets `OPENBOTS_VERSION` to it (the rest of `.env`
  stays), pulls the images and restarts the stack; a tag that is not a release, such as `latest`,
  is left alone. `bridge.ts` puts it behind the preload bridge.
- Packaging and release: `electron-builder.yml`, the `afterSign` notarization hook in
  `src/release`, the Homebrew cask template, and `.github/workflows/release-mac.yml`, which
  `.github/workflows/release.yml` runs for each `v<version>` tag. `src/images` loads a release's
  image archives when the local stack cannot pull. See [RELEASING.md](RELEASING.md) for the
  release steps and the signed, manual and unsigned paths.

## Known gaps

- The tray lists approvals requested while the app was connected: the server has no route that
  lists pending approvals.
- Mentions: the server records only the Bots a message mentions, so the shell matches `@handles`
  made from the owner's name and email in finished Bot messages.
- The group view does not scroll to a message yet; a group deep link opens the group.
