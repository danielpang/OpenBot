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
- **Free to self-host:** Always free to self-host. Model API usage are charged through providers.

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

The Mac app can also connect to an existing self-hosted server instead of running one locally,
or work as a thin client of OpenBots running on another Mac: on that Mac choose **Pair your phone**,
copy the link, and on this one choose **Connect to another Mac** and paste it. The two connect
through the relay, end to end encrypted, so neither needs a public address.
Prefer to operate the relay yourself? Follow the optional [private relay setup](docs/PRIVATE_RELAY_SETUP.md).
A private relay replaces the shared connection service that allows the OpenBots mobile app to pair with Openbots running on your machine; it does not run your Bots.

## Connect models and subscriptions

Open **Settings → Models** to connect a Claude, ChatGPT/Codex or xAI subscription, or save a
provider API key. One subscription sign-in is shared by bot conversations and the compatible
coding agent. Existing coding-agent sign-ins appear here too. xAI sign-in uses pi's terminal
flow: open the terminal, run `pi`, choose `/login`, then return to Models and choose **Check**.
A computer must be configured for subscription connections.

A connected subscription takes priority over an API key for that provider. If the sign-in expires
or the plan reaches a limit, requests fail rather than silently switching to API billing.
Disconnect the subscription to use a saved key. Under a saved key, **Use key** also
connects it to a compatible coding agent. **Settings → Coding agents** shows agent status and
links back to Models for connection setup.

Credentials stay on your computer. Bot requests use the same credential files as the coding
agent, including token refreshes; tokens are not copied into the server database. Subscription
requests use vendor-native endpoints only, never custom endpoints. Available models and billing
remain subject to the vendor's plan and terms. In particular, Claude access outside Claude Code
may require extra usage or be restricted by Anthropic. API list prices are not shown as a cost
estimate for subscription bot runs. A **Connected** label means a saved connection, not verified
plan access. Use **Test** on a model to verify access.

Deploy the updated server and computer image together. The supported Claude/Codex launchers
coordinate credential writes with the bot bridge. A refresh may wait for an active native CLI
session to finish; ordinary bot requests with a valid token do not take that lock. Cancellation
allows an in-flight token rotation to commit, and disconnect uses the same locks so a refresh
cannot restore a removed connection. Invoking vendor binaries directly bypasses this coordination.
Credentials remain accessible to code running as the shared `coder` user, an existing isolation
limitation described in [the security review](docs/SECURITY.md).

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
- [Security boundaries](docs/SECURITY.md) · [License](LICENSE) · [Terms and Conditions](docs/TERMS.md)

Bots can take real actions: review permissions and approvals before giving them access.
The free shared relay has no availability guarantee; see the terms before using it.
