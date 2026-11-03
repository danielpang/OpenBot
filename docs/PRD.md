# OpenBots Product Requirements

OpenBots is a source available, self-hosted Grok Bot. This PRD is anchored on xAI's "Designing Grok Bot" essay and the Grok Bot documentation. Where OpenBots deliberately differs (self-hosting, Docker sandboxes, an open connector model), the difference is called out.

The test for every feature in this document is the one xAI used: **"Did this help someone delegate, or did it give them one more thing to manage?"**

---

## 1. Vision and principles

Grok Bot's thesis: chat sessions are the wrong primary object for an agent that "persists beyond any one session and can carry responsibility on its own." The interface should be built around persistent agents, and "as agents take on more responsibility, the interface should ask less of the person."

OpenBots adopts the following principles from the essay as product requirements:

1. **Bots, not conversations, are the main objects.** "A Bot has a name. It has an avatar and a title. It remembers its conversations with you. It has its own computer and tools. When you come back tomorrow, you are coming back to the same Bot."
2. **Only five concepts are visible.** Bots, Chats, Prompts, Tools, Artifacts. "Everything else could remain beneath the interface until the user had a reason to care about it." Runs, queues, models, sandboxes, and MCP sessions are implementation detail and stay out of the primary UI.
3. **Identity carries state.** The avatar communicates what the Bot is doing; there are no separate status indicators or "three animated dots."
4. **Transparency is tiered.** Passive assurance from the avatar, current action on hover, full activity log on demand. People asked for detail "mainly for reassurance that the Bot was still working and on the right track."
5. **The computer is the Bot's workspace, not the user's.** "The more prominent we made the computer, the more the product encouraged users to supervise it." Status, then preview, then takeover.
6. **The form of a response is part of the answer.** Bots answer in prose when prose fits and in structured widgets when it does not. The transcript is heterogeneous: conversation, system events, interactive objects, and visualizations share one timeline.
7. **Capabilities are shared, context is isolated.** "Tools and Skills live at the account level... Memory and Routines belong to the Bot."
8. **Coordination is done by Bots, not by dashboards.** No assignment boards or explicit handoff controls. "Coordinating Bots handle routine routing and bring the user in when a decision requires judgment."
9. **Work starts without the user.** "A prompt can start a session, but so can a schedule, an event, or another Bot."
10. **Remove rather than add.** Grok Bot shipped after removing window and panel controls, computer-view options, and agent metadata. The OpenBots UI reviews use the same bar.

---

## 2. The five objects

| Object | Grok Bot definition | OpenBots |
| --- | --- | --- |
| **Bot** | "persistent agents with their own identity, memory, runtime, and tools" | A named agent with an avatar, label, description (standing rules), model, memory, Routines, enabled Skills, tool permissions, and a screen on the owner's computer |
| **Chat** | "the conversational interface for working with a Bot" | Each Bot has one persistent direct transcript with its owner. Group chats hold two to six Bots. Threads hang off a result or an approval. Bots also message each other directly |
| **Prompt** | "give a Bot context or instructions. They can be used once, saved as Skills, or triggered automatically as Routines" | A message (used once), a Skill (saved in the account library, referenced with `/`), or a Routine (a prompt or Skill run by a schedule or an event, owned by a Bot) |
| **Tool** | "let Bots access information and take action through software, APIs, connectors, the shell, or computer use" | Built-in tools, connectors (MCP servers and first-party integrations) at the account level, and the computer (shell, files, browser) |
| **Artifact** | "documents, designs, code, data, and other durable outputs that Bots create or modify" | Versioned outputs stored by OpenBots, shown as cards in the transcript, openable in a viewer |

---

## 3. Users

- **Individual self-hoster.** Runs OpenBots with Docker on a Mac or a VPS, uses the Mac app or the web app, exposes it through a tunnel for webhooks and connector OAuth. A self-hosted install has one account, its owner, who owns all Bots and sets every setting. There is no admin concept: no members, invites, roles or audit log screens, and sign-up closes once the owner exists.
- **Teams on the managed service.** The hosted OpenBots service is one server shared by many organizations. People sign up, create an organization or join one through an invite, and can belong to several. In each organization every member owns their own Bots, computer, connectors, Skills library and providers; owners and admins invite, suspend and remove members, set the organization's providers, limits and connector policy, and read its audit log, but never see members' Bots. Nothing crosses between organizations, even for someone in two of them. Organizations, roles, invites and the audit log are for this service only (`OPENBOTS_DEPLOYMENT=managed`, built from `ee/`).
- **Integrator.** Wires external systems (GitHub, Slack, cron, scripts) to Bots through Routines and webhook endpoints, and reads Bot output through outbound events and Artifacts.

---

## 4. Requirements

Each requirement has an ID for traceability into the technical plan. "Must" is v1; "Later" is after 1.0.

### 4.1 Bots and the roster

| ID | Requirement | Priority |
| --- | --- | --- |
| B1 | The sidebar is a roster of Bots plus group chats, not a list of conversations. Pinned Bots stay at the top. Bots can be hidden from the sidebar without deletion. | Must |
| B2 | Create a Bot with **New** in the sidebar or `Cmd/Ctrl+N`. Creation asks only for a name and an icon: the generated avatar, with a body shape to pick (Moon, Box or Egg) and Shuffle for the rest. Everything else (model, description, tools) has defaults and is editable later in Settings. The Bot's chat opens with its own first message asking what it should work on, so the owner tells it its task and it learns from that. | Must |
| B3 | Bot profile fields: name, label (title shown under the name), description (rules that should remain true), avatar, model. "Use the description for rules that should remain true. Use the conversation for task-specific instructions." | Must |
| B4 | Opening a Bot opens its one persistent transcript. There is no "new chat" with a Bot. | Must |
| B5 | Duplicate a Bot: carries profile, settings, enabled Skills, Routines, and avatar; excludes conversation history, learned memory, attachments, and the main Bot mark (K8); the copy is the main Bot only when the owner has none. | Must |
| B6 | Removed: there are no Bot templates. A Bot starts from a name and an icon and learns its task by asking (B2). | n/a |
| B7 | Delete removes profile, conversation, and Routines; the UI recommends hiding instead when unsure. | Must |
| B8 | Limits: 50 Bots per account, six Bots per group chat. Limits are configurable by the self-host admin but default to Grok Bot's. | Must |

### 4.2 Identity and state

| ID | Requirement | Priority |
| --- | --- | --- |
| I1 | Avatars come from one visual system: consistent construction with simple shapes and expressive eyes, distinction through controlled variations and accessories. Every Bot is recognizable at sidebar scale, "almost peripherally." Users pick from generated variations or upload an image. | Must |
| I2 | The avatar communicates state through motion: **Idle** (calm, slightly curious), **Thinking**, **Working** (kicked into gear), **Waiting** (needs input, approval, or a sign-in), **Blocked** (error, or a connector needs a login), **Done** (settles). No separate status badge in the roster. | Must |
| I3 | Hovering a working Bot shows its current action in one line, for example "Editing math.ts" or "Running npm test". | Must |
| I4 | The full activity log is available on demand from the transcript: an ordered list of compact entries with durations, such as "Environment ready 387ms", "Edited math.ts +14 −10", "Ran focused tests npm test", "Thought briefly", "Searched code 'toFixed'", "Read AGENTS.md", "Ran full suite 212 passed", "Committed fix: clamp NaN". | Must |
| I5 | A title-bar icon shows when the Bot's computer is active. | Must |

### 4.3 Chats

| ID | Requirement | Priority |
| --- | --- | --- |
| C1 | Composer supports text, links, images, local files, `/` to reference a Skill, and `@` to mention Bots. | Must |
| C2 | The transcript shows tool activity, computer use, created files, questions, and approval requests alongside normal messages, in one timeline. | Must |
| C3 | A direct message from the owner takes priority over the Bot's background work (Routines, Bot to Bot requests). | Must |
| C4 | Group chats hold two to six Bots. Created from **New chat** by selecting Bots. Bots can be added mid-conversation with `@`. | Must |
| C5 | In a group, writing normally lets the participating Bots decide who should respond. `@bot` directs only the mentioned Bot, multiple `@` mentions direct only those Bots, and `@everyone` addresses all. When a message mentions one or more Bots, or uses `@everyone`, only those Bots reply and the others are not asked. A mentioned Bot can still bring others in by @mentioning them in its reply. | Must |
| C6 | Bots can send asynchronous messages to other Bots. "The receiving Bot wakes, handles the request, and can reply later." These exchanges are visible to the owner. | Must |
| C7 | Threads: reply in a thread when feedback applies to one result or one approval request. Thread replies keep the Bot's attention on that item. | Must |
| C8 | Reactions on messages as lightweight acknowledgement, including from Bots. | Must |
| C9 | Group chats pass context between Bots through the group transcript, direct messages, and shared files, while each Bot keeps its own memory. | Must |
| C10 | Other human members of the workspace can be invited to a group chat. | Later |

### 4.4 Structured responses and widgets

| ID | Requirement | Priority |
| --- | --- | --- |
| W1 | Bots choose prose or a widget per response. The widget set at 1.0: approval request, question with options, email draft (From, To, Subject, body, Send), form, table, chart, status summary, event notification, Routine created, Routine run result, Artifact card, file card. | Must |
| W2 | Widgets are interactive: buttons and fields post back to the Bot's run (for example, Send on an email draft goes through approval and then the connector). | Must |
| W3 | System events (computer started, connector needs login, Bot loop stopped) appear in the transcript as compact event rows, not as chat bubbles. Routine results use the Routine run result widget (W1) instead, because it carries actions such as opening the activity log and pausing the Routine. | Must |
| W4 | Widget kinds are an extensible registry so connectors and community code can add renderers. | Later |

### 4.5 Tools

| ID | Requirement | Priority |
| --- | --- | --- |
| T1 | Tools live at the account level and are available to every Bot the account owns, subject to per-Bot permissions. | Must |
| T2 | Connectors: add any MCP server (stdio or Streamable HTTP with OAuth 2.1) from a catalog, a custom form, or pasted `mcpServers` JSON. Every member can add catalog servers (stdio ones included, which run the catalog's pinned command) and any Streamable HTTP server. A custom stdio command runs a program on the OpenBots server, so only a workspace admin can add one, and only after an admin turns custom stdio servers on (off by default; see [SECURITY.md](SECURITY.md) S-1). Pasted JSON imports every server the member may add and lists each refused one with the reason. Connecting an account is one click where the provider registers OpenBots itself (dynamic client registration: Cloudflare, Vercel, Supabase, Neon, Railway, and any pasted URL whose server offers it): Connect opens the provider's sign-in (a popup in the browser, the default browser in the Mac app), the owner logs in and authorizes OpenBots, and the page says "<Provider> is connected. You can close this window." while the card turns Connected. A pasted URL needs nothing else; OpenBots finds out whether it needs OAuth. Providers without registration (GitHub, Slack, Gmail, Google Docs for now) take the owner's own OAuth app under Advanced. Expired or revoked sign-ins show one Reconnect button. First-party built-ins at 1.0: web search, web fetch, HTTP request, email (SMTP and IMAP), GitHub. | Must |
| T3 | A workspace admin can block a connector for all members; blocked connectors show as "Disabled by admin". | Must |
| T4 | Bots prefer connectors over the computer when a connector covers the task, and fall back to computer use otherwise. | Must |
| T5 | Every side-effecting action passes an approval policy (auto, ask, deny) configurable per Bot and per tool, with safe defaults. Approval requests are widgets in the transcript and notifications on desktop. | Must |
| T6 | Admin "auto-review" rules that force approval for classes of actions across the workspace, and action recording. | Later |

### 4.6 The Bot's computer

| ID | Requirement | Priority |
| --- | --- | --- |
| K1 | Every account has one persistent computer with a browser, filesystem, and terminal. All of that account's Bots share it: files, browser sessions, and app logins carry over between Bots "without repeating setup." Each Bot keeps its own browser on its own screen (K2), and logins are shared by syncing cookies between the Bots' browsers, so a site signed in on one screen is signed in on every screen. Sessions a site keeps only in localStorage or IndexedDB do not carry over. | Must |
| K2 | Each Bot gets its own screen on the shared computer. One Bot runs one computer-use task on its screen at a time; Bots run in parallel on different screens. | Must |
| K3 | Three levels of access from the chat: **Status** (title-bar icon lights up while active), **Preview** (a pinned side panel that follows the work without leaving the conversation), **Takeover** (open full screen, take control, hand it back). No other computer-view options. | Must |
| K4 | Work continues when the app, laptop, or phone is closed. | Must |
| K5 | The computer's wallpaper shifts through the day, lighter in the morning and darker at night, so it reads as the Bot's space rather than the user's desktop. | Must |
| K6 | Self-host difference: the computer is a Docker sandbox by default (Grok Bot uses a Firecracker microVM). Stronger isolation providers are pluggable. | Must |
| K7 | Persistent files survive restarts and upgrades; the user can browse, upload, and download them. | Must |
| K8 | Main Bot for sign-ins. The owner can mark at most one of their Bots as the main Bot in Bot Settings. A member's first Bot becomes their main Bot, and so does a new Bot made while they have none (for example after deleting the main Bot). When a Bot needs a login it does not have, it asks for a sign-in with the site and a reason instead of asking for credentials. With a main Bot set, and the asking Bot not the main Bot, the request goes to the main Bot through their Bot to Bot chat (visible to the owner, C6), and one sign-in request appears in the main Bot's transcript without the main Bot starting any work. It asks the owner once: pending requests for the same site are merged into one. The owner opens Takeover on the main Bot's screen (K3), signs in, hands back, and clicks Done. The login carries over to every Bot (K1) and every waiting Bot resumes. With no main Bot set, or when the main Bot is the one asking, the request appears in the asking Bot's own transcript and the owner signs in on that Bot's screen. A waiting Bot shows the Waiting state with the action "Waiting for sign-in: <site>". | Must |

### 4.7 Prompts: Skills and Routines

| ID | Requirement | Priority |
| --- | --- | --- |
| S1 | A Skill is a reusable set of instructions: a name and free-form markdown content. The Bot's tool policy decides what needs approval (T5), unless the Skill says more. | Must |
| S2 | Skills are one private library per account, shared by all of that account's Bots. A Bot may still need a connector or login to use one. Skills are enabled per Bot and referenced in the composer with `/`. | Must |
| S3 | Create a Skill by asking a Bot to save a completed process as a Skill (the Bot drafts it from the transcript), by writing it directly, or by importing it from GitHub: a link to a SKILL.md, a folder or a repository in the common Agent Skills format, or any markdown file. An imported Skill takes its name from the frontmatter (else the folder or file name), its content from the file, and records where it came from. No Bot uses it until the owner enables it. | Must |
| S4 | Teach a Skill by demonstrating a browser workflow on the computer; the recording becomes a draft Skill. | Later |
| R1 | A Routine tells one Bot when to run a prompt or Skill. Triggers: **schedule** (presets: every day at a time, weekdays, weekly on a day, monthly on a date, every N minutes for any N from 1 to 1440, plus custom cron) or **event**. | Must |
| R2 | Event triggers at 1.0: webhook POST (generic endpoint per Routine with token and signature verification), GitHub (issue created, merged, or closed; PR opened, merged, or closed; check failed; label added; comment contains text), Slack (message in channel, reaction added, channel created matching a pattern). Each trigger has a narrow matching rule. | Must |
| R3 | Routines live in the Bot's main interface (a Routines tab on the Bot), and every run posts into the Bot's transcript so the user can review the result or handle an exception there. | Must |
| R4 | Routines run in the background at lower priority than direct messages. A Bot owns up to 50 Routines; the 20 most recent run records per Routine are kept. | Must |
| R5 | A Bot can propose a Routine from conversation ("want me to do this every weekday at 8?") and create it after confirmation, shown as a "Routine created" widget. | Must |

### 4.8 Webhook endpoints

Grok Bot exposes webhooks only as a Routine trigger. OpenBots keeps that and adds a direct endpoint per Bot because self-hosters integrate with scripts and services that just want to "message the Bot."

| ID | Requirement | Priority |
| --- | --- | --- |
| H1 | Every Bot has an inbox endpoint: `POST /hooks/{bot}` with a token. The endpoint is created with the Bot, including on duplicate and from a template. Its token is shown once, when the owner generates it in the Bot's webhook settings. The payload becomes a message in the Bot's transcript and the Bot responds like it would to a user message, under a stricter default tool policy. | Must |
| H2 | Routine webhook triggers get their own endpoint with a matching rule and a template that turns the payload into the prompt. | Must |
| H3 | Verification: bearer token, path token, or HMAC signature with presets for GitHub, Slack, Stripe, and generic. Idempotency, size limits, rate limits, IP allowlists. | Must |
| H4 | Response modes: async (202 with a run id) and sync (wait up to 60 seconds and return the Bot's reply), plus handshake presets such as Slack `url_verification`. | Must |
| H5 | Delivery log with headers, body, verification result, linked run, replay, and a test-event form. | Must |
| H6 | Outbound: signed event subscriptions for message, run, approval, Routine, and Artifact events. | Must |

### 4.9 Artifacts

| ID | Requirement | Priority |
| --- | --- | --- |
| A1 | Bots create and update Artifacts: documents, code, data, designs, and files. Each has a title, kind, versions, and the run that produced it. | Must |
| A2 | Artifacts appear as cards in the transcript and open in a viewer with version history, download, and inline editing for text kinds. | Must |
| A3 | Files produced on the computer can be published as Artifacts; Artifacts can be sent into the computer's filesystem. | Must |
| A4 | An Artifacts view per Bot lists everything it has produced. | Must |

### 4.10 Memory

| ID | Requirement | Priority |
| --- | --- | --- |
| M1 | Each Bot keeps stable working preferences, important facts, and summaries of prior work. Memory is per Bot; conversation history is isolated per Bot. | Must |
| M2 | Users can view, edit, and delete a Bot's memories. | Must |
| M3 | Bots are instructed that memory is not a substitute for an authoritative source and should check current data for consequential decisions. | Must |

### 4.11 Approvals and safety

| ID | Requirement | Priority |
| --- | --- | --- |
| P1 | Bots handle work end to end and come back only when something needs approval or judgment. Approval requests are widgets with Approve and Deny, repliable in a thread. | Must |
| P2 | Content from webhooks, fetched pages, and other Bots is treated as data, never as instructions. | Must |
| P3 | Secrets are never shown after entry (of a provider key, admins see only the vendor prefix and last four characters, to tell keys apart); connector logins live at the account level and are not exposed to the sandbox. | Must |
| P4 | Enterprise-style controls (network controls, computer management, action recording). | Later |

### 4.12 Notifications

| ID | Requirement | Priority |
| --- | --- | --- |
| N1 | Desktop notifications for approvals, questions, sign-in requests (K8), mentions, Routine exceptions, and finished long tasks. Clicking opens the exact message. | Must |
| N2 | Menu bar item on macOS with pending approvals and quick actions. | Must |
| N3 | Web push for the PWA. | Later |

### 4.13 Accounts, sharing, and administration

Self-hosted (the default) is single-owner, one implicit organization: the setup wizard creates the one account, sign-up is then closed, and the admin controls below that only matter with members (audit log retention) keep their defaults. The owner still sets the limits (Settings > Limits) and the connector policy. U1, U3 and U5 to U8 as written are for the managed service.

The Mac app running OpenBots on This Mac has no sign-in at all. It is one person on their own computer, so there is no account concept in the UI: no sign-up, no account step in the setup wizard, no sign-in, no sign-out and no Account settings. The app opens signed in as the install's owner, and Settings starts with General, which holds the name Bots use to address the owner, notifications and API keys. A self-hosted server reached over the network or from a browser keeps the usual sign-in. Organizations, roles and invites are the managed service's (U5 to U8), through better-auth's organization plugin.

| ID | Requirement | Priority |
| --- | --- | --- |
| U1 | Managed: signing up verifies the email first. Signup mode is open (anyone signs up and creates an organization) or invite (only the first user and people with an invite link). Optional GitHub and Google sign-in. | Must |
| U2 | Each member owns their Bots, computer, connectors, and Skills library, in each organization they belong to; admins do not see them. | Must |
| U3 | Organization admin controls: connector allow and block list, limits (up to the service's ceiling), audit log retention. | Must |
| U4 | API keys for programmatic access to the same API the apps use, each working in the organization it was made in. | Must |
| U5 | Managed: someone who signs up without an invite creates an organization (one step, its name) and owns it; someone with an invite joins its organization and skips that step. A signed-in user can create more organizations and switch between them; the switcher shows with two or more. | Must |
| U6 | Managed: roles are owner, admin and member. Owners and admins invite (by email, with a copyable link when the service cannot send email), suspend, restore and remove members and change roles. Only an owner makes or removes an owner, and the last owner cannot leave or be demoted. | Must |
| U7 | Managed: suspending a member applies to one organization; their other organizations are untouched. Leaving or being removed ends access to that organization's data. | Must |
| U8 | Managed: an organization's audit log, read by its owners and admins. | Must |

### 4.14 Platforms and self-hosting

| ID | Requirement | Priority |
| --- | --- | --- |
| D1 | Docker Compose self-host is the default install: one command, a first-run wizard, migrations on start, backup and upgrade docs. | Must |
| D2 | Web app served by the server. Mac app (Apple silicon and Intel) with notifications, Keychain, deep links, menu bar, auto-update, and local stack management. On first launch the Mac app asks how to connect: sign in to an OpenBots account, connect to a self-hosted server, or run OpenBots on this Mac in Docker (which needs no sign-in, see 4.13). It remembers the choice, offers "Change connection…" in the app and tray menus, and shows one small icon in the sidebar for how it is connected and whether that connection is up. | Must |
| D3 | README documents exposing the instance through ngrok and Cloudflare Tunnel, including setting the public URL and protecting the UI while leaving webhook paths reachable. | Must |
| D4 | Windows and Linux desktop builds, PWA, mobile. | Later |

**Mobile** ([MOBILE_AND_VM_PLAN.md](MOBILE_AND_VM_PLAN.md) 2.1, extends D4, N1, N2). These M IDs are the plan's and are distinct from Memory's M1 to M3 (4.10); written alone they are "M1 (mobile)" and so on. Requirements the iOS app carries are marked (iOS app); the rest are the server's, the web app's or the Mac app's part.

| ID | Requirement | Priority |
| --- | --- | --- |
| M1 | (iOS app) The iOS app connects to a server three ways, as the Mac app does (D2): pair with a QR code (a self-hosted server or the Mac app's This Mac, over the relay or directly), sign in to a self-hosted server by address, or sign in to an OpenBots account. Several servers can be saved; one is active. | Must |
| M2 | Pairing is one scan. The QR code (or a pairing link sent to oneself) carries everything the phone needs, is good for 5 minutes and works once. The server shows it in Settings > Devices, the Mac app in its menu, and the server image prints it in the terminal (`openbots pair`). | Must |
| M3 | The phone reaches a server with no public address through the relay. The relay cannot read the traffic: every byte between phone and server is end-to-end encrypted with keys the relay never holds. When the server is reachable directly (a public URL or the same network), the app uses that path and the relay only as a fallback. | Must |
| M4 | (iOS app) The app shows the roster with live Bot state, each Bot's transcript and the groups, streams replies as they are written, and sends messages with photos and files. Approvals, questions and sign-in requests are answered in place, and an Inbox lists every pending one across Bots (N2's tray, on the phone). | Must |
| M5 | Push notifications for the same events as N1 (approvals, questions, sign-in requests, mentions, Routine exceptions, finished long tasks), opening the exact message. Their content is encrypted for the phone; the push gateway sees only that a notification exists. | Must |
| M6 | (iOS app) Work continues when the phone is closed (K4 holds). A reconnecting app catches up through `resync`, never losing a message. | Must |
| M7 | A device is listed in Settings > Devices with its name, platform and last use, and can be revoked there: its key stops working, its relay streams close and its push token is forgotten. | Must |
| M8 | (iOS app) Screen preview (view only), the activity log, Artifacts, and Routines (enable, run now) on the phone. | Should |
| M9 | (iOS app) Share sheet ("Send to a Bot"), Siri Shortcuts, a Home Screen widget with Bots at work, a Live Activity for a long task. | Later |
| M10 | (iOS app) Setting up providers, connectors, the computer's terminal and files stay on the desktop and the web. The phone shows them read-only at most. | Must (as a non-goal) |

**Server mode** ([MOBILE_AND_VM_PLAN.md](MOBILE_AND_VM_PLAN.md) 2.2, extends D1, D3).

| ID | Requirement | Priority |
| --- | --- | --- |
| V1 | One image runs the whole of OpenBots in one container with one persistent volume: server, Postgres, Redis and the Bots' computer. It starts on a platform that runs one container and no Docker inside it (Fly Machines, Sprites, Modal, Railway, Render), and on any Docker host. | Must |
| V2 | A fresh server pairs headlessly: `openbots pair` in the container's terminal prints the QR code before any owner exists, and the phone's onboarding creates the owner. No browser, public URL, DNS or TLS is needed to get going. | Must |
| V3 | The server stays reachable with no open port: it dials the relay out. A public URL remains optional (webhooks and connector OAuth need one, as today). | Must |
| V4 | `deploy/` carries a template per platform (Fly, Sprites, EC2 with the compose stack) and the README has a "Run OpenBots 24/7 on a VM" section with the cost and isolation trade-offs stated. | Must |
| V5 | Upgrades, backups and restore work for the standalone image with the existing scripts and `docker pull`. | Must |
| V6 | The standalone image is single tenant: `OPENBOTS_DEPLOYMENT=self_hosted` only. It refuses `managed`. | Must |

### 4.15 Models and providers

Bots need a model, and self-hosters want to point at whatever they already pay for or run locally. Providers are configured once; each Bot picks one model.

| ID | Requirement | Priority |
| --- | --- | --- |
| L1 | Built-in providers (Anthropic, OpenAI, Google, xAI) are enabled by adding a key in Settings > Models or in `.env`. The first-run wizard asks for at least one. | Must |
| L2 | Custom model providers: add any provider that speaks the OpenAI chat completions protocol or the Anthropic Messages protocol by giving it a name, base URL, optional API key, optional extra headers, and a list of models. Presets fill these in for OpenRouter, Groq, Together, Fireworks, DeepSeek, Mistral, Azure OpenAI, Ollama, LM Studio, vLLM, and LiteLLM. | Must |
| L3 | Model discovery and test: when the provider supports it, "Discover models" pulls its model list; "Test" sends a small request, checks streaming and tool calling, and reports what works. | Must |
| L4 | Each model carries capability flags (tools, vision, reasoning, context window) and optional pricing. Presets and the built-in catalog fill them in; users can edit them for custom model providers. The Bot model picker groups models by provider and hides models that lack what the Bot needs (for example vision and tools for a Bot with computer use). Cost estimates use the pricing when present. | Must |
| L5 | A Bot references a provider and a model; a provider in use cannot be deleted until its Bots are moved. Changing a Bot's model takes effect on its next run. | Must |
| L6 | Managed: providers at two levels. An organization's providers, added by its admins, serve every member's Bots; a member's own come first for their Bots. A self-hosted install has one list. | Must |
| L7 | Admin allowlist of models that members may pick. | Later |

---

## 5. Information architecture

```
Sidebar                         Main                              Right panel (on demand)
┌────────────────────┐  ┌────────────────────────────────┐  ┌────────────────────┐
│ New  (Cmd+N)       │  │ Bot name · label   [computer ●]│  │ Computer preview   │
│                    │  │────────────────────────────────│  │ (pinned, live)     │
│ Pinned             │  │ Transcript                     │  │                    │
│  ◉ Chief of Staff  │  │  prose · widgets · events      │  │ or Activity log    │
│  ◉ Researcher      │  │  artifacts · approvals         │  │ or Artifact viewer │
│                    │  │  threads · reactions           │  │ or Thread          │
│ Bots               │  │────────────────────────────────│  │                    │
│  ◉ Finance         │  │ Composer  / skills  @ bots  📎 │  │                    │
│  ◉ Support triage  │  └────────────────────────────────┘  └────────────────────┘
│                    │
│ Groups             │  Bot tabs (secondary, above transcript): Chat · Routines · Artifacts · Memory · Settings
│  # Launch week     │
│                    │
│ Connectors · Skills│  Account-level pages: Connectors, Skills library, Computer (files and attachments), Settings
│ Settings           │
└────────────────────┘
```

Key screens:

- **Bot transcript** (default): heterogeneous timeline, composer, title bar with computer status icon and a Preview toggle.
- **Computer takeover**: full-screen screen view with "Take control" and "Hand back". Nothing else.
- **Bot Routines tab**: list of Routines with trigger, last run, next run; run records (20) with result links into the transcript.
- **Bot Artifacts tab**, **Bot Memory tab**, **Bot Settings** (profile, model, tools and permissions, enabled Skills, the main Bot toggle, webhook settings).
- **Connectors** (`/connectors`; old `/tools` links redirect): the connectors a Bot's tools come from, with the catalog (an icon per connector), custom MCP, OAuth logins and the admin block list. Bot Settings keeps "Tools and permissions", since it sets approvals for every tool, built-in ones included, not only connector tools.
- **Computer**: terminal and the computer's files, with the account's attachments listed next to them. There is no separate Files page.
- **Skills library**: list, editor with a name and content, "used by" Bots, and Import from GitHub (pick the Skills a link holds, rename any, import them).
- **New chat**: pick two to six Bots.

---

## 6. Limits (defaults)

| Limit | Default | Source |
| --- | --- | --- |
| Bots per account | 50 | Design essay |
| Bots per group chat | 6 | Design essay and docs |
| Routines per Bot | 50 | Docs |
| Run records kept per Routine | 20 | Docs |
| Computers per account | 1 | Docs |
| Concurrent computer-use tasks per Bot | 1 | Docs |
| Webhook payload size | 1 MB | OpenBots |
| Sync webhook wait | 60 s | OpenBots |

The admin can change the other limits (B8, U3). One computer per account and one computer-use task per Bot at a time are fixed in 1.0: the data model and the screen lock build them in, so they are not settings.

---

## 7. Non-goals for v1

Multi-human group chats, mobile apps, demonstration-recorded Skills, enterprise controls, billing, and non-Docker computer providers. Each has a hook in the technical plan.

---

## 8. Open questions

1. Should a Bot have exactly one transcript (Grok Bot) or allow archived transcripts for a fresh start? Recommendation: one transcript, with a "start fresh" action that archives the old one and keeps memory.
2. How much of the avatar system to ship: generated SVG variations only, or also animated presets? Recommendation: generated SVG with six CSS motion states at 1.0.

---

## Sources

- xAI, "Designing Grok Bot": https://x.ai/news/designing-grok-bot
- xAI, "Introducing Grok Bot": https://x.ai/news/introducing-grok-bot
- Grok Bot docs: overview, bots, chat and collaboration, skills and routines, teams and enterprises, FAQ: https://docs.x.ai/grok-bot/overview
