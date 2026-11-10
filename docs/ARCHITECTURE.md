# Images and runtime architecture

OpenBots releases build **five custom Docker images**. The Mac app's **This Mac** mode runs only
three: `server`, `computer` and `sandbox-firewall`, plus third-party dependencies.

An **image** is a packaged software environment. A **container** is a running instance of one.
One image can serve several containers, so the image count is not the service count.

## The five images

Published under `ghcr.io/danielpang/openbots/<image>:<version>`; forks and development builds can
use another prefix.

| Image                  | What it is                                                                           | Why it exists and how it is used                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`server`**           | API, web UI, bot workers and scheduler.                                              | Coordinates chats, model calls, tools, routines, permissions and stored data. Runs in the local or remote Compose stack, connects to Postgres and Redis, and controls computers. Also runs as the separate `docker-guard` service, which validates Docker API requests.                                 |
| **`computer`**         | Linux workspace with a browser, filesystem, terminal and control agent.              | Where Bots browse, run commands and handle files, instead of on the Mac or in the backend container. The server creates computer containers on demand. Home files persist in volumes, outside the image.                                                                                                |
| **`sandbox-firewall`** | Small service that maintains Docker networking rules.                                | Container separation alone does not keep Bot commands from sensitive services and networks. Runs alongside the Compose stack. The server can contact computer agents. Computers cannot initiate connections to the server, other computers, the host, private/LAN networks or cloud metadata addresses. |
| **`relay`**            | Intermediary carrying encrypted connections between a paired phone and a server.     | Lets the phone reach a server behind a router or firewall without port forwarding or a public server address. Usually runs on shared infrastructure. Also published for self-hosting.                                                                                                                   |
| **`standalone`**       | Server, Postgres, Redis and the computer agent/browser environment in one container. | For personal hosting on platforms that run one container but not a Compose stack or sibling computer containers, including Fly Machines and Sprites. Persistent state lives under `/data`.                                                                                                              |

## The Mac app's This Mac setup

The Mac app is an Electron shell around the web UI. **This Mac** starts a local Compose stack
through Docker Desktop or OrbStack. The server's HTTP port is bound to loopback, not published to
the LAN.

```text
Mac app (Electron UI)
        |
        v
OpenBots server -------- Postgres + Redis
        |
        +-- Docker API --> docker-guard --> socket proxy --> Docker daemon
        |                                                   |
        |                                         creates computers
        |                                                   |
        +-- control connection --------------------> computer agent
                                                     +-- browser
                                                     +-- terminal
                                                     +-- files

sandbox-firewall maintains the computers' network boundary.

Paired phone <--> shared relay <--> OpenBots server
             end-to-end encrypted tunnel
```

- Computer containers are created at runtime (there can be several), on a sandbox network
  separate from Postgres and Redis. The server reaches their agents over an authenticated control
  connection.
- Container create and manage requests pass through `docker-guard`, which restricts them to the
  expected sandbox configuration. The server has no unrestricted access to the Docker socket.
- `sandbox-firewall` applies rules in the **Linux Docker host's network namespace**, not the
  macOS application firewall. It requires Docker-managed iptables. Rootless Docker and Docker's
  nftables firewall backend need equivalent rules applied separately. See the [stack networking
  and hardening details](SELF_HOSTING.md#from-the-repository).
- Postgres (`pgvector/pgvector`), Redis (`redis`) and the Docker socket proxy
  (`tecnativa/docker-socket-proxy`) are third-party images.

### Where the relay runs

This Mac uses the shared OpenBots relay by default, so users normally do **not** run the `relay`
image locally. An operator can deploy it separately, or self-host it with the Compose `relay`
profile behind TLS.

- The local server dials the relay outbound when a phone is paired or a pairing is open.
- The relay cannot read the encrypted phone-to-server contents. It can see connection metadata
  such as the server's host id, connection status and byte counts.
- Push notifications go through the relay and need the app's APNs key. A self-hosted relay
  without that key carries the tunnel only.
- The relay does not keep a sleeping Mac running. Bots and Routines pause while the Mac sleeps.
  Use an always-on remote deployment for work that must run around the clock.

See [phone connectivity](SELF_HOSTING.md#reaching-your-server-from-your-phone) and the
[relay README](../apps/relay/README.md).

### Connecting to an existing server

Choosing an OpenBots account or an existing self-hosted server makes the Mac app a client of that
server. No local stack or Docker containers run. Computers, database and other services live
wherever that server is hosted.

### Connecting to another Mac

**Connect to another Mac** makes this Mac a thin client of OpenBots on another Mac (its This Mac
stack) or any server with a relay. It pairs the way a phone does, with the link from that Mac's
**Pair your phone…** window, and becomes a `desktop` device of that server:

```text
This Mac (Electron UI)
        |
        v
loopback proxy (127.0.0.1, app windows only) -- device API key added
        |
        v
Noise IK tunnel ---> relay ---> other Mac's OpenBots server ---> its computers
```

- The main window loads the other server's web app from a proxy in the app on `127.0.0.1`.
- Every request and WebSocket goes through one encrypted tunnel over the relay, as the device,
  with its API key. The web app, its realtime socket, the terminal and the screen all work.
- The proxy refuses anything without a per-run secret, which only that profile's window session
  and the app's own process send.
- Device keys are sealed in the Keychain.
- Nothing runs in Docker on this Mac. Bots pause while the other Mac sleeps.

## Standalone: an alternative, not an extra service

Standalone packages the backend, database and Bot computer into **one container**. It relies on
separate OS users and file permissions, not a separate computer-container network boundary.

| Concern              | Compose / This Mac                                                          | Standalone                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Backend and database | Separate from computer containers.                                          | Share one container with the computer environment.                                                                           |
| Bot commands         | Run in sandbox computer containers.                                         | Run as separate users beside the backend and database.                                                                       |
| Network isolation    | Sandbox firewall restricts access to the server, host and private networks. | Commands can reach the server's loopback port and the hosting machine's network. Server routes still require authentication. |
| Egress proxy         | Firewall can enforce configured proxy routing.                              | Proxy environment variables are advisory; programs can ignore them.                                                          |
| Persistent storage   | Separate database, file and computer-home volumes.                          | One `/data` volume; a Bot filling its home can also fill the database's disk.                                                |
| Best fit             | The normal Mac setup and deployments needing stronger isolation.            | Simple personal hosting on a platform that runs a single container.                                                          |

User separation still protects server files and secrets, but standalone has a **weaker network
isolation boundary** and is not equivalent to the sandboxed Compose stack. Cloud metadata access
needs particular care: with `NET_ADMIN`, its init process blocks the documented metadata
addresses for Bot users; otherwise apply the appropriate platform restrictions.

See [deployment choices](../deploy/README.md) and
[standalone setup and settings](../docker/standalone/README.md).

## Why the release builds all five

The [five-image release workflow](../.github/workflows/release-images.yml) publishes images for
every deployment mode from the same release:

- **Mac local runtime and Docker Compose:** `server`, `computer`, `sandbox-firewall`.
- **Shared relay operation and self-hosted relays:** `relay`.
- **All-in-one cloud or personal hosting:** `standalone`.

Releases support Linux amd64 and arm64, since the containers run in Linux even when the app runs
on macOS.

For local development, build only the three images This Mac needs, following the
[instructions in the desktop README](../apps/desktop/README.md#testing-run-openbots-on-this-mac-against-images-built-from-source).
For Mac packaging and release operations, see [RELEASING.md](../apps/desktop/RELEASING.md).
