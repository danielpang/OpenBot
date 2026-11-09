# Images and runtime architecture

OpenBots releases build **five custom Docker images**, but the Mac app does not run all five.
The Mac app's **This Mac** mode uses `server`, `computer` and `sandbox-firewall`, alongside
third-party dependencies. `relay` supports remote connectivity; `standalone` is an alternative
all-in-one deployment for hosting platforms.

An **image** is a packaged software environment. A **container** is a running instance of an
image. One image can serve several containers, so the image count is not the service count.

## The five images

Images are published under `ghcr.io/danielpang/openbots/<image>:<version>`; forks and development
builds can use another prefix.

| Image                  | What it is                                                                                    | Why it exists                                                                                                                                         | How it is used                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`server`**           | The OpenBots API, web UI, bot workers and scheduler.                                          | Coordinates chats, model calls, tools, routines, permissions and stored data.                                                                         | Runs in the local or remote Compose stack, connects to Postgres and Redis, and controls computers. The same image also runs the separate `docker-guard` service to validate Docker API requests.                             |
| **`computer`**         | A Linux workspace with a browser, filesystem, terminal and control agent.                     | Gives Bots somewhere to browse, execute commands and work with files without running those tasks directly on the Mac or inside the backend container. | The server creates computer containers on demand from this image. Home files persist in volumes separately from the image.                                                                                                   |
| **`sandbox-firewall`** | A small service that maintains Docker networking rules.                                       | Container separation alone does not prevent Bot commands from reaching sensitive services and networks.                                               | Runs alongside the Compose stack. Lets the server contact computer agents, while blocking computers from initiating connections to the server, other computers, the host, private/LAN networks and cloud metadata addresses. |
| **`relay`**            | An intermediary carrying encrypted connections between a paired phone and an OpenBots server. | Lets the phone reach a server behind a router or firewall without port forwarding or a public server address.                                         | Usually runs on shared infrastructure, not on the user's Mac. Also published for self-hosting. The server connects outbound; phone-to-server contents are end-to-end encrypted.                                              |
| **`standalone`**       | Server, Postgres, Redis and the computer agent/browser environment in one container.          | Supports hosting platforms that run one container but cannot run a Compose stack or create sibling computer containers.                               | An alternative to the Compose stack for personal hosting, including Fly Machines and Sprites. Persistent state lives under `/data`. It is not another component to add to the Mac stack.                                     |

## The Mac app's This Mac setup

The Mac app is an Electron shell around the web UI. Choosing **This Mac** starts a local Compose
stack through Docker Desktop or OrbStack. The server's HTTP port is bound to loopback so it is
not published to the LAN.

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

The computer containers are created at runtime, not declared as one fixed Compose service. They
join a sandbox network separate from Postgres and Redis. The server reaches their agents over an
authenticated control connection. Requests to create or manage containers pass through
`docker-guard`, which restricts them to the expected sandbox configuration; the server does not
get unrestricted access to the Docker socket.

`sandbox-firewall` applies rules in the **Linux Docker host's network namespace**, not the macOS
application firewall. It requires Docker-managed iptables; rootless Docker and Docker's nftables
firewall backend require equivalent rules applied separately. See the [stack networking and
hardening details](SELF_HOSTING.md#checking-the-container-hardening).

Postgres (`pgvector/pgvector`), Redis (`redis`) and the Docker socket proxy
(`tecnativa/docker-socket-proxy`) use third-party images. They are additional dependencies, not
part of the five images OpenBots builds. The `server` image is also reused by `docker-guard`, and
there can be multiple computer containers. **Five custom images does not mean five containers.**

### Where the relay runs

This Mac uses the shared OpenBots relay by default. The local server dials it outbound when a
phone is paired or a pairing is open. The phone connects to that relay to reach the server; the
relay cannot read the phone-to-server encrypted contents. It can see connection metadata such as
the server's host id, connection status and byte counts.

Users normally do **not** run the `relay` image locally. An operator can deploy it separately, or
self-host it with the Compose `relay` profile behind TLS. Push notifications also go through the
relay, but require the app's APNs key: a self-hosted relay without that key carries the tunnel,
not push notifications. See [phone connectivity](SELF_HOSTING.md#reaching-your-server-from-your-phone)
and the [relay README](../apps/relay/README.md).

The relay does not keep a sleeping Mac running. Bots and Routines pause while the Mac sleeps;
use an always-on remote deployment for work that must continue around the clock.

### Connecting to an existing server

Choosing an OpenBots account or an existing self-hosted server makes the Mac app a client of that
server. It does not start the local stack and does not need local Docker containers. The computers,
database and other services run wherever that server is hosted.

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

The main window loads the other server's web app from a proxy in the app on `127.0.0.1`. Every
request and WebSocket goes on through one encrypted tunnel over the relay, as the device, with the
device's API key, so the web app, its realtime socket, the terminal and the screen all work. The
proxy refuses anything that does not carry a per-run secret, which only that profile's window
session and the app's own process send. The device keys are sealed in the Keychain. Nothing runs
in Docker on this Mac, and Bots pause while the other Mac sleeps.

## Standalone: an alternative, not an extra service

The Compose stack separates the backend, database and Bot computers into different containers.
Standalone packages those processes into **one container**, using separate OS users and file
permissions rather than a separate computer-container network boundary.

| Concern              | Compose / This Mac                                                          | Standalone                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Backend and database | Separate from computer containers.                                          | Share one container with the computer environment.                                                                           |
| Bot commands         | Run in sandbox computer containers.                                         | Run as separate users beside the backend and database.                                                                       |
| Network isolation    | Sandbox firewall restricts access to the server, host and private networks. | Commands can reach the server's loopback port and the hosting machine's network. Server routes still require authentication. |
| Egress proxy         | Firewall can enforce configured proxy routing.                              | Proxy environment variables are advisory; programs can ignore them.                                                          |
| Persistent storage   | Separate database, file and computer-home volumes.                          | One `/data` volume; a Bot filling its home can also fill the database's disk.                                                |
| Best fit             | The normal Mac setup and deployments needing stronger isolation.            | Simple personal hosting on a platform that runs a single container.                                                          |

Standalone still protects server files and secrets with user separation, but it has a **weaker
network isolation boundary**. Cloud metadata access needs particular care: with `NET_ADMIN`, its
init process blocks the documented metadata addresses for Bot users; otherwise apply the
appropriate platform restrictions. Standalone is not equivalent to the sandboxed Compose stack.

See [deployment choices](../deploy/README.md), [standalone setup and settings](../docker/standalone/README.md)
and [security boundaries and known differences](SECURITY.md#14-standalone-image-and-a-self-hosted-relay).

## Why the release builds all five

The release workflow produces artifacts for several deployment modes, not just the Mac app:

- **Mac local runtime and Docker Compose:** `server`, `computer`, `sandbox-firewall`.
- **Shared relay operation and self-hosted relays:** `relay`.
- **All-in-one cloud or personal hosting:** `standalone`.

Publishing all five together gives these deployments images from the same release. The
[five-image release workflow](../.github/workflows/release-images.yml) builds and publishes them;
that does not mean each Mac needs to run them all. Published releases support Linux amd64 and
arm64, since the containers run in a Linux environment even when the app runs on macOS.

For local development, build only the three custom images needed by This Mac and use the
[instructions in the desktop README](../apps/desktop/README.md#testing-run-openbots-on-this-mac-against-images-built-from-source).
For Mac packaging and release operations, see [RELEASING.md](../apps/desktop/RELEASING.md).
