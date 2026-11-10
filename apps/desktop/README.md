# @openbots/desktop

The OpenBots Mac app: an Electron shell around the web app (plan section 14.4, Phase 7).

See [Images and runtime architecture](../../docs/ARCHITECTURE.md) for the five release images,
which three This Mac uses, how the local stack and relay fit together, and why standalone is an
alternative deployment rather than another Mac service.

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

- `src/main`: the main process. `index.ts` wires Electron; each other module is plain logic tested without Electron.
  - `profiles.ts`, `launcher.ts`: saved connections (This Mac, OpenBots account, self-hosted, paired Mac) and which one opens. Only This Mac touches the stack manager.
  - `pair-link.ts`, `paired.ts`, `device-keys.ts`, `tunnel-proxy.ts`: connecting to another Mac through its relay. The loopback proxy admits only callers with its per-run secret.
  - `tokens.ts`: session tokens sealed with `safeStorage`. Chromium never writes the session cookie to disk.
  - `connection.ts`, `notices.ts`, `approvals.ts`, `tray-icon.ts`: the main process's own server connection, native notifications and the tray. Which events notify lives in `packages/shared/src/notices.ts`.
  - `deep-links.ts`: `openbots://` links that notifications and the tray open.
  - `pairing.ts`, `menu.ts`: the Pair your phone window and the app menu. Changing the relay revokes every paired device. The default relay is `wss://openbots-relay.fly.dev`; a build overrides it with `openbots.relayUrl`, development with `OPENBOTS_SHARED_RELAY_URL`.
  - `navigation.ts`: the main window stays on the server and GitHub and Google sign-in pages; other links open in the browser.
  - `updater.ts`, `update-service.ts`: updates. Automatic install needs a Developer ID signature and restart consent; quitting never installs. Preview builds set `openbots.preview: true` and use their own app ID, Docker project (`openbots-preview`) and user-data folder.
  - `about.ts`, `app-icon.ts`, `ipc.ts`: the About panel, app icon and app page IPC.
- `src/preload`: the sandboxed preload. `bridge.ts` exposes `window.openbots`. Only the app's own pages get `profiles`, `connect`, `stack` and `quickAsk`, and the main process checks the sender URL on each call.
- `src/renderer`: the app's own pages (welcome, start and stack status, pairing, quick ask) in React with `@openbots/ui`. Page logic is in plain modules tested without a DOM.
- `src/stack`: the local stack manager. It finds Docker Desktop or OrbStack, writes `.env`, picks a free port and sandbox network (`network.ts`), and pulls only missing images.
- `src/images`: loads a release's image archives when the stack cannot pull.
- `src/release`, `electron-builder.yml`, `packaging`: notarization and packaging. See [RELEASING.md](RELEASING.md).
- `scripts`: `dev.mjs`, plus `make-icon.mjs` (`pnpm app-icon`) and `tray-icon.mjs` (`pnpm tray-icon`), which render `build/` and `resources/tray`.

## Known gaps

- Another Mac: a paired Mac holds a device key, so the routes a phone may not use
  (`DEVICE_KEY_NOT_ALLOWED`) are refused there too, among them adding a
  connector, a connector's OAuth sign-in, Settings, and pairing a phone; do those on the other Mac.
  Pairing needs a relay; a server with only a direct address is added as a self-hosted server.

- The tray lists approvals requested while the app was connected: the server has no route that
  lists pending approvals.
- Mentions: the server records only the Bots a message mentions, so the shell matches `@handles`
  made from the owner's name and email in finished Bot messages.
- The group view does not scroll to a message yet; a group deep link opens the group.
