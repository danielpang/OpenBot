# OpenBots: Technical Design and Implementation Plan

This document implements the PRD, which is anchored on xAI's "Designing Grok Bot" essay and the Grok Bot docs. Requirement IDs from the PRD (B1, C5, K3, R2, and so on) are referenced throughout so every subsystem and phase traces back to a product requirement.

Sections 1 to 15 are the system design. Sections 16 to 20 are the implementation plan.

---

## 1. Scope

OpenBots is a self-hosted Grok Bot: persistent Bots with identity, memory, tools, and a computer; one transcript per Bot; group chats of two to six Bots; Bot to Bot messaging; Skills at the account level and Routines per Bot with schedule and event triggers; webhook endpoints; Artifacts; a heterogeneous transcript with widgets; a web app and a Mac app; Docker Compose self-hosting with tunnel instructions.

Deliberate differences from Grok Bot: the computer is a Docker sandbox (Firecracker in Grok Bot), connectors are open (any MCP server), models are open (any OpenAI-compatible or Anthropic-compatible endpoint), every Bot also has a direct webhook inbox, and the whole thing runs on the user's own machine or VPS.

---

## 2. System architecture

```
┌──────────────┐    ┌───────────────┐    ┌──────────────────────────┐
│   Web app    │    │    Mac app    │    │ External systems         │
│ React (SPA)  │    │   Electron    │    │ GitHub, Slack, Stripe,   │
└──────┬───────┘    └───────┬───────┘    │ cron, scripts, Zapier    │
       │ HTTPS + WebSocket  │            └───────────┬──────────────┘
       └─────────┬──────────┘                        │ POST /hooks/...
                 ▼                                   ▼
┌───────────────────────────────────────────────────────────────────┐
│  openbots-server  (Node 22, TypeScript, Hono)                      │
│                                                                   │
│  REST API · WS gateway · Webhook ingress · Auth (better-auth)     │
│  Router (who replies) · Agent runtime (run workers) · Scheduler   │
│  Bot state + activity · Widgets · Artifacts · Skills · Routines   │
│  MCP client manager · Computer manager · Memory · Avatars         │
└──────┬──────────┬───────────┬──────────────┬──────────────────────┘
       │          │           │              │
  ┌────▼────┐ ┌───▼────┐ ┌────▼─────┐ ┌──────▼──────────┐   ┌───────────────┐
  │Postgres │ │ Redis  │ │ Files    │ │ Docker daemon   │   │ LLM providers │
  │+pgvector│ │ queue  │ │ local FS │ │ (socket proxy)  │   │ Anthropic,    │
  │         │ │pub/sub │ │ or S3    │ │                 │   │ OpenAI, xAI,  │
  └─────────┘ └────────┘ └──────────┘ └──────┬──────────┘   │ Google,Ollama │
                                             │              └───────────────┘
                     ┌───────────────────────▼────────────────────────┐
                     │ openbots-computer (one per account)             │
                     │ Ubuntu 24.04, one Xvfb screen per Bot,        │
                     │ Chromium per screen, control agent (exec, fs, │
                     │ browser via CDP, input), x11vnc + websockify, │
                     │ node-pty, wallpaper by time of day,           │
                     │ persistent volume at /home/bot,               │
                     │ shared cookie store synced across screens     │
                     └───────────────────────┬────────────────────────┘
                                             │
                     ┌───────────────────────▼────────────────────────┐
                     │ MCP servers: stdio (child processes) or remote │
                     │ Streamable HTTP with OAuth 2.1                 │
                     └────────────────────────────────────────────────┘
```

One server image runs three roles: `api` (HTTP and WebSocket), `worker` (runs, Routines, webhook jobs, memory extraction), and `all` (default for self-host). Splitting is a flag.

---

## 3. Technology choices

| Area | Choice | Why | Considered |
| --- | --- | --- | --- |
| Language | TypeScript everywhere | One type system across server, web, and desktop; the MCP SDK and the AI SDK are first class | Python (second frontend language), Go (weaker MCP and LLM tooling) |
| Runtime | Node 22 LTS | Stable, broad library support | Bun (native module and sandbox maturity risk) |
| Server | Hono with zod-openapi | Typed routes, generated OpenAPI, clean streaming and WebSocket support | Fastify, NestJS |
| Monorepo | pnpm workspaces + Turborepo | Cached builds, shared packages | Nx |
| Database | Postgres 16 + Drizzle ORM, pgvector | Relational fit for Bots, transcripts, Routines, Artifacts; vector search for memory without another service; Drizzle can target SQLite for a later lite mode | Prisma, SQLite only |
| Queue and pub/sub | Redis 7 + BullMQ | Durable priority queue for runs and webhook jobs, delayed jobs, pub/sub fan-out of streaming events | Postgres-only queue (later lite mode) |
| Scheduler | Postgres-backed ticker (`next_run_at` with `SKIP LOCKED`) + croner | Exactly-once, survives edits and restarts, no drift when Routines change | BullMQ repeatable jobs |
| Files | Local disk by default, S3 compatible optional | Zero config self-host | |
| LLM access | Vercel AI SDK with provider packages, plus custom model providers through the AI SDK's openai-compatible package and Anthropic-compatible base URLs | Uniform streaming, tools, multi-step across Anthropic, OpenAI, xAI, Google, and any OpenAI-compatible or Anthropic-compatible endpoint (OpenRouter, Groq, Together, Fireworks, DeepSeek, Mistral, Azure OpenAI, Ollama, LM Studio, vLLM, LiteLLM); provider options pass through model features | LiteLLM proxy as the only route, per-provider SDKs |
| Default model | Per configured provider: a new Bot gets its provider's catalog default model, with adaptive thinking on for Anthropic. Anthropic's catalog default is `claude-opus-5-5`. Small tasks (reply classifier, memory extraction, activity labels) use the provider's small model | | |
| MCP | `@modelcontextprotocol/sdk` client, stdio and Streamable HTTP, OAuth 2.1 with PKCE and dynamic client registration | Reference implementation | Provider-side MCP connectors (later optimization) |
| Auth | better-auth (email and password, GitHub and Google OAuth, sessions, API keys; the Mac app's local mode signs its owner in with a local token instead, 14.4; organizations, roles, invitations and email verification on the managed service through its organization plugin, section 21) | Drizzle adapter, single container | Auth.js, Lucia |
| Realtime | WebSocket (`ws`) with a JSON event protocol; SSE for run streams | Bidirectional needed for terminal and screen control | Socket.IO |
| Web app | React 19, Vite, TanStack Router and Query, Tailwind v4, shadcn/ui, xterm.js, noVNC, react-markdown, shiki, CodeMirror for Artifacts | SPA served from the server container | Next.js |
| Avatars | `packages/avatars`: deterministic SVG generator with CSS motion states | One visual system, animates for state, renders on server for notifications | Static image packs |
| Mac app | Electron around the same React build | Bundled Chromium gives identical rendering on every OS for the screen and terminal views, mature packaging (electron-builder, electron-updater, notarization), JavaScript-only toolchain with no Rust shell, one UI | Tauri v2 (smaller binary, but a Rust shell and WKWebView), SwiftUI native (later option) |
| Sandbox | Docker image `openbots-computer` (Ubuntu 24.04, Xvfb, Chromium, Playwright, x11vnc, websockify, xdotool, node-pty, feh) | Runs anywhere Docker runs, including Docker Desktop and OrbStack | Firecracker, E2B (future providers) |
| Observability | pino, optional OpenTelemetry, Prometheus endpoint | | |
| Testing | Vitest, Playwright, Testcontainers | | |
| CI and release | GitHub Actions, multi-arch images to GHCR, electron-builder with optional notarization, one `v*` tag releasing the images, the Mac app and a GitHub Release (DMG, compose bundle, per-architecture image archives, SHA256SUMS), with a dry run on pull requests that change the release files | A release is one deliberate act, the Mac app's version always matches the images it runs, and users download everything from one page | release-please |

---

## 4. Domain model

All tables carry `workspace_id`, the organization (one implicit organization on a self-hosted install, many on the managed service; section 21), and, where ownership matters, `owner_id` (a user). Ownership follows the PRD: Bots, the computer, connectors, and the Skills library belong to a user (U2, T1, S2, K1); memory and Routines belong to a Bot (M1, R3).

### 4.1 Bots and identity (B1 to B8, I1, I2)

| Table | Key columns | Notes |
| --- | --- | --- |
| `bots` | id, owner_id, handle (unique `@slug`), name, label, description, avatar jsonb, model_config jsonb, tool_policy jsonb, pinned, hidden, is_main boolean, archived_at, created_at | `avatar`: generator params (seed, shape, palette, eyes, accessory) or an uploaded file id. `description` holds standing rules (B3). `model_config`: provider, model, temperature, reasoning, max_steps. `is_main` marks the owner's main Bot for sign-in requests (K8); a partial unique index on `owner_id` where `is_main` allows at most one per owner. A new Bot gets `is_main` when its owner has no main Bot, so a member's first Bot is it (`insertBot`, under the owner's roster lock); migration `0018_first_bot_main` marked each existing member's earliest visible Bot. Duplicates never copy `is_main` (B5). A Bot is created from a name and an avatar alone, and its transcript opens with its own message asking what to work on, written with the Bot and costing no model call (B2); migration `0020_drop_templates` dropped `bot_templates` and `template_id` |
| `bot_state` | bot_id, state (`idle`, `thinking`, `working`, `waiting`, `blocked`, `done`), current_action, run_id, updated_at | Denormalized for the roster (I2, I3) |

### 4.2 Chats and messages (C1 to C9)

| Table | Key columns | Notes |
| --- | --- | --- |
| `chats` | id, owner_id, type (`bot_dm`, `group`, `bot_to_bot`), title, settings jsonb, summary, summary_through_seq | `bot_dm` is unique per (owner, bot): the Bot's one transcript (B4). `bot_to_bot` is unique per unordered Bot pair and visible to the owner (C6) |
| `chat_members` | chat_id, member_type (`user`, `bot`), member_id, joined_at | Group cap enforced in code (B8) |
| `messages` | id, chat_id, seq bigint, updated_seq bigint, thread_root_id, author_type (`user`, `bot`, `system`, `webhook`, `routine`), author_id, parts jsonb, mentions uuid[], mention_everyone bool, run_id, status (`complete`, `streaming`, `failed`), created_at | `parts`: ordered array of text, image, file, tool_call, tool_result, reasoning, widget, event, artifact, skill_ref (C2, W1, W3) |
| `message_deletions` | message_id, chat_id, message_seq, thread_root_id, seq, created_at | A streaming Bot message deleted before it showed anything, with the chat seq its deletion took, for resync (14.2) |
| `reactions` | message_id, reactor_type, reactor_id, emoji | C8 |
| `widget_states` | message_id, part_index, state jsonb, pending_run_id, updated_at | Interactive widget state and which run is waiting on it (W2) |

### 4.3 Runs (execution)

| Table | Key columns | Notes |
| --- | --- | --- |
| `runs` | id, bot_id, chat_id, trigger (`message`, `mention`, `bot_message`, `bot_dm`, `widget_action`, `webhook`, `routine`, `resume`), priority, status (`queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`), parent_run_id, routine_run_id, depth, model, usage jsonb, state jsonb, error, started_at, finished_at | `state` holds serialized model messages while waiting for approval or a widget |
| `run_steps` | id, run_id, idx, type (`llm`, `tool_call`, `tool_result`, `approval`, `steer`, `error`), label, payload jsonb, tokens_in, tokens_out, duration_ms | `label` is the activity log line (I4) |
| `approvals` | id, run_id, message_id, tool_name, args jsonb, reason, status (`pending`, `approved`, `denied`, `expired`), decided_by, decided_at, expires_at | P1 |

### 4.4 Tools (T1 to T5)

| Table | Key columns | Notes |
| --- | --- | --- |
| `connectors` | id, owner_id, name, slug, kind (`mcp_stdio`, `mcp_http`, `builtin`), config jsonb, secrets bytea, status, last_error, last_checked_at | Account level |
| `connector_tools` | connector_id, name, title, description, input_schema jsonb, annotations jsonb, last_seen_at | Cached tool list |
| `bot_connectors` | bot_id, connector_id, tool_allowlist text[], tool_denylist text[], approval_override | Per-Bot permissions |
| `connector_policy` | catalog_id or url_pattern, blocked bool, set_by | Admin block list; shows "Disabled by admin" (T3) |

### 4.5 Computer (K1 to K7)

| Table | Key columns | Notes |
| --- | --- | --- |
| `computers` | id, owner_id (unique), provider (`docker`, `remote`), spec jsonb, status, container_id, agent_url, agent_token bytea, volume_name, always_on, idle_timeout_min, last_used_at | One per account (K1) |
| `bot_screens` | bot_id, computer_id, display_number, browser_profile_dir, cdp_port, status, controlled_by_user_id, controlled_since | One screen per Bot (K2) with its own Chromium profile in `browser_profile_dir`; cookies sync between profiles through the control agent's shared store (K1, section 9.6); `controlled_by_user_id` set during takeover (K3) |

### 4.6 Prompts: Skills and Routines (S1 to S3, R1 to R5)

| Table | Key columns | Notes |
| --- | --- | --- |
| `skills` | id, owner_id, name, slug, summary, body_md, source (`manual`, `saved_from_run`, `demonstration`, `imported`), created_from_run_id, origin jsonb, created_at, updated_at | `body_md` is the Skill's markdown content and `summary` its first line of text (S1). One library per account (S2). `origin` (imported Skills only, S3): the GitHub link, repository, ref and commit SHA, the Skill's path and its license. The older `sections` and `status` columns are kept, nullable and unused, by the `skills_content` migration |
| `bot_skills` | bot_id, skill_id, enabled | |
| `routines` | id, bot_id, name, slug, trigger jsonb, prompt_md, skill_id, chat_id, enabled, timezone, next_run_at, last_run_at, created_at | `trigger`: `{type:'schedule', preset, cron | every_minutes}` or `{type:'event', source:'webhook'|'github'|'slack', endpoint_id, match: {...}}` (R1, R2). Cap 50 per Bot (R4) |
| `routine_runs` | id, routine_id, run_id, started_at, finished_at, status, result_message_id, exception text | Trimmed to the 20 most recent per Routine (R4) |

### 4.7 Webhooks (H1 to H6)

| Table | Key columns | Notes |
| --- | --- | --- |
| `webhook_endpoints` | id, bot_id, routine_id (nullable), slug, token_hash, signature jsonb (preset, header, secret encrypted), match jsonb, template_md, response_mode (`async`, `sync`), sync_timeout_s, tool_policy_override jsonb, allowed_ips cidr[], rate_limit_per_min, enabled | `routine_id` null means the Bot inbox (H1), created with the Bot and without a token until the owner generates one; set means a Routine event trigger (H2) |
| `webhook_deliveries` | id, endpoint_id, received_at, remote_ip, headers jsonb, body_ref, body_preview, verified, matched, status, run_id, error | H5 |
| `event_subscriptions` | id, owner_id, url, events text[], secret bytea, enabled | H6 |
| `event_deliveries` | id, subscription_id, event, payload jsonb, attempts, status, last_error, next_attempt_at | |

### 4.8 Artifacts, memory, files (A1 to A4, M1 to M3)

| Table | Key columns | Notes |
| --- | --- | --- |
| `artifacts` | id, owner_id, bot_id, chat_id, kind (`document`, `code`, `data`, `design`, `file`), title, current_version_id, created_at, updated_at | |
| `artifact_versions` | id, artifact_id, version, storage_key, mime, size, summary, created_by_run_id, created_by_user_id, created_at | Every edit is a new version (A2) |
| `bot_memories` | id, bot_id, kind (`preference`, `fact`, `summary`), content, embedding vector, source_run_id, created_at, updated_at | |
| `files` | id, owner_id, name, mime, size, storage_key, sha256, created_at | Attachments and artifact blobs |
| `audit_log` | id, actor_type, actor_id, action, target_type, target_id, metadata jsonb, created_at | |

### 4.9 Secrets at rest

Every secret column is AES-256-GCM ciphertext with nonce and key version under `OPENBOTS_MASTER_KEY`. Rotation re-encrypts in a background job. The API never returns secrets (P3).

### 4.10 Models and providers (L1 to L5)

| Table | Key columns | Notes |
| --- | --- | --- |
| `providers` | id, owner_id (null for instance-level), kind (`anthropic`, `openai`, `google`, `xai`, `custom`), protocol (`native`, `openai_compatible`, `anthropic_compatible`), name, slug, base_url, headers jsonb, secrets bytea, discovery (`manual`, `list_models`), preset_id, status, last_tested_at, test_result jsonb | Built-ins are seeded from `.env` keys at start; custom model providers are created in Settings (L1, L2) |
| `provider_models` | provider_id, model_id, display_name, capabilities jsonb (tools, vision, reasoning, context_window, max_output), pricing jsonb (input, output, cached per 1M tokens), enabled, source (`catalog`, `discovered`, `manual`) | Feeds `GET /models` and the picker (L3, L4) |

`bots.model_config.provider` holds the provider id and `model` the model id; deleting a provider with Bots attached is refused (L5).

---

## 5. Agent runtime

A run is one unit of Bot work in one chat. Runs are BullMQ jobs processed by workers, so Bots keep working when every client is closed (K4).

### 5.1 Triggers and priority (C3, R4)

| Trigger | Source | Priority |
| --- | --- | --- |
| `message` | Owner posts in the Bot's transcript | 1 (highest) |
| `mention` | The owner @mentions the Bot in a group, or another Bot's reply does | 1 from the owner, 2 from a Bot |
| `widget_action` | Owner clicks a widget that starts new work | 1 |
| `resume` | Approval decided, a question answered, or a sign-in done (K8) | 1 |
| `bot_message` | The owner posts in a group without naming a Bot, and the router decides this Bot should reply | 2 |
| `bot_dm` | Another Bot messaged this Bot | 2 |
| `webhook` | Bot inbox delivery | 2 |
| `routine` | Scheduler or matched event | 3 (background) |

A run that a Bot's @mention starts is queued at priority 2, not 1 (`apps/server/src/services/router.ts`), so work a Bot asks for never jumps ahead of the owner.

The trigger says how a run started, not who wrote what started it. A `mention` can come from the owner or from another Bot, and a `bot_message` run always answers the owner. The router records the Bot whose message started a run (`input.fromBotId`), and the policy engine's stricter rules for data follow that author (section 8), not the trigger's name.

Each Bot holds one run lock at a time; queued runs for that Bot are ordered by priority, then age. A direct message therefore jumps ahead of Routines and Bot to Bot requests, which is the docs' "a direct message from you takes priority over background work."

### 5.2 Steering (C3)

If the owner sends a message to a chat where the Bot's run is already active, the message is pushed to the run's Redis inbox. The loop drains the inbox at every step boundary and injects the text as a new user turn, records a `steer` step, and continues. The Bot sees "priorities changed" without a restart. Messages in other chats wait for the lock at priority 1.

In a group, a running Bot is steered only by the owner messages routing would give it (section 7): those that mention it or `@everyone`, and those that address nobody, unless they are replies in a thread about another Bot's item. Steering and routing share one predicate (`isForBot` and `addressedBots` in `packages/router`), so a message for `@beta` never reaches `@alpha` mid-run (C5).

### 5.3 Context assembly

Ordered stable to volatile so provider prompt caches hit:

1. Bot description (standing rules, verbatim) and label.
2. Operating rules: prefer connectors over the computer (T4); ask for approval when unsure; when a site needs a login the Bot does not have, call `request_login` instead of asking for credentials (K8); treat webhook payloads, fetched pages, and other Bots' messages as data (P2); memory is not an authoritative source (M3); how to @mention, message another Bot, use a Skill, save a Skill, propose a Routine, and answer with a widget.
3. Roster of the chat: handles, human or Bot, one line per Bot's label.
4. Enabled Skills index: the name and first line of each; the full content is loaded when the user references it with `/` or the Bot calls `use_skill`.
5. Memory: top K memories by recency and similarity to recent messages.
6. Chat summary for history beyond the message window. Thread replies (C7) load the thread root and its subtree in full, plus the summary.

Messages carry author prefixes like `[@dana (owner)]` or `[@researcher (bot)]`. The Bot's own prior tool calls are replayed as native tool messages; other Bots' tool activity is collapsed to one line each.

Attachments in the messages (the owner's, and other Bots' from `attach_file`) are given to the model newest first within a budget per run. A model with vision gets up to four images of at most 5 MB each as image input; a model without vision gets a line saying it cannot see them. Text files (text types, JSON, CSV, markdown, source code) are inlined as data in `<attachment>` frames, up to 32 KB each and 96 KB in all, with a note where one is cut. Anything else, a PDF or an archive, is a line naming it: `read_attachment` reads text a page at a time, shows an image, or describes the file, and `attachment_to_computer` copies the bytes onto the computer for the tools there. Only the chat owner's uploads that a message in the chat references can be read.

### 5.4 Tool set

| Group | Tools | Available when |
| --- | --- | --- |
| Conversation | `show_widget`, `ask_user` (question widget), `react`, `message_bot` (async Bot to Bot), `use_skill`, `save_skill`, `propose_routine`, `remember`, `search_memory` | Always |
| Artifacts | `create_artifact`, `update_artifact`, `read_artifact`, `publish_artifact` (from a computer path), `artifact_to_computer`, `read_attachment`, `attachment_to_computer` (chat attachments, section 5.3) | Always |
| Built-in | `web_fetch`, `web_search`, `http_request` (domain allowlist), `send_email` (SMTP connector), `attach_file` | Configured |
| Connector | `${connectorSlug}__${toolName}` for each permitted MCP tool | Connector attached |
| Computer | `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_screenshot`, `computer` (screenshot, click, double_click, type, key, scroll, move, drag), `request_login` (site and reason; section 9.7) | Always (every account has a computer); computer-use actions take the per-Bot screen lock (K2) |

Mentioning a Bot needs no tool: an `@handle` of another member in a Bot's group reply wakes that Bot (section 7). Outside a group, `message_bot` reaches another Bot.

Above roughly 40 tools the runtime exposes a `search_tools` meta-tool and loads schemas on demand. Names are normalized to provider limits with a reversible map.

### 5.5 The loop

```ts
export async function executeRun(run: Run, deps: Deps) {
  const ctx = await assembleContext(run, deps);
  const message = await deps.messages.createStreaming(run);
  await deps.botState.set(run.bot_id, 'thinking', run.id);

  const result = streamText({
    model: deps.models.resolve(ctx.bot.model_config),
    system: ctx.system,
    messages: ctx.messages,
    tools: ctx.tools,                              // each execute() is wrapped by gated() below
    stopWhen: stepCountIs(ctx.bot.model_config.max_steps ?? 40),
    abortSignal: deps.cancellation.signalFor(run.id),
    providerOptions: ctx.providerOptions,
    prepareStep: async () => deps.steering.drain(run.id),   // inject owner messages between steps
    onStepFinish: (step) => deps.activity.record(run.id, step),  // writes run_steps with labels
  });

  for await (const part of result.fullStream) {
    await deps.stream.publish(run.chat_id, part);
    await deps.messages.appendPart(message.id, part);
  }

  await deps.messages.finalize(message.id, await result.usage);
  await deps.botState.set(run.bot_id, 'done', run.id);      // settles to idle after a moment
  await deps.memory.extract(run);
  await deps.router.afterBotMessage(message);
}

async function gated(tool, args, run) {
  const decision = policy.evaluate(run, tool, args);          // auto | ask | deny
  if (decision === 'deny') return { error: 'Denied by Bot policy' };
  if (decision === 'ask') throw new NeedsApproval(tool, args);
  await botState.set(run.bot_id, 'working', run.id, labelFor(tool, args));
  return tool.execute(args);
}
```

### 5.6 Waiting: approvals, questions, widgets (P1, W2)

When a tool needs approval, or the Bot calls `ask_user`, or a widget awaits input, the worker: posts the widget into the transcript, writes an `approvals` or `widget_states` row with `pending_run_id`, persists the model messages into `runs.state`, sets the run to `waiting` and the Bot state to `waiting`, and exits the job. The owner's decision (approve, deny, answer, button click) enqueues a `resume` job that rehydrates the messages, executes the tool or injects the answer as a tool result, and continues. Thread replies on the approval message are attached to the resume as extra context (C7). Approvals expire after 24 hours by default. `request_login` waits the same way on a `login_request` widget, which can hold several waiting runs (section 9.7).

### 5.7 Cancellation, retries, failures

Cancel sets a Redis key and fires the AbortController. Provider rate limits and 5xx retry with backoff. Context overflow rebuilds with a smaller window once. A run that resumes after a wait or continues after a crash keeps its own steps (tool calls that already ran, steering) and retries once without the oldest half of the transcript messages before them, cut at a user message; the serialized state and the checkpoint record how many leading messages came from the transcript (`contextLength`). On failure the message is finalized as `failed`, a compact event row explains why, and the Bot state becomes `blocked` until the owner opens the transcript.

Without Redis the queues live in the one process, so its jobs die with it. On start that process queues again, oldest first, every run the database still shows as `running` (taken over from its checkpoint) or `queued` (a new run, or a resume waiting for the Bot's lock). With Redis the queue keeps its jobs and re-delivers stale ones.

### 5.8 Usage

Tokens per step, estimated cost from a pricing table, shown in the activity log and on the Bot's settings page. Usage stays out of the transcript by default (principle 10).

### 5.9 Provider registry and custom model providers (L1 to L5)

- The registry loads `providers` and `provider_models` and resolves a Bot's `model_config` to an AI SDK model: native kinds use their provider package; `openai_compatible` uses `createOpenAICompatible({ baseURL, apiKey, headers })`; `anthropic_compatible` uses `createAnthropic({ baseURL, apiKey, headers })`. Instances are cached per provider and rebuilt when its row changes.
- Presets live in `packages/models/catalog.json`: base URL, protocol, auth header, discovery support, and known models with capabilities and pricing for OpenRouter, Groq, Together, Fireworks, DeepSeek, Mistral, Azure OpenAI (base URL with deployment and `api-version`), Ollama (`/v1`), LM Studio, vLLM, and LiteLLM. Built-in providers carry the same catalog data.
- Discover: `POST /providers/:id/discover` calls `GET {base_url}/models` on OpenAI-compatible endpoints and merges results into `provider_models` as `discovered`, keeping user edits.
- Test: `POST /providers/:id/test` runs a one-token streamed completion, then a tiny tool-call round trip, and stores `{streaming, tools, latency_ms, error}`; the UI shows the result and flips capability flags the test disproves.
- Capability gating: the picker filters by what the Bot needs (tools always; vision when the Bot uses its computer); the runtime also checks at run start and posts a `blocked` event with a fix ("this model does not support tool calling") rather than failing mid-run.
- Small model for background tasks: the registry picks the cheapest enabled model with tools on the same provider; the owner can override it in Settings > Models.
- Cost: `provider_models.pricing` replaces the static pricing table; missing pricing shows "no estimate" instead of a guess.

---

## 6. Bot state and activity (I2 to I5)

### 6.1 State machine

| State | Set when | Cleared when |
| --- | --- | --- |
| `idle` | No active run | |
| `thinking` | Run active, model generating without a tool in flight | Tool starts or run ends |
| `working` | A tool is executing | Tool returns |
| `waiting` | Run is `waiting` on approval, question, widget, or sign-in (K8) | Resume |
| `blocked` | Run failed, connector needs login, computer unavailable | Owner opens the transcript or the next run starts |
| `done` | Run completed | Three seconds later, to `idle` |

State changes publish `bot.state {bot_id, state, current_action, run_id}` and update `bot_state`. The roster avatar animates on this event; the title bar's Preview button shows a green dot when `current_action` is a computer tool (I5).

### 6.2 Activity labels

Every step gets a one-line label, produced deterministically by the tool (no model call) so it is instant and cheap:

| Step | Label |
| --- | --- |
| Computer start | `Environment ready 387ms` |
| `edit_file` | `Edited math.ts +14 −10` |
| `read_file` | `Read AGENTS.md` |
| `bash` | `Ran npm test` then `212 passed` or `exit 1` |
| `browser_navigate` | `Opened github.com` |
| `web_search` | `Searched web 'toFixed'` |
| MCP tool | `GitHub: Create issue` (connector name plus tool title) |
| LLM step without tool | `Thought briefly` or `Thought for 12s` |
| `create_artifact` | `Created "Q3 summary"` |
| Approval wait | `Waiting for approval: send email` |
| `request_login` wait | `Waiting for sign-in: github.com` |

The current label is the hover text (I3). The full list with durations is the activity log panel (I4).

---

## 7. Routing: who replies (C4 to C6, C9)

```ts
async function route(message: Message) {
  const chat = await chats.get(message.chat_id);
  const bots = await chats.botMembers(chat.id);
  const targets = [];

  if (chat.type === 'bot_dm' && message.author_type !== 'bot') targets.push([bots[0], 'message']);
  else if (chat.type === 'bot_to_bot' && message.author_type === 'bot') targets.push([other(bots, message.author_id), 'bot_dm']);
  else {
    const candidates = bots.filter((bot) => !(message.author_type === 'bot' && message.author_id === bot.id));
    const directed = message.mention_everyone || message.mentions.length > 0;
    if (directed) {                                                      // mentions direct only those Bots
      for (const bot of candidates)
        if (message.mention_everyone || message.mentions.includes(bot.id)) targets.push([bot, 'mention']);
    } else if (message.author_type !== 'bot') {                          // Bots reach Bots only by mention or DM
      for (const bot of candidates)
        if (await shouldReply(bot, chat, message)) targets.push([bot, 'bot_message']);
    }
  }

  for (const [bot, trigger] of targets) {
    if (!withinChainLimits(chat, message, bot)) { await postEvent(chat, 'Stopped a Bot loop'); continue; }
    await runs.enqueue({ bot_id: bot.id, chat_id: chat.id, trigger, parent_run_id: message.run_id, depth: depthOf(message) + 1 });
  }
}
```

- `shouldReply` is one small structured-output call per Bot (`{reply, reason}`) over the last few messages and each Bot's label and description. It implements "write normally to let the participating Bots decide who should respond" (C5). It runs only for owner messages with no mentions and no `@everyone`.
- Mentions: a message that mentions one or more Bots, or uses `@everyone`, enqueues only those Bots with trigger `mention`, and no `shouldReply` call goes to the other members (C5). Only the owner's `@everyone` wakes the group: a Bot's `@everyone` wakes nobody, so a Bot must name the Bots it hands work to.
- An owner message in a group drops the queued Bot-triggered runs in its thread (or at the top level): a handoff from an earlier chain does not run after the owner has moved on. A Bot already running is steered by the message instead, and a compact event row says how many handoffs were dropped.
- Threads (C7): an owner's thread reply that mentions nobody goes to the Bot that wrote the thread's root (its result, approval request or question), with no `shouldReply` call. It reaches that Bot as a message in its transcript would: a reply on a pending approval or question attaches to the waiting run, which reads the thread when it resumes, and any other reply steers or starts a run in the thread. A mention in the thread still directs it to the mentioned Bots.
- Bots at work: an owner message that addresses nobody goes, without a `shouldReply` call, to each Bot with a run going in its thread (or top level) or waiting there on a question, as steering or as the typed answer to the question. The other members are asked as usual.
- A mentioned Bot can bring others in by @mentioning them in its reply. That reply passes through `route()` like any other message, so only the Bots it mentions are enqueued.
- Bot to Bot: `message_bot` writes into the pair's `bot_to_bot` chat and enqueues the receiver at priority 2; the receiver "wakes, handles the request, and can reply later" (C6). The owner sees these chats under the Bot's transcript as a collapsible section.
- Loop guards: `depth` capped at `max_chain_depth` (default 4) and a rolling budget of Bot-triggered runs per chat per 10 minutes (default 10), both posting a visible event row when hit. A chat's `settings` may override both (`max_chain_depth`, `bot_run_budget`), but no API or UI sets them in 1.0: the defaults apply unless an operator writes them in the database.
- No coordination UI. A "Chief of Staff" is just a Bot whose description says to route work to the others (principle 8).

---

## 8. Tools: connectors and MCP (T1 to T5)

- Connectors are owned by the user and available to all of their Bots (T1). Per-Bot allowlists and approval overrides live in `bot_connectors`.
- Kinds: `mcp_stdio` (child process under an unprivileged user with only its own secrets in env, or, with `OPENBOTS_STDIO_RUNNER=computer`, a process in the owner's computer; see below), `mcp_http` (Streamable HTTP; bearer or OAuth 2.1 with PKCE and dynamic client registration; tokens encrypted and refreshed), `builtin` (in process).
- The MCP client manager keeps one session per connector, starts lazily, stops on idle, health checks, caches tools in `connector_tools`, and refreshes on `tools/list_changed`. Resources and prompts are listed for later use. A connector that has not listed its tools since it was added or its settings changed (status `untested`) is started when a run of one of its owner's Bots begins, so one added through the API or saved without Test still offers its tools; the run waits up to 15 seconds for it, and a failure is recorded on the connector. Blocking, editing or deleting a connector, or turning custom stdio servers off, stops its session in every process (API and workers) through the `openbots:mcp-control` channel of the event bus.
- OAuth redirect URI is `${OPENBOTS_PUBLIC_URL}/api/v1/connectors/oauth/callback`, which is why the public URL must be right when tunneling.
- One-click Connect: for a catalog entry with `dynamic_registration` (Cloudflare, Vercel, Supabase, Neon, Railway), Connect creates the connector and calls `GET /connectors/:id/oauth/start?mode=` at once; required settings and keys are asked for first. A pasted URL goes through `POST /connectors/discover` first, an unauthenticated `initialize` plus RFC 9728 and RFC 8414: `none` is just added, `oauth` with a registration endpoint signs in at once, `oauth` without one asks for the owner's own client under Advanced (with the callback URL to register), `bearer` asks for a token, and an unreachable URL (a private address, S-8) is added as is. GitHub, Slack, Gmail and Google Docs offer neither dynamic registration nor client metadata documents, so they still need the owner's OAuth app, entered under Advanced.
- Where the provider's page opens (`mode`): the web app opens a popup in the click (`popup`), falling back to a new tab, then a link; the Mac app opens the default browser through the preload bridge (`window.openbots.oauth.open`, `shell.openExternal`; `external`), never an embedded window, so saved passwords and passkeys work and providers allow it. The navigation gate sends any authorization request whose `redirect_uri` is the connector callback to the default browser. `redirect` (the default for API callers) keeps the old same-tab flow.
- The callback checks the state `<connectorId>.<nonce>`: the nonce is compared in constant time with the sealed pending flow, which is single use, expires after 10 minutes and records the user who started it and its mode. It needs that user's session, and a session for another user is always refused. The one exception is an `external` flow on a self-hosted install (`OPENBOTS_DEPLOYMENT=self_hosted`): the Mac app's default browser may hold no session, and only the one owner can start a flow, so the state suffices. On `managed` such a browser sees "Sign in to OpenBots in this browser, then try again." and the flow stays pending; binding it to the app with a one-time handoff comes with the managed service. It answers a small self-contained HTML page (dark theme, the app icon inline, a per-response CSP nonce for its one script, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`): "<Provider> is connected. You can close this window.", or the reason and "You can close this window and try again." In a popup it posts `{type, status, connectorId}` (never a token) to its opener at the public origin and closes on success; in the default browser it links back with `openbots://connectors`. A `redirect` flow still redirects to `/connectors?oauth=connected|error`.
- Back in the app: the outcome is published as `connector.updated` to the owner's sockets, so every open page refreshes the card (Connected) without a reload, the page that started the flow tests the connector for its tools, and in the Mac app the window comes back to the front (`window.openbots.oauth.finished`, honoured once per sign-in it opened, within 10 minutes). A connector whose tokens expired or were revoked (`needs_auth`) shows one Reconnect button that runs the same flow.
- Catalog in `packages/mcp/catalog.json`: transport, command or URL, required secrets, OAuth metadata, icon, pinned version. The Connectors page renders it as one-click cards; users can also paste `{"mcpServers": ...}` JSON (T2).
- Who may add what (T2, S-1): every member can add catalog servers, stdio ones included, because those run the catalog's pinned command (a pasted or typed command that matches a catalog entry runs that entry's command), and any Streamable HTTP server. A custom stdio command runs a program on the OpenBots server, so only a workspace admin can add one, and only while the workspace setting `customStdioEnabled` is on (off by default, switched in "Admin: connector policy" on the Connectors page). A pasted `mcpServers` document is imported server by server: the allowed ones are created and each refused one comes back in `errors` with the reason and what to do instead (the catalog entry or an HTTP URL). Turning the setting off stops the running custom stdio sessions and hides their tools.
- Admin block list (`connector_policy`) hides or disables catalog entries and URL patterns with the label "Disabled by admin" (T3).
- Policy engine inputs: Bot `tool_policy`, connector override, MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`), tool group, trigger type, and who wrote what started the run (the owner, another Bot, or a webhook). Defaults: reads auto; `bash`, file writes, non-GET `http_request`, `send_email`, and destructive MCP tools ask. Webhook and Routine triggers can carry a stricter override (T5).
- Stricter floor for data (P2): a run that another Bot's message or webhook data started asks before any tool that can change something, even where the Bot's own setting is auto. The floor follows the author, not the trigger: a Bot to Bot message (`bot_dm`) and a Bot's @mention in a group (`mention` from a Bot) both get the `bot_dm` entry of `tool_policy.triggers`, and an inbox run or a Routine run a delivery started both get the `webhook` entry. The owner's own messages, including an unaddressed group message (`bot_message`), get no floor. The owner lifts a floor only with an explicit `default: 'auto'` on that entry.
- Where stdio servers run (`OPENBOTS_STDIO_RUNNER`): `host` (self-hosted default) runs them as children of the server process; `computer` (managed default) runs each in the computer of the account that owns the connector, in its organization, behind the same `McpHost` interface (`ComputerStdioHost`). The server opens the agent's `WS /mcp/stdio`, sends the command, args, env (the connector's secrets) and folders to create, and relays MCP's stdin and stdout as JSON frames; closing the socket stops the process. The computer image bakes `docker/mcp-catalog` from its lockfile at `/opt/openbots/mcp`, and the filesystem root is a folder under `/home/bot`. Using a connector starts the computer when it is off; a crash restarts with backoff (1 s doubling to 60 s, 5 in a row) unless the computer has stopped; stopping the computer stops its owner's servers through `openbots:mcp-control`; a busy server marks the computer used every 30 s. With no computer, or one that does not start, the connector shows the error. The managed service refuses `host` unless `OPENBOTS_ALLOW_HOST_STDIO=1` (with a warning at start).

---

## 9. The computer (K1 to K7)

### 9.1 Topology

One `openbots-computer` container per account, created on first use, persistent volume at `/home/bot`. Each Bot gets a screen: Xvfb display `:10+n`, a window manager, and Chromium with its own user data dir and remote debugging port, so Bots browse in parallel without sharing tabs or windows (K2). Files under `/home/bot` are shared by all of the account's Bots. Browser logins are shared too: the control agent syncs cookies between the Bots' profiles through one shared store, so a site signed in on one screen is signed in on every screen (K1, section 9.6). A per-Bot screen lock allows one computer-use task per Bot at a time; Bots run in parallel on separate screens.

### 9.2 Provider interface

```ts
export interface ComputerProvider {
  create(spec: ComputerSpec): Promise<ComputerRef>;
  start(ref): Promise<void>; stop(ref): Promise<void>; destroy(ref): Promise<void>;
  status(ref): Promise<ComputerStatus>;
  agent(ref): ComputerAgentClient;
}
```

`docker` (dockerode through a socket proxy or `DOCKER_HOST`) is v1. `remote` points at a control agent on any VM. `firecracker`, `e2b`, and `daytona` are future providers (K6).

A `remote` agent is one machine for the whole install, with one `/home/bot` and one cookie store, so it cannot give each account a computer of its own (K1). The first account to use it keeps it and other accounts get `COMPUTER_UNAVAILABLE`, unless the operator sets `OPENBOTS_COMPUTER_AGENT_SHARED=true`, which lets every account share it, files and logins included. Displays are allocated per machine (per agent URL for `remote`), so on a shared agent no two accounts' Bots get the same display.

### 9.3 Control agent (inside the image)

| Endpoint | Purpose |
| --- | --- |
| `POST /exec` (NDJSON stream) | Command with cwd, env, timeout, stdin; streams stdout, stderr, exit code |
| `GET/PUT/DELETE /fs/*` | Files and listings (K7) |
| `POST /screens`, `DELETE /screens/:n` | Start or stop a Bot's display, window manager, and Chromium. A new profile loads the shared cookie store before its first navigation; a stopping screen exports its cookies first (section 9.6) |
| `GET /screens/:n/screenshot` | PNG |
| `POST /screens/:n/input` | click, double click, type, key, scroll, move, drag via xdotool |
| `POST /screens/:n/browser/*` | Playwright over CDP: navigate, accessibility snapshot with element refs, click, type, press, wait |
| `POST /cookies/sync` | Body `{screen?}`: export that screen's cookies, or every live screen's without one, merge them into the shared store, and load the changes into every other live profile (section 9.6). The server calls it for the screen on hand back, and for every screen on Done in a sign-in request; the agent runs the same sync on its own after browser and input calls, periodically, and on stop. It answers the screens synced and a cookie count; no endpoint returns cookie values |
| `WS /pty` | Terminal sessions (node-pty) |
| `WS /vnc/:n` | websockify to x11vnc on display `:n` for noVNC |
| `POST /wallpaper` | Sets the wallpaper for the hour on every display; the agent also runs this hourly (K5) |

The Bot has DOM mode (`browser_*`, cheap and reliable) and pixel mode (`computer`, for canvas apps). The `computer` action set mirrors Anthropic's computer-use tool so the Anthropic provider can use the native tool type when enabled.

### 9.4 Three-level access in the UI (K3)

| Level | UI | Implementation |
| --- | --- | --- |
| Status | A green dot on the title bar's Preview button while the Bot's current action is a computer tool | `bot.state.current_action` |
| Preview | Pinned right panel with a view-only noVNC canvas of the Bot's screen; the transcript stays in view | WS `/bots/:id/screen/vnc`, proxied by the server to the agent's `/vnc/:n` |
| Takeover | Full-screen screen view with "Take control" and "Hand back" | Sets `bot_screens.controlled_by_user_id`; while set, the Bot's computer-use calls on that screen return a tool result "The owner has the screen; wait" and the Bot state shows `waiting`. Hand back clears it, syncs the screen's cookies (section 9.6), and resumes. Takeover's screen socket is a control socket (`?control=1`): if the tab closes and it does not return within 30 seconds, the server hands the screen back the same way |

No other computer-view options exist (principle 10). The terminal and file browser live on the account-level Computer page, not in the chat.

### 9.5 Isolation and lifecycle

Own bridge network (`openbots-sbx`, or `OPENBOTS_SANDBOX_NETWORK` with its bridge `OPENBOTS_SANDBOX_BRIDGE`, so two stacks on one Docker host each keep theirs; the docker guard allows only that network and bridge, the sandbox firewall names its chains after the bridge, and a computer made on another network is made again on the configured one at its next start), no route to Postgres or Redis, optional egress proxy allowlist, `cap-drop ALL`, `no-new-privileges`, pids and memory limits, read-only root with writable home and tmp, no Docker socket, no provider keys. Starts on first use, stops after `idle_timeout_min` (default 30, 5 to 1440, set by the owner on the Computer page) unless `always_on` ("Never"), volume kept. It also wakes on its own, in the background, never waiting and never changing the idle settings (`wakeComputer`): the Mac app on This Mac calls `POST /computer/wake` once per launch after it signs the owner in (creating the computer on first use; a remote or cloud connection never does), and an owner's message to their Bots, direct or in a group, starts the owner's computer in the message's organization when it is stopped (or `error`), or marks a running one used so a conversation keeps it awake. A message never creates a computer, and one start runs per computer at a time. Bot, webhook and Routine messages do not wake it: their runs start it when a computer tool needs it, so automated traffic cannot keep it on. A failed wake is logged and shows as the usual `error` status. Use is: a computer tool call (and every minute while a command runs, since `bash` may run 30 minutes), file browser requests, frames on an open terminal or screen socket, and stdio MCP traffic; a computer with a screen under owner control is never stopped for idleness. A Takeover whose control socket closes for good is handed back after 30 seconds. Every live screen's cookies sync before the computer stops. Status changes publish `computer.status`; the web app also refetches the computer whenever its socket (re)connects, so a start it missed shows without a reload.

### 9.6 Shared logins: cookie sync (K1)

Each Bot keeps its own Chromium profile on its own screen, and logins are shared by syncing cookies. The control agent keeps one cookie store for the account's computer at `/var/lib/openbots/cookies.json`, on a root-owned agent volume outside `/home/bot` (section 17), with each profile's last export next to it.

| Step | Behavior |
| --- | --- |
| Export | The agent reads all of a profile's cookies over CDP (`Storage.getCookies`) and diffs them against that profile's last export. It exports after every browser and `computer` tool call on the screen, on hand back from takeover, every 30 seconds while the screen is live, and when the screen stops |
| Merge | Cookies are keyed by (name, domain, path). A new or changed cookie is stamped with its export time, and the newest write wins. A cookie that is gone from a profile since its last export is a deletion: a tombstone stamped with the export time, which beats older writes. Expired cookies and tombstones older than 30 days are dropped |
| Load | When a merge changes the store, the agent applies the changes to every other live profile (`Storage.setCookies`, and `Network.deleteCookies` for tombstones). A newly opened profile loads the whole store before its first navigation |

Limit: only cookies carry over. Sessions that a site keeps only in localStorage or IndexedDB do not, so for those sites the owner signs in on each Bot's screen that needs them. When two Bots change the same cookie between exports, the later export wins.

### 9.7 Sign-in requests and the main Bot (K8)

The owner can mark one Bot as the main Bot (`bots.is_main`, toggled in Bot Settings). A member's first Bot is their main Bot, and so is a Bot made while they have none, whether it is created or duplicated. A Bot that needs a login it does not have calls `request_login({site, reason})` instead of asking for credentials (section 5.3).

1. The runtime normalizes `site` to its registrable domain (for example `github.com`) and picks the target: the main Bot when one is set and it is not the caller, otherwise the caller itself. The registrable domain comes from a small rule, not the public suffix list: the last two labels of the host, or three under a country code's public second level (`bbc.co.uk`) or a shared hosting domain (`dana.github.io`). So `accounts.google.com` and `mail.google.com` are one request for `google.com`, since the sign-in is a cookie on that domain. The screen opens on the host the request names (a subdomain, or the site itself), or on the sign-in url when the Bot gave one.
2. When the target is the main Bot, the request is written as a message from the caller in the pair's `bot_to_bot` chat ("Needs sign-in: github.com", with the reason), visible to the owner (C6). The server writes it without calling `route()`, so the main Bot starts no run.
3. The server looks in the target's transcript (its `bot_dm` chat, whichever chat the caller's run is in) for a pending `login_request` widget for the same site. If one exists, the caller is added to it. Otherwise a new one is posted there, authored by the target Bot, without starting a model run. Its `widget_states.state` holds the site, the target screen, and one waiting entry per caller (`bot_id`, `run_id`, reason); `pending_run_id` stays null.
4. The caller's run persists its messages and goes `waiting` as in section 5.6. Its Bot state is `waiting` with current action `Waiting for sign-in: github.com`. The owner gets one notification per widget, not per caller (N1).
5. The widget shows the site, the waiting Bots and their reasons, and three actions: Take over (Takeover on the target's screen, starting it if needed, K3), Done, and Can't sign in. The owner signs in, hands back, and clicks Done.
6. Done syncs every live screen's cookies (section 9.6), so the login reaches the other screens whichever one the owner signed in on, marks the widget resolved, and enqueues a `resume` for every waiting run with the tool result "Signed in to github.com; retry." Each resumed Bot finds the login in its own profile.

Like approvals, an unresolved request expires after 24 hours, and the waiting runs resume with a tool result saying the sign-in did not happen.

---

## 10. Prompts: Skills and Routines (S1 to S3, R1 to R5)

### 10.1 Skills

- A Skill is a name and markdown content (S1). The Skills library page lists them with "used by" Bots; the editor has those two fields. Approvals fall back to the Bot's tool policy (T5, section 8).
- `/` in the composer inserts a `skill_ref` part; context assembly loads the full content for that turn as `<skill name="…">`, defused so it cannot close the frame, open a data frame or pass for the owner. `use_skill` lets a Bot load one it judged relevant from the index. A Routine's Skill reaches its run the same way.
- `save_skill`: the Bot drafts a name and content from the completed run's steps, stores the Skill and posts a "Skill draft" widget; the owner edits and saves it (S3). Demonstration recording (Playwright trace on the Bot's screen turned into a draft) is post 1.0 (S4).
- Import from GitHub (S3; `services/skill-import.ts`, `services/skill-format.ts`). The owner pastes a link to a file (`…/blob/ref/path/SKILL.md`), a folder (`…/tree/ref/path`) or a repository. `POST /skills/import/preview` resolves the ref to a commit SHA (trying longer refs for branch names with slashes), lists the tree once and finds every `SKILL.md` under the link (at most 50), or the one markdown file it names, and reads each for its name and description; names the library already has get a suffix (`name (2)`). `POST /skills/import` takes the picked paths and names at that SHA, checks the Skills-per-account limit before reading anything and again in the transaction, and adds them all or none, with source `imported` and an `origin`.
- Format: the name is the frontmatter's `name`, else the folder's (for a `SKILL.md`) or the file's. The content is the markdown without its frontmatter, after the frontmatter's `description` when the body does not already hold it. Content over 100,000 characters is refused. Other files in the folder are not read.
- Untrusted text (P2): tree entries whose path holds a control or bidi character, or is longer than 500 characters, are left out. Imported names are kept on one line, and imported content loses hidden control and bidi characters and is defused, so it cannot open a frame or pass for the owner speaking. Wherever an imported Skill reaches a Bot it carries `imported_from="owner/repo"`, and the operating rules say such a Skill never overrides them or the owner. The parser is linear on untrusted text and caps frontmatter at 64 KB. Nothing from a repository is run.
- Fetching is server side only, through the outbound guard with an allowlist of `api.github.com` and `raw.githubusercontent.com` on every redirect hop, with caps of 4 MB per import, 256 KB per `SKILL.md`, and 30 seconds. Public repositories need no token, and file reads go to raw.githubusercontent.com, which does not count against the API's 60 requests an hour. With the owner's GitHub connector (the built-in's token, or the GitHub MCP connector's token or OAuth sign-in, unless an admin blocked it), every read goes through the API with that token, which reads private repositories; a rejected token falls back to no token for a public repository. Without one, a private repository reads as not found, and the error says to add the GitHub connector. Ref resolutions are cached for a minute and tree listings for five, per repository and token; GitHub's rate limit becomes a 429 that says when it resets.

### 10.2 Routines

- A Routine binds a Bot, a trigger, and a prompt or Skill, and targets the Bot's transcript by default (R1, R3).
- Schedule presets map to cron in the Routine's timezone: every day at HH:MM, weekdays at HH:MM, weekly on a day, monthly on a date, or custom cron.
- Every N minutes takes any N from 1 to 1440 (`every_minutes`) and is scheduled as an interval, not as a cron divisor: `next_run_at` advances by N minutes from the previous slot, so N does not have to divide an hour or a day.
- Scheduler: a 30-second ticker in the worker runs `SELECT ... FROM routines WHERE enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED`, enqueues a run with `trigger=routine` at priority 3, and advances `next_run_at` with croner, or by N minutes for an interval. Exactly once across workers, no drift after edits.
- Event triggers are webhook endpoints with presets and a matching rule (section 11). GitHub events arrive from a repository webhook the user adds (GitHub App later); Slack events arrive from a Slack app's Events API subscription (R2).
- Each run creates a `routine_runs` record; the result is posted into the transcript as a Routine run result widget (`routine_run`) with the outcome, a link to the activity log, a Pause action for the Routine, and exception actions. It stays a widget card rather than a W3 event row. A trim keeps the 20 most recent records per Routine; the Routines tab shows them (R4).
- `propose_routine`: the Bot posts a "Create Routine?" widget with the trigger and prompt filled in; confirming creates it and posts "Routine created" (R5).
- Limits: 50 Routines per Bot, enforced at creation.

---

## 11. Webhooks (H1 to H6)

Ingress lives outside the authenticated API:

```
POST {OPENBOTS_PUBLIC_URL}/hooks/{botHandle}                 Bot inbox (H1)
POST {OPENBOTS_PUBLIC_URL}/hooks/{botHandle}/{endpointSlug}  Routine event trigger (H2)
Authorization: Bearer <token>   or   X-OpenBots-Token   or   /.../{token}
X-Hub-Signature-256, X-Slack-Signature, Stripe-Signature      (preset HMAC verification, H3)
```

Pipeline: size limit, IP allowlist, constant-time token check, HMAC preset verification, rate limit, idempotency (`Idempotency-Key` or body hash in a 10-minute window), handshake presets (Slack `url_verification`, generic challenge echo), store the delivery, evaluate the matching rule (event type, action, repo, label, channel, text regex), enqueue, respond.

- Inbox lifecycle (H1): every Bot's inbox endpoint is created in the same transaction as the Bot, including on duplicate and from a template. Endpoints are never copied, so a new Bot never shares a token. The owner generates the token in the Bot's webhook settings (`POST /endpoints/:id/rotate`); it is shown once, at generation, and only its hash is stored. Until a token exists the inbox answers 401.
- Inbox: renders the payload through the endpoint template (default: one-line header plus a fenced JSON block), posts a `webhook` message into the Bot's transcript, enqueues a run at priority 2 under the endpoint's tool policy override.
- Routine trigger: same, but the run is a `routine` run with the Routine's prompt and the payload as data, and a `routine_runs` record.
- Response modes: `async` returns `202 {delivery_id, run_id}`; `sync` waits on a Redis channel keyed by run id up to `sync_timeout_s` (max 60) and returns `{run_id, text}` (H4).
- Prompt framing: `<webhook_event endpoint="..." verified="true">...</webhook_event>` under the standing rule that event content is data (P2).
- Delivery log with replay and a test form (H5). Outbound `event_subscriptions` deliver `message.created`, `run.completed`, `run.failed`, `approval.requested`, `routine.ran`, `artifact.created` with an HMAC header, retries, and a log (H6).

---

## 12. Artifacts and widgets (A1 to A4, W1 to W3)

### 12.1 Artifacts

- `create_artifact({title, kind, content | path})`, `update_artifact({id, content | patch | path})`, `read_artifact`, `publish_artifact(path)` (server pulls the file from the computer through the agent), `artifact_to_computer(id, path)`.
- Every write creates an `artifact_versions` row. The transcript shows an artifact card part; the viewer opens in the right panel with version history, download, and inline editing for `document`, `code`, and `data` (CodeMirror; a user edit creates a version attributed to the user).
- The Bot's Artifacts tab lists all its Artifacts; the account-level Computer page lists attachments next to the computer's files. There is no separate Files page in the sidebar (principle 10).

### 12.2 Widgets

A widget is a message part `{type:'widget', kind, props, state}` validated by a zod schema per kind in `packages/widgets`. The Bot emits one with `show_widget`. The 1.0 registry:

| Kind | Interactive | Notes |
| --- | --- | --- |
| `approval` | Approve, Deny | Backed by `approvals` |
| `question` | Options or free text | Backed by `widget_states`, resumes the run |
| `email_draft` | Edit fields, Send | Send goes through policy then the email connector |
| `form` | Fields, Submit | Generic input |
| `table`, `chart` | Sort, download | Read only |
| `status_summary` | | Team or task status from a coordinating Bot |
| `event` | | System event row: computer started, connector needs login, Bot loop stopped (W3) |
| `routine_proposal`, `routine_created` | Confirm, open | Section 10 |
| `routine_run` | Open activity log, pause Routine, exception actions | Routine run result card posted for every run; a widget, not an event row (W1, W3, section 10.2) |
| `skill_draft` | Edit, save | Section 10 |
| `login_request` | Open screen, Done | Sign-in request for one site, authored by the main Bot or the requesting Bot; backed by `widget_states`, merges requests for the same site, resumes every waiting run (K8, section 9.7) |
| `artifact`, `file` | Open, download | Section 12.1 |

Widget actions post to `POST /messages/:id/widgets/:part/action`. If a run is waiting on that widget, the action resumes it; otherwise it starts a `widget_action` run. Renderers are React components keyed by kind; the registry is the extension point for W4 later.

---

## 13. Avatars (I1, I2)

`packages/avatars` is a deterministic generator: seed to base shape (circle, rounded square, blob variants; a new Bot gets one of Moon (`bean`), Box (`rounded`) or Egg (`blob`), pinned, and the pickers offer those three), palette from a curated set, eye style (several expressive designs), and an accessory (glasses, headphones, antenna, hat, scarf, none). Output is an SVG React component with a `state` prop that maps to CSS keyframes: idle (slow breathing, blinks, eye drift), thinking (eyes up, slight tilt), working (bob, focused eyes), waiting (eyes to the viewer, small bounce), blocked (still, eyes down, muted color), done (single settle). Reduced-motion preference disables motion and keeps a subtle color cue. The server renders static PNGs with resvg for notifications. The profile editor offers "shuffle" and per-part pickers plus image upload.

---

## 14. API, realtime, and clients

### 14.1 REST (`/api/v1`)

| Group | Endpoints |
| --- | --- |
| Auth | better-auth under `/api/auth/*`, `GET /me`, API keys CRUD (U4) |
| Bots | `GET/POST /bots`, `GET/PATCH/DELETE /bots/:id` (`PATCH` also sets `is_main`, K8), `POST /bots/:id/duplicate`, `POST /bots/:id/pin|hide`, `GET/PUT /bots/:id/connectors`, `GET/PUT /bots/:id/skills`, `GET/POST/DELETE /bots/:id/memories`, `GET /bots/:id/artifacts`, `GET /bots/:id/state` |
| Chats | `GET /chats` (groups and Bot to Bot), `POST /chats` (group, 2 to 6 Bots), `GET /bots/:id/chat` (the transcript), `POST/DELETE /chats/:id/members`, `GET /chats/:id/messages?before=seq&thread=`, `POST /chats/:id/messages`, `POST /messages/:id/reactions`, `POST /messages/:id/widgets/:part/action`, `GET /chats/:id/resync?since=seq` |
| Runs | `GET /runs/:id`, `GET /runs/:id/steps` (activity log), `POST /runs/:id/cancel`, `GET /runs/:id/events` (SSE), `POST /approvals/:id/decide` |
| Tools | `GET /connectors/catalog`, `GET/POST /connectors`, `PATCH/DELETE /connectors/:id`, `POST /connectors/:id/test`, `GET /connectors/:id/tools`, `GET /connectors/:id/oauth/start`, `GET /connectors/oauth/callback`, `POST /connectors/discover`, `POST /connectors/import`, admin `GET/PUT /connector-policy` |
| Skills | `GET/POST /skills`, `GET/PATCH/DELETE /skills/:id`, `POST /skills/import/preview` and `POST /skills/import` (from GitHub, S3) |
| Routines | `GET/POST /bots/:id/routines`, `GET/PATCH/DELETE /routines/:id`, `POST /routines/:id/run-now`, `GET /routines/:id/runs` |
| Webhooks | `GET/POST /bots/:id/endpoints`, `PATCH/DELETE /endpoints/:id`, `POST /endpoints/:id/rotate` (generate or rotate the token, returned once), `GET /endpoints/:id/deliveries`, `POST /endpoints/:id/deliveries/:did/replay`, `POST /endpoints/:id/test`, `GET/POST /event-subscriptions` |
| Computer | `GET /computer`, `PATCH /computer` (always on, idle timeout), `POST /computer/start|stop|restart`, `POST /computer/wake` (background start, 202), `GET /computer/files?path=`, `GET/PUT /computer/files/*`, `POST /bots/:id/screen/control` (take or hand back), WS `/computer/pty`, WS `/bots/:id/screen/vnc` (`?control=1` from Takeover) |
| Artifacts | `GET /artifacts/:id`, `GET /artifacts/:id/versions`, `PUT /artifacts/:id` (user edit), `GET /artifacts/:id/download` |
| Files | `POST /files`, `GET /files` (attachments for the Computer page), `GET /files/:id` |
| Models | `GET/POST /providers`, `PATCH/DELETE /providers/:id`, `POST /providers/:id/test`, `POST /providers/:id/discover`, `GET/PUT /providers/:id/models`, `GET /models` |
| Settings | `GET/PATCH /settings` (the active organization's limits, under its ceiling on the managed service, and custom stdio; audit retention on the managed service only), `GET /capabilities` (`deployment`: `self_hosted` or `managed`; `customStdio`, `localEndpoints`), managed only (ee/server, section 21.5): `/organizations`, `/organization/*`, `/invitations/{id}` |

`OPENBOTS_DEPLOYMENT` decides the account model. `self_hosted` (the default) is single-owner, one implicit organization: the setup wizard creates the one account (its `owner`, so every role check passes), every later signup is refused with `SIGNUP_CLOSED`, there are no organization routes, and audit retention keeps its default. Audit rows are still recorded. The web app shows no organization, invites, member lists, roles or "admin" wording; the owner's limits are in Settings > Limits. `managed` is the hosted OpenBots service, built from `ee/`: organizations, roles, invitations, email verification and each organization's audit log (section 21).

Routes are declared with zod schemas; the OpenAPI document and the TypeScript client in `packages/api-client` are generated.

### 14.2 WebSocket (`/ws`)

| Event | Payload |
| --- | --- |
| `message.created`, `message.delta`, `message.completed` | message, coalesced part deltas, usage |
| `message.deleted` | message id, chat id, thread root: a streaming Bot message removed before it showed anything |
| `bot.state` | bot_id, state, current_action, run_id |
| `run.status`, `run.step` | run id, status; new activity log entry |
| `approval.requested`, `approval.resolved`, `widget.updated` | rows |
| `routine.ran` | routine id, run record |
| `artifact.created`, `artifact.updated` | ids and titles |
| `computer.status`, `screen.control` | status, who controls a screen |
| `reaction.added` | message id, emoji, reactor |

Every message carries `seq`; `resync` replays after reconnect. A message also carries `updated_seq`, a fresh seq from the chat's counter each time it changes for a reader (it completes, its mentions change, or a widget state or reaction on it changes), kept by database triggers so no writer can skip it. `resync?since=` returns the messages whose `updated_seq` is past the client's last seq, so a message the client already holds comes back when it finished, was answered or got a reaction while the socket was down. A streaming Bot message that never showed anything is deleted instead of closed empty when its worker loses the run to another (K4), when the run is cancelled first, or when a failing run closes an earlier worker's leftovers (`discardIfEmpty`). The delete is conditional on the row still being empty, so a late delta keeps it. It publishes `message.deleted` and records the deletion in `message_deletions` with a fresh seq from the chat's counter; `resync` lists the deletions past the client's seq under `deleted`, so a client that missed the event drops the message. The gap a deleted message leaves in `seq` needs nothing else: paging asks for seqs below a bound, and resync for `updated_seq` past one. Workers publish on Redis; API instances forward to subscribed sockets.

### 14.3 Web app (PRD section 5)

- Sidebar: New (`Cmd/Ctrl+N`), pinned Bots, Bots, Groups, then Connectors, Skills, Computer, Settings. Roster rows are avatar plus name plus label; the avatar animates with `bot.state` (B1, I2).
- Bot view: title bar (name, label, Preview toggle with its computer dot), tabs (Chat, Routines, Artifacts, Memory, Settings), transcript with prose, widgets, event rows, artifact cards, threads, reactions, and a composer with `/`, `@`, and attachments (C1, C2).
- Group view: the transcript and composer as in a Bot view, with the members' avatars in the title bar. They open a members menu that removes a Bot while two stay; a Bot joins when the owner mentions it with `@` (C4).
- Right panel (one at a time): computer preview, activity log, artifact viewer, thread.
- Bot Settings: profile, model, tools and permissions, enabled Skills, a Main Bot toggle for sign-in requests (K8), and webhook settings where the owner generates the inbox token (H1). Turning the Main Bot toggle on for one Bot turns it off on the owner's other Bots in the same transaction.
- Computer takeover: full screen with "Take control" and "Hand back" only.
- Connectors (`/connectors`, with `/tools` redirecting there), Skills, Computer, Settings pages as described in the PRD. Each connector shows its icon, vendored into the web app, never fetched at run time. The Computer page holds the terminal, the computer's files, and the account's attachments (section 12.1).
- Settings > Models: built-in provider cards with key status, Add custom model provider (preset, name, base URL, protocol, key, headers, models with Discover), per-model capability and pricing editor, Test; the Bot model picker groups by provider and filters by capability (L1 to L5).

### 14.4 Mac app (D2)

Electron around the same React build, with `contextIsolation` on, the renderer sandboxed, no Node integration, and a small preload bridge for native features. Server profiles (the local stack, the hosted OpenBots server, any tunnel or remote URL), session token encrypted with Electron's `safeStorage` (backed by the macOS Keychain), notifications through the Electron `Notification` API for approvals, questions, sign-in requests (`login_request`), mentions, and Routine exceptions with deep links `openbots://bot/{id}/message/{seq}` registered with `setAsDefaultProtocolClient`, a `Tray` menu with pending approvals and quick Approve, a `globalShortcut` for a quick-ask window, `electron-updater` with signed manifests on GitHub Releases, and local stack management (detect Docker Desktop or OrbStack, start and stop the bundled compose stack, tail logs from a child process). Universal binary via electron-builder, released with the images from the same `v*` tag (`.github/workflows/release.yml`, `apps/desktop/RELEASING.md`): Developer ID signed and notarized in CI when the Apple secrets are set, otherwise an unsigned build that the release notes label as such. Every release carries the DMG, the zip and a Homebrew cask; a signed one also carries the `latest-mac.yml` electron-updater reads, since Squirrel.Mac cannot install an unsigned update. When the registry refuses the local stack's images, a packaged app loads that release's image archives instead (`src/images/release-archive.ts`), checked against its `SHA256SUMS`, and shows the download in the setup progress. Windows and Linux are electron-builder targets later (D4).

First launch shows a welcome screen in the app's own start page (not the web app) with three ways to connect, saved in `profiles.json`:

1. **Sign in to an OpenBots account**: a `cloud` profile for the hosted OpenBots server, opened at its `/sign-in` (which links to `/sign-up`). Its URL comes from `OPENBOTS_CLOUD_URL` at build time, written into the packaged `package.json`; without it the choice shows disabled with "OpenBots accounts are not available yet". Running that hosted server is out of scope here. Navigation and OAuth work as for any remote server.
2. **Connect to a self-hosted server**: the address is https by default, http only for this Mac or a private network and then with a warning. The app checks `GET /healthz` and `GET /api/v1/setup`, saves a `remote` profile and opens `/setup` while the server has no user, otherwise `/sign-in`.
3. **Run OpenBots on this Mac**: detects Docker Desktop or OrbStack (with install links and "Check again" when neither is there), starts the bundled stack with progress (pulling, starting, waiting for `/readyz`) and opens the web app signed in (below), whose setup wizard starts at the providers. The stack runs as its own Compose project, `openbots-app` (recorded in its `.env`), so it never takes over the containers, networks or volumes of a `docker compose up` in a source checkout (project `openbots`); an older install whose `openbots` containers run from the app's stack directory keeps that name. Its first `.env` gets the first free port from 3000 up, with `OPENBOTS_PUBLIC_URL` to match, and the local profile follows it. When another app later takes that port, a start stops and names it, offering a free one; a running stack is never moved. It also gets a sandbox network of its own, `openbots-app-sandbox-<n>` on the first free `/24` from `172.30.254.0/24` down (read with `docker network ls` and `inspect`), so it runs beside a checkout's stack on `openbots-sbx`; an older `.env` without one keeps `openbots-sbx` while its containers are on it. A start that fails because another stack holds the network says so and offers "Use a separate network", which stops the app's stack, writes a fresh name and subnet and starts again. The pull is skipped when every image is already on the Mac, and a pull the registry refuses (images not published or not public) gets a plain message with the output behind "Show details".

This Mac has no sign-in. Every create or start of the stack writes `OPENBOTS_LOCAL_TOKEN` (32 random bytes, base64url) into its `.env` when it is missing, so an install from before gets one at its next start, and Compose's `env_file` passes it to the server (as a secret file, like the master key). The same start sets `OPENBOTS_HTTP_BIND=127.0.0.1:`, so Compose publishes the web port on loopback only and no other machine on the network reaches it (unset, as in a source checkout or CI, it is every interface as before). Only the main process reads it (`stack.localToken()`, `src/main/local-session.ts`): it never reaches the preload bridge, the renderer, a URL or a log. Before the window loads the server, the main process checks the saved session with `GET /api/v1/me` and, when there is none or the server refuses it, calls `POST /api/v1/local/session` with the token in the `x-openbots-local-token` header. The server compares it in constant time, refuses any request with an Origin or Sec-Fetch-Site header (every browser sends one), sends no CORS headers for the route, rate-limits it like sign-in, and answers 404 without a token configured (an older server, or a stack not restarted yet: the window then shows the usual sign-in). It creates the owner when there is no user, through better-auth's user hooks as setup does (admin internally), with the placeholder email `owner@openbots.local`, no password and the macOS full name (`id -F`, else "Me"); an owner from before, with a real email, is used as is. It then creates an ordinary better-auth session through a server-only endpoint (`createLocalSession` in `auth.ts`), audited as `auth.local_session`, and the main process puts the cookie into the profile's session like any saved token. When the window later lands on `/sign-in` or `/sign-up` (an expired session), or the main connection gets a 401, the main process signs in again the same way, at most once per 10 seconds, and reloads. With the token set nothing else makes a user or a session: `POST /api/v1/setup/admin` and better-auth's email and OAuth sign-up, sign-in and callbacks answer 403 `LOCAL_ONLY`, so nobody who reaches the port can create the owner first with a password they know. An owner from before keeps their account and is signed in by the app; their password no longer works. The server rejects `OPENBOTS_LOCAL_TOKEN` with `OPENBOTS_DEPLOYMENT=managed`, and `GET /api/v1/capabilities` reports `auth: 'local'`, so the web app shows no sign-out, no Account tab (General has the owner's name and API keys), no account step in the wizard, and "Open OpenBots from the Mac app" on `/sign-in` and `/sign-up`. `GET /api/v1/setup` stays true for that owner until the first Bot exists. Remote and cloud profiles sign in as before.

Options 1 and 2 are thin clients: all work runs on the server, the app never touches Docker, and Bots keep working when the Mac is off or asleep (K4). Option 3 runs everything on the Mac, so work pauses while it sleeps. Later launches open the chosen connection; when it does not answer, the start page says why, with the stack's controls for This Mac and a way to change the connection. "Change connection…" in the app and tray menus returns to the three choices and keeps saved servers. An install that already has an active profile, or a local stack and no `profiles.json`, skips the choice. The tray's header names the connection's kind and host.

Inside the Mac app the web app shows one small icon at the foot of the sidebar: the kind of connection (OpenBots account, Self-hosted with its host, or This Mac), with a tooltip and a colour only for a problem (reconnecting from the WebSocket client's state, or This Mac's stack stopped or unhealthy). Its menu has the details, "Change connection…" and, for This Mac only, Start, Stop and Show logs. The preload bridge's `connection` answers only the active server's own page in the main window; a browser has no bridge and shows no icon.

---

## 15. Repository layout

```
openbots/
  apps/
    server/            Hono API, WS gateway, workers, scheduler (roles: api | worker | all)
    web/               React SPA
    desktop/           Electron shell (main process, preload), loads apps/web
    computer-agent/    Control agent inside the sandbox image
  packages/
    shared/            zod schemas, event protocol, pricing, limits, constants
    api-client/        generated TypeScript client + WS client
    agent/             run loop, context assembly, tool registry, policy, steering, activity labels
    router/            who-replies logic, loop guards, Bot to Bot
    models/            provider registry, presets catalog, adapters, discover and test
    mcp/               MCP client manager, catalog, OAuth, McpHost implementations
    computer/          ComputerProvider, docker provider, agent client, screen locks
    routines/          scheduler, presets, event matching
    widgets/           widget schemas and React renderers
    artifacts/         storage, versions, viewer components
    avatars/           generator, motion states, server-side PNG rendering
    ui/                shared components
  docker/
    server.Dockerfile
    computer.Dockerfile
    docker-compose.yml
    docker-compose.dev.yml
    docker-compose.tunnels.yml
  docs/                PRD.md, TECHNICAL_PLAN.md, CONTRIBUTING.md (self-hosting is in README.md)
  scripts/
  .github/workflows/
```

---

## 16. Self-hosting (D1, D3)

### 16.1 Compose stack

| Service | Image | Role |
| --- | --- | --- |
| `openbots` | `${OPENBOTS_IMAGE_PREFIX}/server` | API, web UI, workers, scheduler. Port 3000 |
| `postgres` | `pgvector/pgvector:pg16` | Database, volume `pgdata` |
| `redis` | `redis:7-alpine` | Queue and pub/sub |
| `docker-socket-proxy` | `tecnativa/docker-socket-proxy` | Restricted Docker API for sandbox management |
| `sandbox-firewall` | `${OPENBOTS_IMAGE_PREFIX}/sandbox-firewall` | Keeps the sandbox network's firewall rules applied on the Docker host |
| `minio` (profile `s3`) | `minio/minio` | Optional object storage |
| `ngrok` (profile `ngrok`) | `ngrok/ngrok` | Optional tunnel |
| `cloudflared` (profile `cloudflare`) | `cloudflare/cloudflared` | Optional tunnel |

Computer containers are created at runtime from `${OPENBOTS_IMAGE_PREFIX}/computer` on the `openbots-sbx` network. The release workflow (`.github/workflows/release.yml`) publishes the server, computer and sandbox firewall images to `ghcr.io/<repository owner>/openbots`, which is the prefix's default in `.env.example`; a fork or a mirror points `OPENBOTS_IMAGE_PREFIX` at its own namespace, and `OPENBOTS_VERSION` picks the release (`docker/docker-compose.yml`).

### 16.2 Environment

```
OPENBOTS_PUBLIC_URL=http://localhost:3000     # webhook URLs, OAuth callbacks, notification links
OPENBOTS_MASTER_KEY=<32 bytes base64>        # `docker compose run openbots keygen`
DATABASE_URL=postgres://openbots:openbots@postgres:5432/openbots
REDIS_URL=redis://redis:6379
DOCKER_HOST=tcp://docker-guard:2375
OPENBOTS_IMAGE_PREFIX=ghcr.io/danielpang/openbots  # where compose pulls server and computer from
OPENBOTS_SANDBOX_IMAGE=                       # empty: ${OPENBOTS_IMAGE_PREFIX}/computer:${OPENBOTS_VERSION}
OPENBOTS_DEPLOYMENT=self_hosted              # self_hosted (one owner, sign-up closed) | managed
OPENBOTS_LOCAL_TOKEN=                        # set by the Mac app: its owner signs in with it, no password (14.4)
OPENBOTS_SIGNUP_MODE=first_user_admin        # managed only: open | invite (first_user_admin, its old name)
OPENBOTS_LOCAL_ENDPOINTS=                     # admins may mark endpoints local (S-8): default true self-hosted, false managed
OPENBOTS_CUSTOM_STDIO=                        # admins may turn on custom stdio (S-1): default true self-hosted, false managed
OPENBOTS_STDIO_RUNNER=                        # host | computer: default host self-hosted, computer managed
OPENBOTS_ALLOW_HOST_STDIO=                    # managed only: 1 to accept host stdio (warned at start)
RESEND_API_KEY=                              # managed: invite and verification email; without it, invite links to copy
OPENBOTS_EMAIL_FROM=                          # managed: the sender, e.g. "OpenBots <hi@example.com>"
OPENBOTS_DEV_LOG_EMAIL_LINKS=                 # managed, development only: log verification codes (refused in production)
OPENBOTS_DB_APP_PASSWORD=                     # openbots_app's password: the app works as it, under row-level security (21.9)
OPENBOTS_LIMITS_BOTS_PER_ACCOUNT=50
OPENBOTS_LIMITS_BOTS_PER_GROUP=6
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
XAI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
OLLAMA_BASE_URL=                             # optional; custom model providers are added in Settings > Models
OPENBOTS_FILES_DIR=/data/files                # or S3_* variables
```

### 16.3 First run, upgrades, backups

`git clone`, `cp .env.example .env`, `docker compose up -d`, open `http://localhost:3000`. The wizard creates the owner's account (the Mac app's local stack skips this step, 14.4), asks for a provider key, pulls the sandbox image in the background, and creates a first Bot. Migrations run on start. `/healthz`, `/readyz`, `/metrics`. Upgrade with `docker compose pull && docker compose up -d`. Computers follow: the worker pulls the sandbox image again at start (a tag like `latest` moves), and a stopped computer whose image name, image build or sandbox settings differ is made again at its next start (`updating`), keeping its volumes. A running computer is never replaced mid-task; it moves at its next start after an idle or manual stop. `scripts/backup.sh` runs `pg_dump` and archives the files directory and computer volumes.

### 16.4 README section: exposing your OpenBots server to the internet

Written to be lifted into the README. Webhooks, connector OAuth callbacks, and the Mac app away from home all need a public URL.

> #### Exposing your OpenBots server to the internet
>
> By default OpenBots listens on `http://localhost:3000`. To receive webhooks, complete OAuth flows for connectors, or use the Mac app away from home, put a tunnel in front of it. Whichever tunnel you use, set `OPENBOTS_PUBLIC_URL` in `.env` to the public URL and restart with `docker compose up -d`. OpenBots uses it to build webhook URLs and OAuth redirect URIs.
>
> **Before exposing anything:** use a strong password and consider the tunnel provider's own access controls described below. A self-hosted install has one account and closes sign-up once it exists; with `OPENBOTS_DEPLOYMENT=managed`, keep `OPENBOTS_SIGNUP_MODE` at `first_user_admin` or `invite`.
>
> ##### Option A: ngrok
>
> 1. Install ngrok (`brew install ngrok` on macOS) and add your token: `ngrok config add-authtoken <token>`.
> 2. Start a tunnel: `ngrok http 3000`. The free plan includes one static domain, which you should use so the URL survives restarts: `ngrok http --url=your-name.ngrok.app 3000`.
> 3. Set `OPENBOTS_PUBLIC_URL=https://your-name.ngrok.app` in `.env` and run `docker compose up -d`.
> 4. To run ngrok as part of the stack instead of on your machine, set `NGROK_AUTHTOKEN` and `NGROK_URL` in `.env` and start with the profile: `docker compose --profile ngrok up -d`.
> 5. Optional hardening: protect the UI with ngrok's OAuth or basic auth (`--oauth=google`, `--basic-auth=user:pass`). Webhook endpoints live under `/hooks/`, so if you add ngrok auth, use ngrok Traffic Policy to exempt that path, or run a second tunnel for it.
>
> ##### Option B: Cloudflare Tunnel
>
> Quick tunnel (no account, random URL that changes each run):
>
> 1. Install cloudflared (`brew install cloudflared`).
> 2. Run `cloudflared tunnel --url http://localhost:3000` and copy the `https://<random>.trycloudflare.com` URL it prints.
> 3. Set `OPENBOTS_PUBLIC_URL` to that URL and run `docker compose up -d`.
>
> Named tunnel (stable hostname on your own domain, recommended):
>
> 1. `cloudflared tunnel login`, then `cloudflared tunnel create openbots`.
> 2. `cloudflared tunnel route dns openbots openbots.example.com`.
> 3. Create `~/.cloudflared/config.yml` with an ingress rule that sends `openbots.example.com` to `http://localhost:3000` and a final `http_status:404` catch-all, then run `cloudflared tunnel run openbots`.
> 4. Or run it inside the stack: create the tunnel in the Cloudflare Zero Trust dashboard, set its public hostname to service `http://openbots:3000`, put the token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`, and start with `docker compose --profile cloudflare up -d`.
> 5. Set `OPENBOTS_PUBLIC_URL=https://openbots.example.com` and restart.
> 6. Optional hardening: add a Cloudflare Access policy for the hostname so only you can reach the UI. Add a bypass rule for the path `/hooks/*` so external services can still deliver webhooks, or publish webhooks on a second hostname without Access.
>
> Both providers pass WebSockets, which the live screen and terminal views need. If the screen view fails through a tunnel, check that no intermediate proxy is stripping the `Upgrade` header.

---

## 17. Security model (P1 to P3)

Trust boundaries, most to least trusted: server core (master key, provider keys, database); MCP servers (vendor code, own secrets only); computer sandbox (arbitrary code, no OpenBots secrets, no internal network, resource capped, but it holds the owner's browser logins); webhook payloads, fetched pages, and other Bots' messages (data, never instructions); model output (every side effect passes the policy gate).

Controls: encrypted secrets, approvals, per-Bot domain allowlists, sandbox network separation, Docker socket proxy, rate limits on auth and webhooks, constant-time token checks, same-site cookies plus origin checks on WebSocket upgrade, audit log, secure cookies when the public URL is https, pinned versions in the MCP catalog, screen control lock so a Bot cannot act while the owner has taken over, a root-only cookie store. The 1.0 gate includes a threat-model review against this list.

Shared cookie store (K1, section 9.6): the store and the per-profile exports live on a root-owned agent volume at `/var/lib/openbots` (mode 0700), outside `/home/bot`. The control agent runs as root. `bash`, `/exec`, and terminal sessions run as the unprivileged `bot` user, so the store is never readable from Bot shells, and no agent or API endpoint returns cookie values.

---

## 18. Implementation plan

Two to three engineers. Phases are sequential except that the Mac app can start once the web app is stable. PRD IDs list what each phase closes.

| Phase | Weeks | Scope | Closes | Exit criteria |
| --- | --- | --- | --- | --- |
| 0. Foundation | 1 to 2 | Monorepo, CI, Dockerfiles, compose, Hono skeleton, better-auth, full Drizzle schema, WS gateway with resync, web shell with login | U1, D1 (partial) | Fresh clone to running stack; sign up and log in |
| 1. Bots and the transcript | 3 to 5 | Bot CRUD and roster (pin, hide, duplicate), avatar generator with motion states, one transcript per Bot, provider registry with custom model providers, discover and test, capability-filtered model picker, agent runtime with streaming, steering, Bot state and activity labels, activity log panel, memory v0, prose and basic widgets (`question`, `event`, `file`) | B1 to B5, B7, B8, I1 to I4, C1 to C3, M1 to M3, L1 to L5 | Create a Bot, chat, watch the avatar change state, hover for the current action, open the activity log |
| 2. Tools and approvals | 6 to 7 | MCP manager (stdio, http), OAuth 2.1, catalog, JSON import, admin block list, per-Bot permissions, policy engine, approval pause and resume, `approval` and `email_draft` widgets, built-ins (web, HTTP, email, GitHub) | T1 to T5, P1 to P3, W1 (partial), W2 | Bot uses GitHub MCP, a destructive tool asks for approval, approve and deny work across a worker restart |
| 3. Artifacts | 8 | Artifact tools, versions, cards, viewer with editing, Bot Artifacts tab | A1, A2, A4, W1 (artifact card) | Bot writes a document, user edits it, both versions visible |
| 4. The computer | 9 to 12 | Sandbox image, control agent, docker provider with socket proxy, per-Bot screens, computer and browser tools, screen lock, three-level UI (status icon, preview panel, takeover with hand back), wallpaper by hour, Computer page with terminal, files, and attachments, publish and push Artifacts, cookie sync across profiles, `request_login` and the `login_request` widget in the caller's own transcript | K1 to K7, I5, A3 | Bot logs into a site, runs commands, edits files; owner previews, takes over to log in, hands back, Bot continues; a second Bot opens the same site already signed in |
| 5. Groups and Bot to Bot | 13 to 14 | Group chats (2 to 6), `@` and `@everyone`, `shouldReply` router, Bot to Bot chats, loop guards, threads, reactions, `status_summary` widget, chat summaries, the main Bot toggle and sign-in requests routed to it | C4 to C9, W1 (status), K8 | A Chief of Staff Bot routes work to three specialists with visible handoffs; loop guard stops a ping-pong; two Bots needing the same site produce one sign-in request on the main Bot, and both resume after Done |
| 6. Skills and Routines | 15 to 17 | Skills library, `/` references, `use_skill`, `save_skill` with draft widget, Routines tab, schedule presets, scheduler, webhook ingress with presets and matching rules, GitHub and Slack event triggers, Bot inbox endpoint, sync and async modes, run records with trim, `routine_*` widgets, outbound subscriptions | S1 to S3, R1 to R5, H1 to H6, W1 (routine widgets), W3 | Weekday 8:00 Routine posts a briefing; a GitHub PR event triggers a review; a script hits the inbox and gets a sync reply |
| 7. Mac app | 18 to 20 | Electron shell, server profiles, Keychain-backed token storage, notifications with deep links, menu bar approvals, quick-ask, updater, local stack management, signed and notarized DMG | N1, N2, D2 | Install from Releases, approve from the menu bar, auto-update |
| 8. Polish, 1.0 | 21 to 22 | Setup wizard, README with tunnels, backups and upgrades, metrics, soak test, threat-model review, UI removal pass against principle 10 | U3, U4, D1, D3 | Clean install on a Mac and a Linux VPS, both reachable through ngrok and Cloudflare; every PRD "Must" closed |
| 9. After 1.0 | ongoing | Demonstration-recorded Skills, multi-human groups, widget registry for extensions, MCP runner isolation, web push and PWA, SQLite lite mode, Firecracker or E2B providers, enterprise controls, Windows and Linux desktop | S4, C10, W4, T6, P4, N3, D4 | |

### 18.1 Phase 0 detail

- pnpm workspace, Turborepo pipeline, shared tsconfig and eslint.
- Server: Hono app, zod-validated config, pino, health routes, better-auth with the Drizzle adapter, role flag.
- Full schema from section 4 in the first migration so later phases add columns, not tables.
- WebSocket gateway: auth on upgrade, subscribe and resync, Redis subscriber.
- Web: Vite, router, auth pages, sidebar shell, generated API client.
- Docker: multi-stage server image, compose with healthchecks, `.env.example`, `scripts/dev.sh`.
- CI: lint, typecheck, unit tests, image build per PR.

### 18.2 Phase 1 detail

- `packages/models`: providers and provider_models, env seeding, presets catalog, openai-compatible and anthropic-compatible adapters, discover and test endpoints, capability gating; small-model selection for classifier, labels fallback, and memory extraction.
- Settings > Models page and the Bot model picker.
- `packages/agent`: context assembly, `executeRun`, gated tools, steering inbox, activity labels, trace, cancellation, retries.
- `packages/avatars`: generator, six motion states, reduced motion, PNG rendering; profile editor with shuffle and pickers.
- Bot state service and `bot.state` events; roster and title bar wiring.
- Transcript: virtualized timeline, markdown, widget parts, event rows, attachments, activity log panel.
- Memory v0: `remember`, post-run extraction, Memory tab with edit and delete.
- Tests: recorded-provider double for the loop, snapshot tests for context assembly, e2e for send and stream, visual tests for avatar states.

### 18.3 Phase 2 detail

- `packages/mcp`: `McpHost`, stdio and http hosts, session cache, health loop, tool refresh, OAuth 2.1 flow and callback.
- Policy engine with annotations, overrides, trigger-aware rules; pause and resume with a worker-restart integration test.
- Connectors page: catalog, custom form, import, OAuth buttons, tool list, admin block list; Bot Settings tools tab with a policy for every tool group and every tool (conversation, Artifact, built-in, connector and computer), each showing the policy engine's default from `GET /bots/{id}/tools`, and a switch that turns computer use off (`groups.computer = deny`).
- Built-ins: web search and fetch, `http_request` with allowlists, SMTP and IMAP email connector, GitHub built-in.

### 18.4 Phase 3 detail

- `packages/artifacts`: storage, versioning, diff summaries, viewer (markdown, code, CSV and JSON tables, images, PDF, download), user edits as versions.
- Tools and cards; Bot Artifacts tab; `artifact.*` events.

### 18.5 Phase 4 detail

- `docker/computer.Dockerfile` and `apps/computer-agent`; multi-arch image; wallpaper set and hourly switch.
- `packages/computer`: provider interface, docker provider, agent client, screen allocation, screen locks, takeover semantics.
- Tools with screenshot results as image parts; Anthropic native computer-use mapping.
- UI: title-bar icon, preview panel (noVNC view-only), takeover full screen with take and hand back, Computer page with xterm.js and file browser, pull progress.
- Isolation: socket proxy, network separation, limits, optional egress proxy; a test that the sandbox cannot reach Postgres or the Docker API.
- Shared logins: the agent's cookie store on its own root-owned volume, export triggers, merge with tombstones, load into live and new profiles; `request_login` and the `login_request` widget targeting the caller; a test that a Bot shell cannot read the store.

### 18.6 Phase 5 detail

- Group creation (2 to 6), membership, mention parsing with `@everyone`; a message with mentions goes only to the mentioned Bots, and `shouldReply` runs only for messages without mentions.
- `packages/router`: `shouldReply`, chain limits, Bot to Bot chats and `message_bot`; system event rows for stopped loops.
- Main Bot (K8): `is_main` with its partial unique index, the Bot Settings toggle, sign-in requests written to the pair's Bot to Bot chat, and merging per site on the main Bot's `login_request` widget.
- Threads (`thread_root_id`, thread panel, context scoping) and reactions.
- Rolling chat summaries; other Bots' tool activity collapsed in context.

### 18.7 Phase 6 detail

- Skills: name and content, library page and editor, `/` composer integration, `use_skill`, `save_skill` and `skill_draft` widget, per-Bot enablement.
- Routines: presets to cron, every N minutes (1 to 1440) as an interval, timezone handling, scheduler ticker with `SKIP LOCKED`, run records and trim, Routines tab, `propose_routine` and `routine_*` widgets, run-now.
- Webhooks: ingress outside auth, presets (GitHub, Slack, Stripe, generic), handshake presets, matching rules, templates, idempotency, sync and async, delivery log with replay and test, an inbox endpoint created with every Bot (also on duplicate and from a template) with its token shown once, outbound subscriptions with signing and retries.

### 18.8 Phase 7 detail

- `apps/desktop`: Electron with electron-vite, a main process and a contextBridge preload, `platform` context in the web app, Notification, Tray, globalShortcut, protocol registration for deep links, safeStorage for the token, electron-updater; tray menu with approvals.
- Local stack manager: bundled compose, Docker detection, start and stop, logs.
- Release workflow: electron-builder universal binary, signing, notarization with @electron/notarize, DMG, updater manifest, Homebrew cask.

### 18.9 Phase 8 detail

- Setup wizard, README, backup and restore scripts, install script, metrics and dashboards.
- Soak test: twenty concurrent runs across ten Bots with two accounts' computers for an hour.
- Threat-model review, dependency audit, license headers, and a UI removal pass: every control must answer "did this help someone delegate?"

---

## 19. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Docker socket exposure grants host root | Socket proxy with a restricted operation set in the default compose; `remote` provider for users who refuse socket access |
| Bot loops in groups and Bot to Bot chats | Depth cap, rolling budget, mention-only Bot to Bot triggering, visible event rows |
| Prompt injection through webhooks, pages, and other Bots | Data tagging, approvals on side effects, per-endpoint stricter policies, domain allowlists |
| The avatar system becomes a design sink | Ship generated SVG with six states; treat illustration quality as iterative |
| Widget sprawl makes the transcript noisy | Fixed 1.0 registry, prose by default, review against principle 10 |
| Provider differences in tool naming and schemas | Normalization layer with per-provider contract tests |
| Streaming drift on reconnect | Sequence numbers on every message and delta, resync endpoint, idempotent part application |
| Scheduler duplicates or misses runs | Postgres row locks with `SKIP LOCKED`, idempotent enqueue keyed by routine and slot |
| Sandbox image size and pull time | Multi-arch prebuilt image, lazy pull with progress, slim variant without Chromium |
| MCP stdio supply chain | Pinned versions in the catalog, unprivileged execution, each server in its owner's computer on the managed service |
| macOS signing and notarization friction | CI-owned certificates, documented manual path, unsigned dev builds |
| Electron bundle size and memory | Accepted for an app that streams screens and terminals; universal DMG, lazy-load heavy views, keep the renderer sandboxed |
| Custom model providers with wrong capability flags or partial protocol support | Test on save, catalog defaults, capability-filtered picker, runtime check at run start with a blocked event and a fix |
| Name collision: "OpenBot" (no s) is an Intel robotics project | The product is named OpenBots to stay apart from it. Check GitHub org, npm scope, and domain before publishing; keep the name configurable |

---

## 20. Decisions to confirm

Decided on 2026-10-29 by the product owner while reviewing the MVP:

- Group mentions (C5): a message that mentions Bots, or uses `@everyone`, goes only to those Bots, and `shouldReply` runs only for messages without mentions. A mentioned Bot can bring others in by @mentioning them (section 7).
- Shared logins (K1): each Bot keeps its own Chromium profile, and cookies sync through one root-only store in the computer, newest write winning per (name, domain, path), deletions included. Sessions kept only in localStorage or IndexedDB do not carry over (section 9.6).
- Main Bot for sign-ins (K8): the owner can mark one Bot as the main Bot. `request_login` sends sign-in requests to it, one `login_request` widget per site asks the owner once, and every waiting Bot resumes after Done (section 9.7).
- Skill shape (S1): a name and free-form markdown content, with no required parts and no ready step; approvals fall back to the Bot's tool policy (section 10.1).
- Default model: a new Bot gets its provider's catalog default, `claude-opus-5-5` with adaptive thinking for Anthropic (section 3).
- Routine results (W3): they stay the `routine_run` widget card, not an event row (section 12.2).
- Every N minutes (R1): any N from 1 to 1440, scheduled as an interval (section 10.2).
- Bot inbox (H1): created with every Bot, including duplicates; the token is shown once when the owner generates it (section 11).
- Attachments are listed on the account-level Computer page next to the computer's files; there is no Files page (section 12.1).

Still to confirm:

1. Mac app as Electron around the shared UI (decided) versus Tauri v2 or a native SwiftUI client.
2. One transcript per Bot with an archive-and-start-fresh action (recommended) versus multiple transcripts per Bot.
3. Group chats are the owner plus their Bots at 1.0 (Grok Bot parity); multi-human groups come later. Confirm this matches the original "group chats with bots" intent.
4. License: decided. The core is under the Business Source License 1.1 with an Additional Use Grant: production use inside your own organization, with no hosted offering to third parties and no paid setup or consulting for them. It changes to Apache-2.0 four years after each release. The managed service's code lives in `ee/` under a proprietary license, and the core never imports it.
5. Built-in connectors at 1.0: web search, web fetch, HTTP request, email, GitHub; everything else through the MCP catalog.
6. Redis as a required service at 1.0 (recommended) with a Postgres-only lite mode later.
7. Per-account provider keys (L6) shipped with organizations on the managed service (section 21.4); an admin model allowlist (L7) ships after 1.0 (recommended).

---

## 21. Organizations on the managed service

The hosted service is one server shared by many organizations. People sign up, create an organization or join one through an invite, and can belong to several. Bots stay per user (U2), and a user's data is scoped per user and per organization: someone in two organizations has separate Bots, chats, Skills, connectors, memories, Routines, Artifacts, files and computers in each, and leaving an organization ends their access to what they had there. Self-hosted is one implicit organization and keeps working exactly as before, the Mac app's local mode included.

### 21.1 Data model

The tables already carried `workspace_id`, so the organization is the `workspaces` row and the column keeps its name: in the schema, "workspace" means organization. better-auth's organization plugin is mapped onto the existing tables (`modelName` and `fields` in `ee/server/src/plugin.ts`) instead of adding its own, which keeps the 57 files that read `workspace_id` as they are and lets the core scope by one column whichever build runs. Migrating to the plugin's own tables would have meant renaming `workspace_id` in ten schema files and every query for no gain in isolation.

| better-auth model | Table (`modelName`, with `usePlural`) | Changes (migrations `0021_organizations`, `0022_organizations_cleanup`) |
| --- | --- | --- |
| `organization` | `workspaces` (`workspace`) | adds `slug` (unique, backfilled from the name and id), `logo`, `metadata`; `settings` stays (limits, audit retention, custom stdio, small models) |
| `member` | `workspace_members` (`workspaceMember`, `organizationId` mapped to `workspaceId`) | `role` becomes text checked to `owner`, `admin`, `member` (the `workspace_role` enum goes); `disabled_at` becomes `suspended_at`, the `suspendedAt` additional field; the earliest admin of each workspace becomes its `owner` |
| `invitation` | `invites` (`invite`, `organizationId` mapped to `workspaceId`) | adds `status` and `inviter_id`; `used_at` becomes status `accepted`; `token_hash`, `created_by`, `used_at`, `used_by` go; invites without an email are dropped, since every invitation is for one address |
| `session.activeOrganizationId` | `sessions.active_organization_id` | nullable, set null when the organization goes; backfilled with each member's workspace |
| (ours) | `apikeys.workspace_id` | the organization a key was made in; backfilled from the user's membership |

The migration is split in two so drizzle-kit never has to guess a rename: 0021 adds the new columns and copies the data across, 0022 drops the old ones. A self-hosted install's one workspace becomes its implicit organization and its owner the `owner`, so it and the Mac app's local mode keep working.

Unique keys that were per user become per (organization, user): Bot handles (`bots (workspace_id, owner_id, handle)`, so one member's handles never collide with, or reveal, another's), the main Bot, Skill and connector slugs, and the computer (`computers (workspace_id, owner_id)`). Provider slugs were already per (organization, owner).

### 21.2 The active organization and the request context

`authenticateAccount` and `authenticateHeaders` (middleware/auth.ts) resolve the caller and their organization on every request and WebSocket upgrade:

- Self-hosted: always the implicit organization (the one `workspaces` row), whatever the session says. Only its owner gets in.
- Managed, session: the session's `activeOrganizationId`. Managed, API key: the key's `workspace_id`; a key without one is refused.
- The user must be a member of that organization and not suspended in it. A stale active organization (the user was removed, or it was deleted) resolves to none.
- With `requireVerifiedEmail` (the managed build), an account whose email is not verified gets 403 `EMAIL_NOT_VERIFIED` on every request, its API keys included.

`CurrentUser` carries `workspaceId` (the active organization) and `role` (`owner`, `admin` or `member` there). `requireUser` needs an active, unsuspended membership and answers 403 `NO_ORGANIZATION` or `MEMBER_SUSPENDED`; `requireAdmin` also needs `owner` or `admin`; `requireAccount` needs only a signed-in user, for the routes that work without one (`GET /me`, which then reports `workspace: null` or `suspended`, and ee's organization list, create, switch and invitation routes). Every service and query takes the organization from the caller, or from the row it works on (a Bot, a chat, an endpoint) in workers, and Postgres row-level security holds every query to the scope's organization underneath (21.9). `ensureWorkspace` remains only as the self-hosted implicit organization (setup, local mode, start-up).

### 21.3 Scoping rules

- Per-user data is read with both `owner_id` and `workspace_id`, and per-Bot data through a Bot the caller owns in the active organization (`ownership.ts`). Anything else answers 404 with no echo. `routes/org-isolation.test.ts` walks every route in the OpenAPI document as another organization's owner and as the same user working in another organization.
- Workers, BullMQ jobs, Routines and the scheduler work from row ids and read the organization from the Bot or chat; connectors, providers, Skills, files and memories they load are filtered by that organization and owner. A run checks that its Bot's provider belongs to the Bot's organization or owner before it starts.
- Inbound webhooks resolve the organization from the endpoint: on the managed service the URL names the Bot by id (`/hooks/{botId}/...`), since handles are only unique per (organization, user); a self-hosted URL still uses the handle. Rate limits and payload limits come from the endpoint's organization once it is found. Outbound event subscriptions match the event's organization and owner.
- Realtime: user-scoped events (`computer.status`, `connector.updated`) carry `workspace_id`, and a socket gets them only for the organization it authenticated in; chat and Bot subscriptions are ownership-checked as before. Removing or suspending a member closes their sockets in that organization only (`MEMBERSHIP_ENDED_CHANNEL`).
- The computer is per (user, organization): its row, and so its container and volume, which are named by the row's id. Filesystem connector folders are `connectors/<organization>_<user>` on the managed service. New files and Artifact blobs are stored under `orgs/<organization>/`; files from before keep their keys.
- Settings and limits are per organization (`workspaces.settings`); the audit log is per organization and recorded in self-hosted too.

### 21.4 Model providers at two levels (L6)

A provider row with `owner_id` null belongs to the organization (added by an owner or admin) and every member's Bots may use it; a row with `owner_id` set is that member's own, which only they see and change. Lists put the member's own first, so a new Bot gets its default model from them when they have one. Settings > Models shows "Organization" and "Yours" on the managed service and one list on a self-hosted install. Keys stay sealed, and only whoever may change a provider sees its key hint. On the managed service, keys in `.env` are not seeded into any organization (each organization brings its own); self-hosted seeds them into the implicit organization as before.

### 21.5 Code split and composition

The core (`apps/`, `packages/`, BUSL-1.1) owns the schema, the migrations, organization scoping, the active organization resolution and extension points. It never imports `ee/` (`scripts/check-licenses.mjs`). `ee/` (proprietary, ee/LICENSE) holds the managed-only parts as private workspace packages, each with a copy of the license:

- `ee/server` (`@openbots/ee-server`): the better-auth organization plugin with its schema mapping and access control (owner, admin, member; `access.ts`), a policy plugin (sign-up mode, invite proof, email verification, the session's active organization, and no `/api/auth/organization/*` over HTTP), invite and verification email through Resend, the routes below with their own OpenAPI document (`ee/server/openapi.json`), and the managed server entry `ee/server/src/main.ts`.
- `ee/web` (`@openbots/ee-web`): the managed web entry, which starts the core app with its extensions: `/onboarding` (create your organization, join through an invite, or pick another when suspended), the organization switcher, and Settings > Organization, Members and Audit log.

The core server starts through `runServer(extensions)` (`apps/server/src/server.ts`); `apps/server/src/main.ts` passes none, and `ee/server/src/main.ts` passes the managed ones (`ServerExtensions`): `organizations`, `authPlugins` (better-auth plugins, which bring their own database hooks and options), `routes`, `requireVerifiedEmail`, `limitsCeiling` (for plans, later), `redactPath` and `webDist`. The core refuses `OPENBOTS_DEPLOYMENT=managed` without the organizations extension. The core web app takes its extensions through `startWeb(extensions)`: `SidebarHeader`, `settingsTabs` (served at `/settings/$section`) and `Onboarding` (at `/onboarding`, where someone with no active organization lands, and where an invite goes after sign-in or sign-up). The core alone has no organization UI.

The managed routes, under `/api/v1`: `GET/POST /organizations` and `POST /organizations/{id}/activate`; `GET/PATCH /organization`, `POST /organization/leave`, `GET /organization/members`, `PATCH/DELETE /organization/members/{id}`, `GET/POST /organization/invitations`, `DELETE /organization/invitations/{id}`, `GET /organization/audit`; `GET /invitations/{id}` and `POST /invitations/{id}/accept`. Creating, switching and accepting need a session; the rest also take an API key.

### 21.6 Roles and rules

- Owners and admins invite, remove and suspend members, change roles, manage organization providers, settings and limits, and read the organization's audit log. Only an owner makes, demotes, suspends or removes an owner, or invites one. The last owner who is not suspended cannot leave, be removed, be suspended or be demoted. Nobody suspends or removes themselves through the admin routes.
- Admins cannot see or act on members' Bots or other per-user data: U2 holds inside an organization. Their trust and local marks on connectors reach only their own connectors on the managed service.
- Suspension (`suspended_at`) applies to one organization: requests and API keys in it are refused, its sockets close, and the member's other organizations are untouched. While suspended or after removal, their Bots there do no work: runs are blocked, Routines wait and their webhook endpoints answer 404 (`ownerActive` in `membership.ts`).
- The managed service keeps an organization's audit log for at least 30 days (400 `RETENTION_TOO_SHORT`), so an admin cannot wipe the record of what they did.
- Limits: on the managed service the operator's limits (`OPENBOTS_LIMITS_*`) are every organization's ceiling, or a plan's through `limitsCeiling`. Owners and admins may lower limits, never raise them above it (400 `ABOVE_PLAN_LIMIT`), and a higher number stored in a row counts as the ceiling. A self-hosted owner has no ceiling.
- Custom stdio connectors and endpoints marked local (providers, connectors, event subscriptions) are off on the managed service unless the operator turns them on (`OPENBOTS_CUSTOM_STDIO`, `OPENBOTS_LOCAL_ENDPOINTS`): every organization shares the server and its network.
- Stdio connectors, catalog and custom, run in their owner's computer for the organization (`OPENBOTS_STDIO_RUNNER=computer`, section 8), never on the shared server.
- Sign-up: email first, credentials after, so whoever holds the inbox sets the password (`ee/server/src/sign-up.ts`). Step 1 (`POST /api/auth/sign-up/start`, the email and any invite) makes no user and no password: only a pending request, bound to a random id in an HttpOnly cookie, and a 6-digit code emailed through Resend. Step 2 (`/sign-up/verify`) takes that request's code once; step 3 (`/sign-up/complete`) takes the name and password and creates the account, confirmed, and signs in. A code lasts 10 minutes, is stored as an HMAC bound to its request and compared in constant time. Limits: per IP first (20 sign-ups and 50 code tries an hour); then, only for a request that passed the policy checks and before anything is made or sent, 10 sends an hour and 20 a day per address (429); 5 tries per code, after which that code is dead; and 15 failed tries per address in a rolling hour across its codes, after which the address cannot verify until the hour clears (a correct code never counts). Guessing one address is bounded by its sends: at most 100 guesses a day (SECURITY.md has the odds and the worst lockout). When the address already has an account, the email says someone tried to sign up with it instead of carrying a code, and the requester sees the same answer. Nothing an unauthenticated request does deletes or replaces an account; an unconfirmed account from before this flow is deleted only after its code, in the same transaction that creates the confirmed one, with everything tied to it (sign-in methods including a linked GitHub or Google identity, sessions, memberships, invitations it sent, API keys); if it owns anything else the sign-up is refused and nothing changes. better-auth's own `/sign-up/email` and verification links are not served. Codes never reach a log, except on a development server without email that sets `OPENBOTS_DEV_LOG_EMAIL_LINKS` (refused with `NODE_ENV=production`). `OPENBOTS_SIGNUP_MODE=open` lets anyone sign up; `invite` (and `first_user_admin`, its old name) lets only the first user and someone who brings the invitation from their link, for the address they sign up with, checked at steps 1 and 3; the account joins at onboarding.
- GitHub or Google sign-up from an invite link: before going to the provider, the web app calls `POST /api/v1/invitations/{id}/oauth`, which sets a signed (HMAC from the master key), HttpOnly, SameSite=Lax cookie for 10 minutes. The invite never rides in the OAuth state. When the callback creates the account, the invitation must be pending and for the address the provider says it verified; the account then joins it once (a conditional update) and the cookie is cleared. Without that proof, invite mode refuses the account.
- Onboarding: after verification, a sign-up without an invite creates an organization (its name) and becomes its owner; one with an invite joins that organization. A signed-in user can create more organizations (up to 10 memberships, 5 an hour) and switch between them.
- Invitations are for one email address, expire after 7 days, are accepted once by that verified address (a conditional update), can be revoked, and are capped per organization (100 pending, 30 sent an hour). Their id is the link's secret: request logs redact it, and logs never hold an emailed link or token.

### 21.7 Build, images and CI

- The self-hosted image (`docker/server.Dockerfile`) builds the core and holds no `ee/` code. The managed image (`ee/server/Dockerfile`) builds `@openbots/ee-server` and `@openbots/ee-web` and starts `ee/server/dist/main.js` through the same entrypoint (`OPENBOTS_MAIN`), with `OPENBOTS_DEPLOYMENT=managed`.
- CI checks both OpenAPI documents are current, lints and builds both images, and runs the e2e specs on the managed server (`ee/server`, serving `ee/web`) except the self-hosted job, which runs the core server. `e2e/organizations.spec.ts` covers onboarding, invites, switching, isolation and suspension; specs confirm email with the code the server logs in CI.

### 21.8 Decisions

- Mapping onto the existing tables rather than the plugin's own (21.1).
- Only creating an organization, switching and accepting an invitation go through the plugin's endpoints; member and invitation changes are done in `ee/server/src/organizations.ts` on the same tables, so the last-owner rule can hold under a lock and API keys work for them.
- Sign-up on the managed service is instance-wide (`OPENBOTS_SIGNUP_MODE`), not an organization setting.
- Every invitation names one address; a link without an address is no longer offered.
- An organization's audit log shows what its members did, Bot actions included, as a security record; it gives no access to the Bots.
- Organization deletion is not offered yet (`disableOrganizationDeletion`).

### 21.9 Row-level security

Two layers keep organizations apart. The first is the services': every query names the organization and owner (21.3). The second is Postgres row-level security, under every query, so one that forgets its filter still reads and writes only its own organization (`apps/server/drizzle/0023_row_level_security.sql`, `apps/server/src/db/scope.ts`).

- Roles. Migrations run as `DATABASE_URL`'s user, the tables' owner. The app works as `openbots_app`, which owns nothing and does not bypass RLS. With `OPENBOTS_DB_APP_PASSWORD` (install.sh and the Mac app generate it like the other secrets; the migration step sets it on the role) the app logs in as `openbots_app`; without it the app connects as the owner and switches to `openbots_app` in every transaction (`SET LOCAL ROLE`), and the server warns at start. Every table with `workspace_id`, and `workspaces` by its `id`, has RLS enabled and forced (the owner is held to it too, unless a superuser), one policy for reads and writes comparing the row with `nullif(current_setting('app.workspace_id', true), '')::uuid`, and an index led by `workspace_id`. With the setting missing, those tables return no rows and take no writes.
- Scope. The app's database runs each query, and each transaction, as a transaction that first sets `role` and `app.workspace_id` with `set_config(..., true)`, so both end with it and a pooled connection carries nothing on. The organization comes from the scope of the work in hand (`inWorkspace`, an AsyncLocalStorage): `requireUser` and `requireAdmin` set it to the request's organization (`requireAccount` to the active membership, when there is one); a job carries the organization that queued it and runs in it (`infra/index.ts`); a realtime event carries `workspace_id`, and the gateway, the outbound fan-out and the computer sockets work in the socket's or event's organization; webhook ingress resolves the endpoint's organization first, then works there. A self-hosted install runs the same code with its implicit organization.
- System paths, each narrow, none a blanket bypass: the organization directory (`asDirectory`: better-auth's adapter, which organizations an account is in, an invitation by id, an API key's organization) works as `openbots_auth`, which reaches the account tables, `workspaces`, `workspace_members`, `invites` and `apikeys` of every organization and no other table; work for every organization (start-up upkeep, run recovery, approval and sign-in expiry, the idle sweep, audit retention, master key rotation) runs in each organization's scope in turn, from `openbots_workspace_ids()`; the Routine scheduler ticks only the organizations `openbots_due_routine_workspaces()` names; webhook ingress and a connector's OAuth callback find their organization through `openbots_webhook_workspaces()` and `openbots_connector_workspace()`. Those functions are SECURITY DEFINER, owned by `openbots_system`, which may only read the columns they need and owns or creates nothing else. Migrations run as the owner.
- Tests. `db/rls.test.ts` runs raw SQL as the app role (another organization's rows are not seen, changed or deleted, and cannot be inserted; with no organization set nothing is seen or written), fails if any table with `workspace_id` lacks forced RLS, its policy or an index, checks that a query with no organization filter still sees only its own organization, that the directory role reaches no tenant table, and that jobs run in their organization. Every other server test runs under the same policies on PGlite; `routes/org-isolation.test.ts` still walks every route. Tests set up rows through the owner's handle (`t.db`), which has none.
