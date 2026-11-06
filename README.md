<p align="center">
  <img src="apps/mobile/assets/openbots-logo.svg" width="88" height="88" alt="OpenBots logo">
</p>

<h1 align="center">OpenBots</h1>

<p align="center">
  Your own team of AI Bots, on your own computer or server.<br>
  <a href="https://open-bots-www.vercel.app">Website</a> ·
  <a href="https://github.com/danielpang/OpenBots/releases/latest">Download for Mac</a> ·
  <a href="docs/CONTRIBUTING.md">Contribute</a>
</p>

## What is OpenBots?

OpenBots gives you persistent AI teammates with memory, tools and their own browser, terminal
and files. Ask them to research, write, code or automate recurring work. Chat with one Bot or bring
several into a group, and use Routines to start work on a schedule.

- **Yours to run:** keep your data on your Mac or a server you control, and bring your own models.
- **More than a chat window:** Bots can use computers, connect to tools through MCP, and keep working
  across conversations.
- **Built in the open, with the community:** inspect the source, suggest ideas and contribute fixes
  or Skills. Help shape what comes next.
- **Free to self-host:** no OpenBots subscription for personal or internal use. Model API usage and
  any rented hosting are separate costs.

OpenBots is **source-available under [BSL 1.1](LICENSE)**, not an OSI-approved open-source license.
Hosting it for third parties or selling setup/support services requires a separate agreement.

## Get started on your Mac

1. Install and start [Docker Desktop](https://www.docker.com/products/docker-desktop/) or
   [OrbStack](https://orbstack.dev).
2. Download `OpenBots-<version>-universal.dmg` from the
   [latest release](https://github.com/danielpang/OpenBots/releases/latest), then drag OpenBots into
   Applications. It supports Apple Silicon and Intel Macs.
3. Open OpenBots and choose **Run OpenBots on this Mac**. Let it download and start the local stack.
4. Follow setup to create your account, add a model provider key and create your first Bot.

If the release is unsigned, right-click the app and choose **Open** the first time; unsigned
builds need manual updates.

**iOS and Android apps are on their way.** When you have a compatible mobile build, choose
**Pair your phone** in the Mac app and scan the QR code. This Mac uses the shared OpenBots relay
by default: no port forwarding, public address or certificate needed, and phone-to-server traffic
is end-to-end encrypted.

## Choose where your Bots run

| Option                             | Best for                                                  | Setup                                                                                 |
| ---------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **On your Mac**                    | Getting started; work while your Mac is awake.            | Follow the steps above. The shared relay connects your phone.                         |
| **On a VM or home server**         | Bots and Routines that keep working when your Mac sleeps. | [VM setup with the shared relay](docs/VM_SETUP.md).                                   |
| **On a single-container platform** | Personal hosting on Fly Machines or Sprites.              | [Deployment options](deploy/README.md). Standalone has weaker isolation than Compose. |

The Mac app can also connect to an existing self-hosted server instead of running one locally.
Prefer to operate the relay yourself? Follow the optional [private relay setup](docs/PRIVATE_RELAY_SETUP.md).
A private relay replaces the shared connection service; it does not run your Bots.

## Go further

- [Architecture and the five Docker images](docs/ARCHITECTURE.md)
- [Self-hosting reference: install, upgrade, backup and development](docs/SELF_HOSTING.md)
- [Contributing](docs/CONTRIBUTING.md) · [Report a bug or suggest an idea](https://github.com/danielpang/OpenBots/issues)
- [Security boundaries](docs/SECURITY.md) · [License](LICENSE) · [Terms and Conditions](docs/TERMS.md)

Bots can take real actions: review permissions and approvals before giving them access.
The free shared relay has no availability guarantee; see the terms before using it.
