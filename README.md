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
- **Open sourced:** Apache 2.0 license, always free to self-host. Model API usage are charged through providers.

## Get started on your Mac

1. Install and start [Docker Desktop](https://www.docker.com/products/docker-desktop/) or
   [OrbStack](https://orbstack.dev).
2. Download `OpenBots-<version>-universal.dmg` from the
   [latest release](https://github.com/danielpang/OpenBots/releases/latest), then drag OpenBots into
   Applications. It supports Apple Silicon and Intel Macs.
3. Open OpenBots and choose **Run OpenBots on this Mac**. Let it download and start the local stack.
4. Follow setup to create your account, add a model provider key and create your first Bot.

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

The Mac app can also connect to an existing self-hosted server, or to OpenBots running on another
Mac: choose **Pair your phone** there, copy the link, then choose **Connect to another Mac** here
and paste it. To operate the relay yourself, see the optional
[private relay setup](docs/PRIVATE_RELAY_SETUP.md). The relay only connects your devices; it does
not run your Bots.

## Connect models and subscriptions

Open **Settings → Models** to connect a Claude, ChatGPT/Codex or xAI subscription, or save a
provider API key. One sign-in covers both bot conversations and the matching coding agent. For
xAI, run `pi` in the terminal, choose `/login`, then choose **Check** in Models.

- **Subscriptions take priority over API keys.** If a sign-in expires or the plan hits a limit,
  requests fail instead of switching to API billing. Disconnect the subscription to use a saved key.
- **Credentials stay on your computer.** Tokens are not copied into the server database, and
  subscription requests only go to the vendor's own endpoints.
- **Access depends on your plan.** Models and billing follow the vendor's terms, and Claude access
  outside Claude Code may be restricted or cost extra. **Connected** means a saved connection, so
  use **Test** on a model to verify access.

Self-hosting? Deploy the server and computer image together, and start agents through the
supplied Claude/Codex launchers so credential refreshes stay coordinated. Credentials are readable
by code running as the shared `coder` user.

## Coding tasks and pull requests

After a successful edit or PR task finishes, OpenBots reconciles the final committed changes and requests
publication automatically, even if the coding agent forgot to call its publishing tool. Both push
and PR permissions still apply. By default the owner must approve, and **Accept edits** does not
approve publishing. Further changes after a live publish require authorization for the new commit.

A declined request is not retried automatically. Publication failures remain in the final session
summary and error, rather than being hidden in the activity log. Plan-only tasks never publish.
Deploy the server and computer image together. See [coding-session publishing](docs/CODING_SESSION_PUBLISHING.md)
for retry behavior, cancellation, and existing unsafe Git-configuration recovery.

## Go further

- [Architecture and the five Docker images](docs/ARCHITECTURE.md)
- [Self-hosting reference: install, upgrade, backup and development](docs/SELF_HOSTING.md)
- [Contributing](docs/CONTRIBUTING.md) · [Report a bug or suggest an idea](https://github.com/danielpang/OpenBots/issues)
- [License](LICENSE) · [Terms and Conditions](docs/TERMS.md)

<a href="https://buymeacoffee.com/dpang"><img src="https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=dpang&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff" alt="Buy me a coffee" height="40"></a>

Bots can take real actions: review permissions and approvals before giving them access.
The free shared relay has no availability guarantee; see the terms before using it.

## License FAQ

**What can I do with the core?** The core is under [Apache 2.0](LICENSE), free to
use, modify, self-host, host for others, and sell setup or support for.

**What about Enterprise?** The `ee/` code (organizations, billing and subscriptions)
is proprietary under [ee/LICENSE](ee/LICENSE).

**What about the mobile app?** Its source is visible for review, but all rights are
reserved under [apps/mobile/LICENSE](apps/mobile/LICENSE). Copying, modifying,
building, distributing or publishing it requires written permission.

**Can I use the OpenBots branding?** The OpenBots (including Scout, Pixel, and Sage bot) name and logo are trademarks of
Daniel Pang and may not be used for forks or hosted services without permission.