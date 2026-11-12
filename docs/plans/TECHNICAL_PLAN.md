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
| `bot_skill_blocks` | bot_id, skill_id | Bots a Skill is turned off for; every Skill is on for all of its owner's Bots otherwise (S2) |
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
| Built-in | `web_fetch`, `web_search`, `news_search`, `http_request` (domain allowlist), `send_email` (SMTP connector), `attach_file` | Configured |
| Connector | `${connectorSlug}__${toolName}` for each permitted MCP tool | Connector attached |
| Computer | `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_screenshot`, `computer` (screenshot, click, double_click, type, key, scroll, move, drag), `request_login` (site and reason; section 9.7) | Always (every account has a computer); computer-use actions take the per-Bot screen lock (K2) |
| Coder | `code_task` (agent, repository, prompt, branch, base, mode `plan`, `edit` or `pr`, session id to continue; section 22) | A computer and the server's coder services; off for a Bot whose `coder` group is Never or whose `coder.enabled` is false. Each action inside a session is judged by its action class, not by this group's decision |

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

When a tool needs approval, or the Bot calls `ask_user`, or a widget awaits input, the worker: posts the widget into the transcript, writes an `approvals` or `widget_states` row with `pending_run_id`, persists the model messages into `runs.state`, sets the run to `waiting` and the Bot state to `waiting`, and exits the job. The owner's decision (approve, deny, answer, button click) enqueues a `resume` job that rehydrates the messages, executes the tool or injects the answer as a tool result, and continues. Thread replies on the approval message are attached to the resume as extra context (C7). Approvals expire after 24 hours by default. `request_login` waits the same way on a `login_request` widget, which can hold several waiting runs (section 9.7). `code_task` waits the same way on a `coding_session` widget, whose session runs in the `coders` queue and resumes the run when it ends (section 22).

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
| `news_search` | `Searched news 'rate decision'` |
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
- An owner message in a group that names no Bot (or uses `@everyone`) drops the Bot-triggered runs in its thread (or at the top level) that are queued and have never started: a handoff from an earlier chain does not run after the owner has moved on. A message naming Bots leaves chains alone, and a named Bot with a queued run is steered by it. A Bot already running is steered as before, a run queued again after an approval or answer is kept, and dropped runs do not count toward the Bot-run budget. A compact event row says how many handoffs were dropped.
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
- One-click Connect: for a catalog entry with `dynamic_registration` (Cloudflare, Vercel, Supabase, Neon, Railway), Connect creates the connector and calls `GET /connectors/:id/oauth/start?mode=` at once; required settings and keys are asked for first. A pasted URL goes through `POST /connectors/discover` first, an unauthenticated `initialize` plus RFC 9728 and RFC 8414: `none` is just added, `oauth` with a registration endpoint signs in at once, `oauth` without one asks for the owner's own client under Advanced (with the callback URL to register), `bearer` asks for a token, and an unreachable URL (a private address, S-8) is added as is. GitHub uses a public GitHub App, configured by its client ID and slug (`OPENBOTS_GITHUB_CLIENT_ID`, `OPENBOTS_GITHUB_APP_SLUG`, bundled defaults or per-connector Advanced fields). Connect opens the app installation page for repository selection, followed by device authorization; GitHub App permissions replace broad OAuth scopes. Start returns the user code and expiry; authenticated `POST /connectors/:id/oauth/device` polls fixed GitHub endpoints with the device code sealed on the server, enforcing intervals and `slow_down`. Compare-and-swap reserves polls across processes and prevents an old poll from overwriting changed secrets. Success requires a non-suspended installation of the configured app visible to the user, saves a GitHub App user token encrypted and emits `connector.updated`. Access and refresh token expiry are stored; device-issued tokens refresh without a client secret under a database row lock, serializing single-use refresh tokens across API and worker processes. Expired or revoked refresh tokens require reconnecting. No private key, callback or hosted auth broker is needed. GitHub rejects redirect client-secret configurations; other connectors retain their existing OAuth behavior. Slack, Gmail and Google Docs offer neither dynamic registration nor client metadata documents, so they still need the owner's OAuth app, entered under Advanced. See [GITHUB_CONNECTOR.md](../GITHUB_CONNECTOR.md).
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
| `WS /pty` | Terminal sessions (node-pty). Query `cols` and `rows`, and for a coding session's terminal `cwd` (under the home), `user` (`bot`, the default, or `coder`, with the agents' config directories and `umask 002`) and `preset` (typed without a newline, such as `claude --resume <id>`). The server's proxy passes the last three only for the owner's own worktrees and checkouts (section 22.10) |
| `WS /coder` | A coding agent, its vendor login or the owner's command in a session's worktree, as the coder user (or the bot user with the coders group), or one of the server's own git operations as the `runner` user (uid 1801, `coder-runner` in the image, section 22.12), in its own process group; output, permission prompts and git credential requests relayed over the socket (section 22.3). git's credential helper reaches the agent over the session's own unix socket, so there is no `/git/credential` endpoint |
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
4. License: decided. The core is under Apache-2.0, allowing use, modification, self-hosting, hosting for third parties, and paid setup or support. The mobile app in `apps/mobile/` is proprietary and source-visible under `apps/mobile/LICENSE`, with no right to copy, modify, build, distribute or publish without written permission. The OpenBots name and logo are trademarks of Daniel Pang and may not be used for forks or hosted services without permission. The managed service's code lives in `ee/` under a proprietary license, and nothing in `apps/` or `packages/` imports it, the mobile app included.
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

The core (`apps/` except `apps/mobile/`, and `packages/`, Apache-2.0) owns the schema, the migrations, organization scoping, the active organization resolution and extension points. Nothing in `apps/` or `packages/`, the mobile app included, imports `ee/` (`scripts/check-licenses.mjs`). `ee/` (proprietary, ee/LICENSE) holds the managed-only parts as private workspace packages, each with a copy of the license:

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
- Sign-up: email first, credentials after, so whoever holds the inbox sets the password (`ee/server/src/sign-up.ts`). Step 1 (`POST /api/auth/sign-up/start`, the email and any invite) makes no user and no password: only a pending request, bound to a random id in an HttpOnly cookie, and a 6-digit code emailed through Resend. Step 2 (`/sign-up/verify`) takes that request's code once; step 3 (`/sign-up/complete`) takes the name and password and creates the account, confirmed, and signs in. A code lasts 10 minutes, is stored as an HMAC bound to its request and compared in constant time. Limits: per IP first (20 sign-ups and 50 code tries an hour); then, only for a request that passed the policy checks and before anything is made or sent, 10 sends an hour and 20 a day per address (429); 5 tries per code, after which that code is dead; and 15 failed tries per address in a rolling hour across its codes, after which the address cannot verify until the hour clears (a correct code never counts). Guessing one address is bounded by its sends: at most 100 guesses a day. When the address already has an account, the email says someone tried to sign up with it instead of carrying a code, and the requester sees the same answer. Nothing an unauthenticated request does deletes or replaces an account; an unconfirmed account from before this flow is deleted only after its code, in the same transaction that creates the confirmed one, with everything tied to it (sign-in methods including a linked GitHub or Google identity, sessions, memberships, invitations it sent, API keys); if it owns anything else the sign-up is refused and nothing changes. better-auth's own `/sign-up/email` and verification links are not served. Codes never reach a log, except on a development server without email that sets `OPENBOTS_DEV_LOG_EMAIL_LINKS` (refused with `NODE_ENV=production`). `OPENBOTS_SIGNUP_MODE=open` lets anyone sign up; `invite` (and `first_user_admin`, its old name) lets only the first user and someone who brings the invitation from their link, for the address they sign up with, checked at steps 1 and 3; the account joins at onboarding.
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

## 22. Coding agents (CA1 to CA14, GH1 to GH8)

A Bot hands real coding work to a coding agent on its own computer: Claude Code, Codex or pi. The design is "Coding Agents in OpenBots" (draft 3, 2026-11-05); this section describes what Phases 1, 2 and 3 built. Phase 2, the GitHub connections, is 22.12; Phase 3, Codex, pi and the polish around them, is 22.13; Reset computer, which rescues first, is 22.14. Sections 22.1 to 22.11 describe the runner with Claude Code as the example, and 22.13 says where Codex and pi differ. The vendor facts the Codex and pi adapters rest on (flags, event streams, sign-ins, each one checked against the pinned CLI) are in [CODING_AGENT_VENDORS.md](CODING_AGENT_VENDORS.md). Three existing patterns carry most of it: a tool that parks its run on a widget (`WaitFor` in `packages/agent/src/gated.ts`, as `request_login` does, section 5.6), a process run over an agent socket (`WS /mcp/stdio`, section 8), and a Redis control channel for long jobs (as `services/mcp-control.ts` and `RUN_CONTROL_CHANNEL` do). The shared vocabulary (agents, modes, session states, the `CoderEvent` normal form, control messages, action classes and limits) is `packages/shared/src/coders.ts`; the runtime facts the server's launches and the control agent must agree on (the users and their ids, the paths, the environment variable names) are `packages/shared/src/coder-runtime.ts`.

Why a separate user and a separate runner rather than more `bash`: the vendor's sign-in is the owner's own credential, the same class as the browser cookie store (section 9.6), so it must live where the Bot's shell cannot read it. And enforcement must not depend on the agent's own permission settings: the process user, the worktree and the credential helper limit what any agent can do.

**Where the code is.** On the server, under `apps/server/src/services/`:

| Module | What it does |
| --- | --- |
| `coding-sessions.ts` | `startCodingSession` (what `code_task` calls), the session views and the owner's Stop, Continue, Discard and Open terminal (`discardWorktree`, `terminalFor`, `isCoderTerminalCwd`) |
| `coder-tool.ts` | What a run sees of coding: `coderServices` for `code_task` and `coderContextFor` for context assembly |
| `coder-widget-actions.ts` | The `coding_session` widget's actions (`onCodingSessionAction`) and resuming a run once its coding widget is done |
| `coder-accounts.ts` | Settings > Coding agents: the account view (`planProvider`, `checkAvailable`, `signIn`, `lastErrorKind`), an API key, Sign out and Check (`checkCoderSignIn`) |
| `coder-login.ts`, `coder-login-driver.ts` | Sign-ins: the `coder_logins` row and its widget, and the `login` job that drives the vendor's login in a PTY (`runCoderLogin`, `loginLink`) |
| `coder-commands.ts` | One-off commands as `coder`: the CLI's version (`coderVersion`), a sign-in check, a sign-out, removing a worktree |
| `coder-runner.ts` | The `coders` queue's handler and one session's life (`runSession`) |
| `coder-provider-env.ts` | An `api_key` account's key on its way to the CLI (`coderProviderEnv`), its mask (`maskKey`) and billing (`accountBilling`) |
| `session-git.ts` | The runner's git after the CLI ends: the Bot's identity, the branch's commits and files, the safety-net commit (`commitLeftovers`), the diff Artifact and the pull request |
| `coder-recovery.ts`, `coder-run-resume.ts` | Sessions an interrupted process left (`recoverInterruptedCoderSessions`, `RESTART_NOTE`); resuming the run that waits on a coding widget |
| `coder-state.ts`, `coder-control.ts`, `coder-jobs.ts` | The widget's feed and settle; the control channel; the `coders` queue's jobs |
| `coder-adapters/` | One adapter per agent (`claude.ts`, `codex.ts`, `pi.ts`), and what they share: `shell-words.ts` (a command line split as POSIX sh splits it), `classify.ts` (action classes for every adapter) and `common.ts` (output reading, the preamble, the git identity, a rate limit's reset) |
| `repos.ts`, `repos-checkout.ts` | The remembered repositories; a checkout on the computer and every runner git command |
| `repos-scan.ts`, `repos-refresh.ts`, `repos-rescue.ts` | The scan for found clones; the periodic fetch and the reconcile after a start; rescue |
| `computer-reset.ts` | Reset computer, rescue first (22.14) |

### 22.1 On the computer

The image's `coders` stage installs `docker/coders/package.json` from its lockfile (`@anthropic-ai/claude-code` 2.1.318, `@openai/codex` 0.166.0, `@earendil-works/pi-coding-agent` 1.5.0) with install scripts off, runs only Claude Code's `install.cjs` by hand (it puts the native binary in place of the stub), and fails the build unless each CLI answers `--version`. The result is copied root-owned to `/opt/openbots/coders`, with shims `claude`, `codex` and `pi` in `/usr/local/bin`. The system git config sets `credential.helper` to `/usr/local/bin/openbots-git-credential`, `credential.useHttpPath true` and `init.defaultBranch main`.

| Who or what | Owner and mode | Why |
| --- | --- | --- |
| `coder` user and `coders` group | uid 1800, gid 1800 (`apps/computer-agent/src/users.ts`, `native/runas.c`) | Runs every coding agent and every vendor login. `runas` allows only 1800:1800 for it |
| `runner` user (`coder-runner` in the image) | uid 1801, gid 1800 | Runs the server's own git operations: clone, fetch, worktree, scan, reconcile, the approved push and rescue pushes. Not coder, so no coding session can read its environment; the coders group, so it writes the repositories. `runas` allows only 1801:1800 for it (22.12) |
| The owner's commands in a session | uid 1000 with gid 1800 (`BOT_CODERS`) | Still the bot user, with the coders group that owns the repositories' files. `runas` gives a program exactly one group, so this is the primary gid |
| `/var/lib/openbots/coders` | root, 0711 | On the root-only state volume, beside the cookie store |
| `.../coders/claude`, `.../codex`, `.../pi` | coder, 0700 | `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`: the sign-ins. The bot user cannot enter them |
| `.../coders/home` | coder, 0700 | The coder user's `HOME`, since Claude Code writes `~/.claude.json` and tools write `~/.config` and `~/.cache` |
| `.../coders/runner-home` | runner, 0700 | The runner's `HOME`, closed to the coder user. The runner gets no agent config directories |
| `<runtimeDir>/coders` | root:coders, 1730 | Each running session's directory goes here. The agent and the coder user may make and enter one; nobody may list it, so a session id is never seen there; the bot user's commands may not enter it |
| `<runtimeDir>/coders/<session id>` | the agent, group coders, 2770 | Holds the session's two unix sockets (`permission.sock`, `credential.sock`, 0660). Removed when the process ends |
| `/home/bot/repos` | bot:coders, 2775 (setgid) | Clones and worktrees. Setgid keeps every file in the coders group, every session runs under `umask 002`, and the server clones with `core.sharedRepository=group`, so the coder user and the bot user both read and write them |

`layOut` (`privileges.ts`) makes the state and runtime directories as root before the agent drops privileges; `dropToBot` now keeps the coders group (and no other) so the agent can give each session directory to it; `shareRepos` makes the repositories directory as the bot user. A worktree is `repos/<owner>/<name>/.worktrees/<branch slug>`, so two sessions never share a working tree. git is told through `GIT_CONFIG_COUNT` (after any config file, so a repository's own config cannot replace the helper) which directories it may trust although another user owns them: the session's own worktree and its repository, never `*`. The runner names the two in `start` as `safe_directories`; the agent refuses any that is not a normalized absolute path under the home (`isSafeDirectory`, `coder-paths.ts`) and, when the frame names none, derives them from the session's cwd.

### 22.2 How a session runs

1. **The tool.** `code_task` (group `coder`, `packages/agent/src/tools/coder.ts`) takes `agent`, `repo` (an id or `owner/name`), `prompt`, and optional `model`, `branch`, `base`, `mode` (`plan`, `edit` by default, `pr`) and `session_id`. The agent and model come from the call, else the Bot's `coder.defaultAgent` and `coder.models`, else the owner's defaults from Settings > Coding agents (`coder_accounts.is_default` and `coder_accounts.model`; `resolveCoderChoice`). When either is still missing, the tool posts the `coder_choice` widget instead of starting anything and the run waits on it (`WaitFor({ reason: 'widget' })`): the owner picks an agent and a model, optionally kept as their defaults (the widget's action hook, `writeCoderDefaults`), and the run resumes told to call `code_task` again with them. A continued session (`session_id`) never asks: it keeps its own agent and the model stored on `coding_sessions.model`. It calls `CoderServices.start` (`coderServices` in `services/coder-tool.ts`, which calls `startCodingSession` in `services/coding-sessions.ts`), which checks the Bot may code (`coderEnabled`), the repository is the owner's and on the Bot's allowed list, and no session of the Bot is running; then inserts the `coding_sessions` row (or reopens an ended one to continue it), posts the `coding_session` widget in the run's chat and enqueues a `session` job on the `coders` queue. The tool throws `WaitFor({ reason: 'widget' })`: the run goes `waiting` on the widget's `pending_run_id`, as a sign-in request does (5.6). An agent that is not signed in gets the `coder_login` widget instead, and the run waits on that (22.5).
2. **The claim.** The runner (`services/coder-runner.ts`, one job per session, like one run job per run) claims the row from `queued` to `starting` under a per-owner advisory lock that counts the account's live sessions, so a fourth beyond `DEFAULT_MAX_CONCURRENT_SESSIONS` (3) waits and tries again after 30 seconds.
3. **The checkout.** `ensureCheckout` (`services/repos-checkout.ts`) starts the computer, then clones or fetches as the `runner` user through the credential helper, checking the checkout's own config first (`assertRunnable`, 22.12). The remote's `url` is `https://fetch@github.com/<owner>/<name>.git` and its `pushurl` `https://push@github.com/<owner>/<name>.git` (22.4). The default branch is read from the remote (`git remote set-head origin --auto`, then `origin/HEAD`) and written back to `repos.default_branch` when the stored one is wrong; the checkout's state (`ready`, `behind`, `dirty`, `error`) and ahead and behind counts go on `repo_checkouts`. One checkout operation runs at a time per repository and computer in a process. `ensureWorktree` keeps a worktree already there (a continued session), else adds one from the branch when it exists, else makes the branch from `origin/<base>`. A branch the call did not name is `bot/<first words of the prompt>-<id>`.
4. **The process.** The runner opens `WS /coder` on the agent (22.3) with the adapter's launch plan. For Claude Code (`services/coder-adapters/claude.ts`): `claude -p --output-format stream-json --verbose --max-turns 200 --permission-mode acceptEdits` (`plan` in plan mode), `--allowedTools` built from the policy (edits, git's read and commit commands and the common test runners when `other` is auto; package installs when `install` is auto), `--disallowedTools` for `git push`, `WebFetch` and `WebSearch` (and the edit tools in plan mode), `--permission-prompt-tool mcp__openbots__permission_prompt` with an inline `--mcp-config`, `--resume <id>` for a continued session, and the prompt after `--` behind a short preamble (work in this worktree, commit, do not push, run the tests, summarize). The runner names the checkout and the worktree as the frame's `safe_directories` (22.1) and adds `OPENBOTS_APPROVAL_TTL_MS`, the approvals' TTL from `OPENBOTS_APPROVAL_TTL_MINUTES`, so a prompt inside the session waits exactly as long as an approval lives. The environment adds `DISABLE_AUTOUPDATER=1` and the git identity (GH8): author and committer "<Bot name> (OpenBots)" at `<bot handle>@openbots.local`, with the preamble asking for a `Co-Authored-By` trailer naming the owner on every commit.
5. **The output.** The adapter parses each stdout line into `CoderEvent`s (`text`, `tool_use`, `file_change`, `command`, `approval_request`, `usage`, `result`, `error`). `services/coder-state.ts` appends them to the widget's feed (the last 200 lines, 500 characters each, one write and publish per 500 ms) and the raw output to `<filesDir>/coders/<session id>.log` on the server (8 MB at most). A running session marks the computer used every 60 seconds (`EXEC_TOUCH_MS`) so the idle sweep leaves it up, and stops at its time limit (`DEFAULT_SESSION_MINUTES`, 60). A vendor session id is kept only when it is a UUID, since it reaches a terminal preset. When the CLI ends on the vendor's rate limit (the adapter's `rateLimited`, read from the CLI's own words), the session goes `waiting`, says so in the feed and waits until the reset the message states (`rateLimitResetMs`), or 60 seconds when it states none (`RATE_LIMIT_WAIT_MS`), then launches once more. It retries once: a reset further off than 30 minutes (`RATE_LIMIT_MAX_WAIT_MS`), or a second limit, fails the session with the vendor's line.
6. **Permission prompts.** Claude Code calls the permission MCP server, whose prompt reaches the runner as `permission_request`. The adapter's `classify` gives it an action class (22.7), `coderActionDecision` decides: `auto` answers allow at once, `deny` answers deny, `ask` inserts an `approvals` row with `session_id` and `action_class` (22.6).
7. **The end.** When the CLI exits, the runner (`services/session-git.ts`) makes the safety-net commit (22.13), then reads the branch's commits and changed files from git against the base. In `pr` mode it then asks once, "Push and open a PR for <branch>" (tool name `open_pull_request`), and on approval sets `push_allowed`, checks the checkout's config again, pushes with its own git as the runner and opens the pull request through GitHub's REST API with `pullRequestToken` (`services/git-credentials.ts`, GH8): an installation token with `pull_requests: write` through an App connection, so the App opens it, or the owner's OAuth token when the connection acts as the owner; the connection's token, or the GitHub connector's, otherwise. The agent never needs `gh`. A denial keeps the branch on the computer. `settleSession` stores the summary, changed files, commits, usage and PR link on the row and the widget, expires the session's pending approvals, and resumes the waiting run with `widgetToolResult('coding_session', state)`, so the Bot reports in its own words.
8. **The owner's actions.** Stop publishes `stop` on the control channel (a session nobody claimed yet is stopped in place and its run resumed). Continue posts the owner's prompt in the session's chat as "Continue coding session <id>: <prompt>", and the Bot's next run calls `code_task` with that `session_id` (the operating rules say so), which reopens the row with its vendor session id, so there is always a run to ask in and to hear the result. Discard removes the worktree, its local branch and the log (`discardWorktree`); a branch the session pushed is deleted on GitHub too, as the runner after `assertRunnable`, unless a pull request was opened from it, which keeps it, and the feed says which. The widget's actions are `services/coder-widget-actions.ts`. Open terminal asks `GET /coding-sessions/{id}/terminal` for `{cwd, user: 'coder', preset}` and opens the Computer page's terminal there (9.3); the session's run keeps waiting.

### 22.3 The `WS /coder` socket

Shaped like `WS /mcp/stdio` (`apps/computer-agent/src/coder.ts`, frames in `protocol.ts`, the server's client `agent.coder()` in `packages/computer/src/agent-client.ts`). The first frame is `start`; the agent answers `started` and relays the process.

| Direction | Frames |
| --- | --- |
| Server to agent | `start` (`session_id`, `user` `coder` or `bot`, `command`, `args`, `cwd` under the home, `env` overlay, `pty` with `cols` and `rows`, `git_credentials`), `stdin` (with `end`, since `claude -p` reads a piped stdin to its end), `credential` (the answer to a `credential_request`), `answer` (allow or deny for a `permission_request`), `signal`, `resize` |
| Agent to server | `started` (`pid`, `session_dir`), `stdout`, `stderr`, `credential_request` (`protocol`, `host`, `path`, `username`), `permission_request` (`tool_name`, `input`), `exit`, `error` |

The agent fills `{{session_dir}}`, `{{session_id}}` and `{{home}}` in `env` and in `args` before the first literal `--`, never after it, where the prompt is. One socket per session id; a second is refused. The process runs through `runas` in its own process group; closing the socket from either side, or the process's exit, sends SIGTERM to the whole group and then SIGKILL, so what it left running in the background goes too, and removes the session directory. `args` and `env` carry prompts and keys; they go to `spawn` and are never logged. Vendor logins use the same socket with `pty: true` and `git_credentials: false`.

### 22.4 The permission relay and the credential helper

**Permission relay (I11).** `apps/computer-agent/src/coder-permission-mcp.ts`, at `/app/apps/computer-agent/dist/coder-permission-mcp.js` in the image, is a stdio MCP server with one tool, `permission_prompt`, that Claude Code starts inside the session as the coder user. Each call writes one JSON line `{request_id, tool_name, input}` to `$OPENBOTS_CODER_SOCKET` (the session's `permission.sock`) and reads one line `{decision, message?}` back, which the agent relays from the server's `answer`. It answers Claude Code's `{"behavior":"allow","updatedInput":...}` or `{"behavior":"deny","message":...}`. Anything that goes wrong denies, and a prompt waits as long as `OPENBOTS_APPROVAL_TTL_MS` says (24 hours without it), like an approval.

**Credential helper (I5).** `openbots-git-credential` runs `apps/computer-agent/src/git-credential-helper.ts`. git calls it with `protocol`, `host`, `path` and `username`; it writes them as one JSON line, with the secret from `$OPENBOTS_CODER_SESSION`, to the session's `credential.sock` (`$OPENBOTS_CODER_CREDENTIAL_SOCKET`), and prints the username and password that come back. For anything else (no session, a refusal, no agent) it prints nothing and git fails for want of a credential. `store` and `erase` do nothing. The secret is 32 random bytes the agent mints for each process at `start`, compared in constant time; it is not the server's session id, which the Bot's own shell can learn from widget props and tool results. The agent turns an accepted line into a `credential_request` and waits up to 30 seconds for the server's `credential`. There is no loopback HTTP endpoint for this: the design's `POST /git/credential` was replaced by the per-session unix socket, and the agent answers that path 401 like any request without its token.

The server answers in `services/git-credentials.ts` (`resolveGitCredential`). It fails closed: only `github.com`; only when git named a path (`credential.useHttpPath` is on, so a request without one is not git's) and the path is the session's own repository, or the repository of the runner's own operation in progress (`runnerSessionIds`, deleted when that git command ends). A `push` username is served only when the session is push-approved; a `fetch` username to the runner always, and to a session only through an App connection (a read token); any other username only when push is approved ("Use the repository remote OpenBots set up"). The token comes from the repository's git connection (`connectionForRepo` in `services/git-connections.ts`: the connection it was picked from, else the owner's connected App installation on the repository's account), and with none from the GitHub connector: the GitHub built-in's `GITHUB_TOKEN` first, then the GitHub connector's personal access token or OAuth access token. It is answered as `x-access-token`, travels in the one `credential` frame and is never written on the computer. A token GitHub cannot narrow (a `device`, `oauth` or `token` connection, or the connector's) is served inside a session only for its approved push, through the push URL; a session's fetch with one is denied ("Fetching inside a session needs a GitHub App connection"), since the runner fetched the worktree before the session began.

| | Device user-token / OAuth / token connection or the GitHub connector | Server-managed GitHub App connection |
| --- | --- | --- |
| Fetch and clone | The runner's own clone and fetch only; a session's fetch is denied | An installation token with `contents: read` for that repository, cached until five minutes before its hour is up |
| Push | The same token, only for the push URL (`push@`) and only while the session is push-approved | A second token with `contents: write` and `pull_requests: write`, minted only after the approval, only for that repository, and only where the owner can push |
| Enforced by | The username convention, the agent's disallowed `git push` and its permission hook. Since a session gets no fetch credential, an agent that rewrites its remote to the `fetch@` URL gets nothing | GitHub: a push with the read token answers 403 whatever the agent does (S-29) |

### 22.5 Sign-in (`coder_logins`, I4)

`services/coder-login.ts` and `services/coder-login-driver.ts`. `startLogin` records a `coder_logins` row, reusing a pending one for the same agent, posts the `coder_login` widget when a Bot asked (in the main Bot's transcript with a handoff line in the Bot to Bot chat, like a site sign-in request, section 9.7), and enqueues a `login` job. `runCoderLogin` (the driver) starts the computer and runs the adapter's login over `WS /coder` in a PTY as the coder user with the agent's config directory, so the credentials land on the state volume and never pass through the server. It reads the link and any device code from the output with the adapter's `parseLogin`, shows a link only when it is https on one of the agent's sign-in hosts (`loginLink`), and moves the row from `pending` to `awaiting_code` when the CLI asks for the code. The owner's code (`POST /coders/{agent}/login/{loginId}/code`) goes to the job over the control channel as `stdin` for the login's id, so the API process need not be the worker running the login; it is never stored and is cut out of any error text. The web widget's Show QR draws the link as a QR code, so a phone can open it. On success the row is `signed_in`, `coder_accounts` says `subscription` with the account label and CLI version (`coderVersion`, `services/coder-commands.ts`), the audit log gets `coder.sign_in`, and every run waiting on the widget resumes. A login expires after 10 minutes. When a session finds the agent signed out (the adapter's `needsLogin`), the session fails with `needs_login`, the account records the error, and the run that waited on the `coding_session` widget is moved to wait on a new sign-in (CA10). An API key from Settings > Models (`PUT /coders/{agent}/api-key`) sets `auth_kind` to `api_key`; Sign out empties the agent's config directory on the computer as the coder user.

Claude Code's login is `claude auth login --claudeai` with `BROWSER=/bin/true`, so it never tries a browser on the computer. It prints "If the browser didn't open, visit:" with the link as an OSC 8 hyperlink (the adapter strips the escapes and matches `https://claude.com/cai/oauth/authorize...`), then "Paste code here if prompted > " and waits. The owner pastes the `code#state` the page shows. Input without the `#` prints "Invalid code. Please make sure the full code was copied.", which the driver shows as the sign-in's notice while the field stays open; "Login successful." ends it with exit 0. The credentials land in `$CLAUDE_CONFIG_DIR/.credentials.json`, and nothing secret is printed. `claude setup-token` is not used: it prints a one year token, which a PTY driver would stream to the server. Check runs `claude auth status`, whose JSON says `loggedIn` and `authMethod` (`claude.ai` is a plan sign-in, `oauth_token` a token in the environment); it reads the local credentials only, so a lapsed sign-in still shows in a session's own output. Codex signs in with `codex login --device-auth`, and pi in its own terminal (22.13). One question stays open, since it needs a real Pro or Max account: whether `claude -p` on a plan sign-in bills the plan (CODING_AGENT_VENDORS.md).

### 22.6 Approvals with a session

An approval from a session has `approvals.session_id` and `approvals.action_class` and no paused run of its own: the session's job waits on the agent's prompt. `POST /approvals/{id}/decide` sees `session_id` and publishes the decision on `openbots:coder-control` instead of resuming a run; an approved `push` or `pr` also publishes `push_allowed`, which arms the session's push credential and sets `coding_sessions.push_allowed`. The widget shows the decision; the existing notice watcher sends the notification on the Mac and the phone. Expiry (24 hours) and the run's cancellation answer deny, and a session that ends expires its pending requests with their events and audit entries (`expireSessionApprovals`).

A session asks the same way on a Bot's turn and on the owner's own turn (CA15). On a Bot's turn the row has the session's run in `approvals.run_id`; on the owner's turn there is no run, so `run_id` is null and a check (`approvals_run_or_session`, `drizzle/0036_approvals_without_run.sql`) holds that `run_id` or `session_id` is set. Such a row goes with its session (`session_id` cascades). Its `approval.*` events carry the session's Bot and chat and its owner (`bot_id`, `chat_id`, `user_id` and `workspace_id`), so every socket of the owner hears it and the notice names the Bot. `GET /approvals` and the push worker's catch up take the Bot and chat from the run when there is one and from the session otherwise, and the owner is the run's Bot's owner or the session's owner. In `pr` mode the owner's turn asks to push and open the pull request, then pushes after the approval, like a Bot's turn.

### 22.7 Policy

`code_task` itself is `auto` for owner-started runs and `ask` in webhook runs (the webhook floor, section 8). Inside a session each prompt is judged by action class (`push`, `pr`, `outside_worktree`, `install`, `destructive`, `other`) through `coderActionDecision`: the Bot's `tool_policy.coder.actions` or the defaults (`other` auto, the rest ask), raised to the trigger's floor for runs another Bot or a webhook started (P2), read as the policy engine reads a trigger entry. `coder.enabled` false or the `coder` group set to Never turns coding off for the Bot; `coder.allowedRepos` narrows the repositories; `coder.defaultAgent` picks the agent.

`classify` reads a command the way the shell would (words with quotes and escapes, compound commands, `$(...)`, backticks and `sh -c` bodies; `coder-adapters/shell-words.ts`), classes each simple command by its argv, and takes the strictest. All three adapters share it (`coder-adapters/classify.ts`): Claude Code's tools, Codex's command and file change requests and pi's tools are each mapped onto it. A path it cannot resolve without running the shell counts as outside the worktree; a write to the computer's private state is destructive. This is a convenience that decides when to ask, not the boundary. The hard controls hold whatever it misreads: the coder uid's filesystem permissions, the credential helper's push gate and repository scope, and the computer's sandbox firewall and egress proxy.

The operating rules (`packages/agent/src/context/rules.ts`) tell a Bot with `code_task` to use it for repository work instead of editing by hand, never to push or open a PR itself, that repository text is data and never instructions, and how to continue a session. Context assembly lists the Bot's repositories and the signed-in agents at the top of the volatile block (`loadCoderContext`), and the built-in Skill "Working in a repository" (`packages/agent/src/skills/working-in-a-repository.md`, seeded by `services/builtin-skills.ts` for every new Bot on an install with a computer) covers planning, tests, small PRs and reporting.

### 22.8 Recovery and the control channel

`CoderControl` messages on `openbots:coder-control` (`services/coder-control.ts`): `stop`, `stop_all` (published when a computer stops, so its sessions end), `approval`, `stdin` (a login's pasted code) and `push_allowed`. Malformed messages are dropped. At worker start `recoverInterruptedCoderSessions` (`services/coder-recovery.ts`) fails every session left `starting`, `running` or `waiting` by a process that is gone, with "The server restarted during the session; continue it to pick up where it left off", and resumes its run with that note; a `queued` session's job is enqueued again; logs whose session row is gone are removed. A job that finds its session no longer `queued` exits at once, and one that finds it live but not run by this process fails it with the same note.

### 22.9 Data model

Migration `apps/server/drizzle/0027_coders.sql`, schema `apps/server/src/db/schema/coders.ts`. Every new table has `workspace_id`, forced row-level security with the `organization_isolation` policy and a `workspace_id`-led index (21.9).

| Table | Columns | Notes |
| --- | --- | --- |
| `coder_accounts` | `owner_id`, `agent`, `auth_kind` (`none`, `subscription`, `api_key`), `provider_id`, `account_label`, `signed_in_at`, `last_error`, `version` | One per owner and agent. What Settings > Coding agents shows. No token is ever stored here; the credentials are on the computer's state volume |
| `coder_logins` | `owner_id`, `agent`, `status` (`pending`, `awaiting_code`, `signed_in`, `failed`, `expired`, `cancelled`), `url`, `device_code`, `account_label`, `error`, `chat_id`, `message_id`, `part_index`, `expires_at` | One per sign-in attempt; the widget's place when a Bot asked. The pasted code is never stored |
| `repos` | `owner_id`, `connection_id` (null for Add by URL), `full_name`, `remote_url`, `default_branch`, `visibility`, `description`, `keep_cloned`, `pinned`, `last_used_at` | The remembered list, unique per owner and remote, 50 per account (`DEFAULT_MAX_REPOS`) |
| `repo_checkouts` | `repo_id`, `computer_id`, `path`, `state` (`cloning`, `ready`, `behind`, `dirty`, `missing`, `error`), `ahead`, `behind`, `head_sha`, `last_fetch_at`, `error`, `disk_bytes` | What is on a given computer, unique per repository and computer. `disk_bytes` (`drizzle/0032_repo_checkout_disk.sql`) is the checkout's size with its worktrees, measured at each refresh, `diskBytes` in the view |
| `coding_sessions` | `owner_id`, `bot_id`, `run_id`, `chat_id`, `message_id`, `part_index`, `agent`, `repo_id`, `repo_full_name`, `remote_url`, `worktree_path`, `branch`, `base`, `mode`, `prompt`, `vendor_session_id`, `status`, `push_allowed`, `usage`, `summary`, `changed_files`, `commits`, `pr_url`, `error`, `log_path`, `started_at`, `finished_at`, `diff_artifact_id` | One per `code_task`; a continued session keeps its row. Statuses `queued`, `starting`, `running`, `waiting`, then `settled`, `failed` or `stopped`. `push_allowed` is what the credential helper's answer checks. `diff_artifact_id` (Phase 3, `drizzle/0031_coding_session_diff.sql`, set null when the Artifact is deleted) is the session's diff Artifact (22.13) |
| `approvals` (existing) | adds `session_id` (references `coding_sessions`), `action_class` | Same expiry and audit as every approval |
| `coding_session_events` | `session_id` (cascade), `seq`, `turn`, `at`, `event` (`CoderTranscriptEvent`) | A session's transcript for the drawer (CA15; `drizzle/0035_coding_session_events.sql`, which also adds `coding_sessions.title`, the session's name from its first prompt). `seq` counts from 1 per session, unique with `session_id` (the index it is read by); `turn` counts the prompts, so a prompt starts the next one. Written by `services/coder-transcript.ts`, one session's writes in order under a lock on the session: the prompt `code_task` or the owner sent, every event the runner parsed and its own notes, each string clipped to `SESSION_EVENT_TEXT_MAX`, at most `SESSION_EVENTS_MAX` entries (the last one says the rest is in the log). A permission prompt's input is never kept, and the text is what the runner already masked the provider key out of |

The Phase 2 tables (`git_connections`, `instance_settings`, `github_state_nonces`) and the columns it added to `repos` are in 22.12.

### 22.10 Routes and widgets

Under `/api/v1`, tag `coders`, all owner-scoped (`routes/coders.ts`, `routes/coding-sessions.ts`, `routes/repos.ts`):

| Route | Purpose |
| --- | --- |
| `GET /coders` | Each agent: auth kind, account, version, last error and its kind, provider, whether this build runs it, whose plan a plan sign-in bills (`planProvider`), whether Check works (`checkAvailable`) and how it signs in (`signIn`: `link`, `device` or `terminal`) |
| `POST /coders/{agent}/login`, `GET` and `DELETE /coders/{agent}/login/{loginId}` | Start a sign-in with the vendor's own login, read its link, code and status, cancel it |
| `POST /coders/{agent}/login/{loginId}/code` | The code the vendor gave, written to the login on the computer, never stored |
| `PUT /coders/{agent}/api-key`, `POST /coders/{agent}/sign-out` | Use a Settings > Models provider's key (400 `CODER_PROVIDER_UNSUPPORTED` for one the agent cannot use); empty the agent's config directory on the computer |
| `POST /coders/{agent}/check` | Ask the CLI on the computer whether it is signed in, and record what it says: `claude auth status`, `codex login status`, `pi auth check` (22.5, 22.13). 400 `CODER_CHECK_UNSUPPORTED` for an agent whose adapter has no check |
| `GET /coding-sessions`, `GET /coding-sessions/{id}`, `GET /coding-sessions/{id}/log` | The owner's sessions newest first, one session, its full log (`text/plain`) |
| `GET /coding-sessions/{id}/terminal` | `cwd`, `user` and `preset` for `/api/v1/computer/pty` (409 `NO_WORKTREE` without one) |
| `POST /coding-sessions/{id}/stop`, `/continue`, `/discard` | The widget's actions, through the same path as the widget so the two never disagree |
| `GET /coding-sessions/{id}/events?after=&limit=` | The transcript after a `seq` (default 0), at most `limit` (1 to 500, default 200): `{ entries, hasMore }`, each entry `{ seq, turn, at, event }`. An `approval_request` entry's `request_id` is the `approvals` id, so the drawer decides it with `POST /approvals/{id}/decide`; `GET /approvals` items carry `sessionId` too |
| `POST /coding-sessions/{id}/turns` | The owner's own next prompt (CA15), straight to the agent: the ended session is queued again with `run_id` null, so no earlier run is resumed. The runner asks the owner for approvals and, in `pr` mode, pushes after the approval like a Bot's turn (22.6); only a sign-in still needs a run, so a signed out agent fails the turn. 409 `SESSION_RUNNING`, `CODER_BUSY` (the lock and check of `code_task`), `REPO_FORGOTTEN` or `NEEDS_LOGIN`; 403 `CODER_DISABLED` or `REPO_NOT_ALLOWED`. The widget is queued again with `Continue: <prompt>` in its feed |
| `GET /repos`, `POST /repos`, `DELETE /repos/{id}` | The remembered repositories with their checkout state; remember one by its git URL; forget one (its clone stays) |
| `POST /repos/{id}/clone`, `POST /repos/{id}/update` | Clone again; fetch. Both queue a `checkout` job |

Every session view carries `title`. Two realtime events go to the owner (`user_id` and `workspace_id`, no subscription): `coding_session.updated` with the session as `GET /coding-sessions/{id}` returns it, whenever its row changes through `coder-state.ts` (status, result, usage, error), when it starts or reopens, and on Discard; and `coding_session.events` with `{ sessionId, entries }`, batched at most every 500 ms and always sent before the `coding_session.updated` of the change they led to. The view and its publishing live in `services/coding-session-view.ts`, a leaf module, so `coder-state.ts` can publish without importing `coding-sessions.ts`.

The drawer is web only, in `apps/web/src/features/coders/drawer/`: the sidebar's Coding sessions button (`drawer.tsx`, with the live count) opens it in the right panel at its wide width (`right-panel.tsx`, id `coding-sessions`), and a Bot page's panel restore and close leave it open (`features/transcript/panel.tsx`). The button sits in every page's shell, so it stays light: the body (`drawer-content.tsx`, with the session view, its markdown and the terminal) loads when the drawer first opens, and the panel's frame is its own module (`panel-frame.tsx`) so the drawer does not load the artifact viewer or the screen preview. `live.ts` applies `coding_session.updated` to the list and refetches `GET /approvals` on `approval.requested` and `approval.resolved`; `use-session-transcript.ts` reads `/events` from the start and appends `coding_session.events`, reading on from the last unbroken `seq` whenever one is missing and on each status change; `transcript.tsx` draws the conversation and gives a request its Approve and Deny when a pending approval of the session has its `request_id`; `session-view.tsx` holds Stop, the Terminal toggle (`ComputerTerminal` on `GET /coding-sessions/{id}/terminal`) and the composer, which posts to `/turns` once the session has ended. The agents' marks are in `features/coders/agent-mark.tsx`.

The terminal proxy (`ws/computer.ts`, `ptyParams`) passes `cwd`, `user` and `preset` to the agent only when `cwd` is one of the owner's session worktrees or repository checkouts, and drops them otherwise; a preset is at most 500 characters and is typed without a newline.

Widgets (section 12.2), both posted only by the system: `coding_session` (`packages/widgets/src/kinds/coding_session.ts`; props agent, repository, branch, mode; state status, feed, approvals, result, control; actions `stop`, `continue`, `discard`, `open_terminal`, the last the client's own) and `coder_login` (`coder_login.ts`; props login id, agent, url, device code, instructions and the other Bots waiting; state status, account, whether a code was sent; actions `code`, `cant`, `api_key`). Their `toolResult` gives the run a compact outcome with how to continue, and never tells a Bot to ask for credentials. Web renderers are in `packages/widgets/src/renderers`, with the host in `apps/web/src/features/coders/session-host.ts`; the phone (`apps/mobile/src/transcript/coder-widgets.tsx`) shows a session read only with its last eight feed lines, answers approvals and Stop, and drives the sign-in. Settings > Coding agents is `apps/web/src/features/coders/settings.tsx` (its one fixed note, pi's, in `agents.ts`), the Repositories section `apps/web/src/features/repos/repositories.tsx`, and the per-Bot settings sit under the coder group in `apps/web/src/features/tools/bot-tools.tsx`.

### 22.11 Limits

Constants in `packages/shared/src/coders.ts` for now, per account in `limits` later: 3 concurrent sessions per account (the next queues), 60 minutes per session (5 to 240 when it becomes a setting), 200 agent turns per session (`--max-turns`), 50 remembered repositories. A vendor rate limit is waited out once, for at most 30 minutes (22.2).

### Connector startup recovery

`services/connector-startup.ts` runs bounded MCP checks after worker/all startup, in each organization's RLS scope, for active members and usable authenticated connectors. It skips blocked/missing-credential/built-in connections and stdio MCPs whose computer is stopped. Shutdown stops dequeuing checks. Snapshot/error persistence publishes `connector.updated`, so open settings refresh without a reload. `useBootConnectorChecks` also checks the initial list once per frontend session, without a refetch loop or racing newly added/signing-in connectors. `repairEmptyGitHubAuth` upgrades old empty bearer GitHub records to OAuth using compare-and-swap, preserving working PATs and Bot bindings. Bare catalog OAuth create requests are owner/workspace-scoped and advisory-lock serialized; named/explicitly configured connections remain independent. Regression coverage: `services/connector-recovery.test.ts`, `routes/github-device.test.ts` (the bare create body), and `features/tools/connect.test.tsx` (rapid clicks, retry/cancel, boot checks).

### 22.12 GitHub connections (Phase 2)

Phase 2 replaced "the owner's token for everything" with git connections, and made the remembered repositories outlive the computer's home. The shared vocabulary (connection kinds, `act_as`, statuses, checkout states, the views, the webhook path and events, the job intervals, rescue branch naming and the Routine templates) is `packages/shared/src/git.ts`.

**Connections.** `services/git-connections.ts`. A connection is one of four kinds: `device`, the default shared GitHub App's device-authorized user token (see below); `app`, an installation of the install's GitHub App, which keeps no token and mints installation tokens; `token`, a pasted fine-grained token, checked with `GET /user` and kept sealed in `secrets`; and `oauth`, the owner's GitHub sign-in, which the data model and the credential path handle but no screen creates yet. The App is preferred (GH1). Which App an install uses is `services/github-app-store.ts`: the managed service's shared App from `GITHUB_APP_*` (`config.githubApp`), else the self-hoster's own, kept in `instance_settings` under `github_app` as one sealed JSON envelope that master key rotation re-seals. Config wins when both exist. `services/github-app.ts` is one service per install, so its token cache is shared; every call to GitHub goes through the outbound guard (S-8) held to GitHub's hosts, with a 30 second timeout, and no token is logged.

**Shared coding-repository device flow (GH1, GH2, GH7, GH8).** `services/git-device.ts`, `git-device-token.ts`, `github-user-app.ts`, and `git-connection-secrets.ts`. `POST /git-connections/github-app/device` starts an owned pending connection or reauthorizes a device connection. `POST /git-connections/{id}/device` polls under owner and row locks, enforcing intervals, expiry and `slow_down`; exchanged tokens stay sealed across installation/API retries. Completion requires an active installation of the selected App and reads its user-accessible repositories, across accounts. Public default identifiers come from `OPENBOTS_GITHUB_CLIENT_ID` / `OPENBOTS_GITHUB_APP_SLUG`; per-connection public overrides remain supported. Tokens refresh without a client secret under a row lock, shared by API and workers. Picker/sync reload the user/installation intersection. The existing runner clones/fetches and pushes; the sandbox receives no device user token until an approved push for the exact repository. This is not an installation token: it cannot be narrowed to one repository or read-only. PR identity is the authorizing user, and the device connection has no centralized App webhook. The separate MCP connection is not used to populate this connection. Existing configured/manifest Apps and PAT connections remain supported. See [GITHUB_REPOSITORIES.md](../GITHUB_REPOSITORIES.md) for boundaries and real-provider checks.

**The manifest flow.** `POST /git-connections/github-app/manifest` (admins only, self-hosted only, 409 on managed, with an App from config, or when one is stored) builds the manifest: the name `OpenBots (<host>)`, the webhook at `GITHUB_APP_WEBHOOK_PATH`, the redirect and callback URLs under `OPENBOTS_PUBLIC_URL`, which must be https (400 `PUBLIC_URL_REQUIRED` otherwise), `request_oauth_on_install: true`, `public: false`, the permissions `contents: write`, `pull_requests: write`, `issues: write`, `metadata: read`, `checks: read`, and the events `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `check_run` and `push` (GitHub sends `installation` and `installation_repositories` to every App unasked). With `organization` the form goes to that organization's new App page, else to the admin's own; the App is private, so only that account can install it. The client posts the manifest to GitHub, which redirects to the manifest callback; it exchanges the `code` (`POST /app-manifests/{code}/conversions`), refuses to overwrite an App already there, checks that the user the state names is still an admin, and stores the App.

**State and nonces.** Each flow's `state` (purpose `manifest`, `install` or `reauth`) is signed with a key derived from the master key, bound to the owner and organization that started it (and for `reauth` to the connection), and holds 10 minutes (`signGithubState`, `verifyGithubState`). `consumeGithubState` spends it once: its nonce goes into `github_state_nonces`, and a second callback with the same state is refused. Expired nonces are deleted as new ones come.

**The install callback.** `GET /git-connections/github-app/install` sends the browser to `github.com/apps/<slug>/installations/new` with a signed state. Because the App requests user authorization during install, GitHub comes back with a `code` beside `installation_id`. A state proves who started the flow, not that the installation is theirs, since anyone can type an `installation_id`. So `connectInstallation` exchanges the code for a user-to-server token, refuses with 403 `INSTALLATION_NOT_YOURS` unless `GET /user/installations` lists the installation, reads `GET /user/installations/{id}/repositories` with the user's `push` and `admin` on each, and revokes the user token right after, whatever happened. That list is `git_connections.repositories`, the connection's whole reach (H1 in the code): the picker shows only those repositories, a token is minted only for one of them, and a write token only where `push` is true. Several owners, here or in other organizations, may connect the same installation, each held to their own access. An App from `GITHUB_APP_*` needs "Request user authorization (OAuth) during installation" on and its client id and secret set; without them the callback answers 409 `GITHUB_APP_NO_CLIENT`.

**Re-authorize and sync.** OpenBots keeps no user token, so a sync (`POST /git-connections/{id}/sync`) can only drop what the installation no longer reaches; it answers `needsReauthorize: true` for an App connection, and the card offers Re-check access. `GET /git-connections/{id}/reauthorize` sends the owner to `github.com/login/oauth/authorize` with a `reauth` state; the callback reads the reach again (`refreshRepositories`). A 404 or 403 from GitHub on an App connection marks it `needs_reinstall`, a 401 `revoked`.

**Installation tokens.** `tokenForConnection` mints, per request, a token narrowed to one repository: `contents: read` for a fetch, `contents: write` and `pull_requests: write` for a push (`permissionsFor`), and `pull_requests: write` alone for opening a pull request. It refuses with 403 `CONNECTION_NO_ACCESS` a repository of another account, any repository before the owner's reach was read, one not in the reach, and a write where the owner cannot push; git-credentials.ts turns that into a denial git is told. Tokens are cached per installation, sorted repositories and permissions until five minutes before their hour is up, and expired ones are evicted on every mint. The App's JWT is RS256, signed with `node:crypto`, issued a minute back for clock drift and good for nine minutes.

**The runner user and why.** In Phase 1 the runner's own git ran as `coder`, the uid every coding session has. A process of a session can read `/proc/<pid>/environ` of any process of its uid, and the runner's git carries the credential relay's secret for whichever repository it is cloning, fetching or rescuing, write tokens included. So every server git operation now runs as `runner` (uid 1801, group coders; `apps/computer-agent/src/users.ts`, `native/runas.c`, `user: 'runner'` on `WS /coder`), with its own home and no agent config directories (`sessionUser` in `coder.ts`). Its session directory is made like any other (2770, the coders group) under the unlistable 1730 parent, so its name cannot be found and its secret sits in an environment only the runner can read.

**Untrusted repository config.** The runner runs git in checkouts a session can write, so a repository's own `.git/config` is untrusted. Every runner git command starts with `RUNNER_GIT_CONFIG` (`services/repos-checkout.ts`): `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `core.sshCommand=/bin/false`, an empty `core.askPass`, `protocol.allow=never` with only `https` allowed, `uploadpack.allowFilter=false`, `gpg.program=/bin/false`, `commit.gpgsign=false`, an empty `core.alternateRefsCommand`, no proxy, TLS verification on with the system CA file, and no extra headers, also for `http.https://github.com/.*`. Command line `-c` wins over the repository's config for a plain key, but a `http.<url>.*` key naming more of the URL would still win, so before git runs in a checkout `assertRunnable` reads the config as a file (no discovery, no includes followed), and every `config.worktree` when `extensions.worktreeConfig` is on, and refuses with `CONFIG_REFUSED` ("The repository's git configuration was changed in a way OpenBots does not run; remove it or forget and clone the repository again") any `http.*`, `url.*`, `include*`, `credential.*`, `alias.*`, `filter.*`, hook, pager, editor, proxy, command or driver key, and an `origin` URL or push URL other than the runner's own. `lockDown` first makes `.git/config` 0644 and `.git/hooks` and `.git/info` not group or other writable, and a `stat` check then requires each config file to be the runner's (uid 1801) and writable by nobody else; a config a session replaced is the session's, not the runner's, and is refused. Objects, refs, the index and logs stay group writable, so a session still commits. The checkout, the refresh, the approved push and rescue all run the check.

**The `fetch@` and `push@` convention.** It stays (22.4), but with an App connection GitHub now enforces it: a session is served the read token for a fetch, and the write token only after its push is approved, so a push through the fetch URL answers 403. With a token connection or the connector, a session gets no fetch credential at all.

**Remembered repositories.** `services/repos.ts`, the jobs in `services/repos-scan.ts`, `services/repos-refresh.ts` and `services/repos-rescue.ts` on the `coders` queue, each running git as the runner and none starting the computer except rescue. A repository is picked from a connection (`POST /repos/remember`, checked against `connectionAllows`), added by URL, or remembered from a found clone. `reconcile` runs after every computer start and at worker start: checkouts gone from disk become `missing`, and every `keep_cloned` repository that is missing, has no checkout, or was left `cloning` or `updating` for 30 minutes is cloned again, most recently used first, with one event row for what was cloned and one for what failed in the main Bot's transcript (GH4); the failure row is a `repos_clone_failed` event, so the Mac and the phone notify on it (`REPOS_CLONE_FAILED`, `packages/shared/src/notices.ts`). `refresh` fetches every settled checkout of a running computer every 15 minutes (`REPO_FETCH_INTERVAL_MS`, not again within 10 minutes) and records ahead, behind, dirty (any session worktree too), the head, the remote's last push and the checkout's size on disk (`du -sk`, with its worktrees). It then prunes the worktrees of ended sessions whose work is upstream or was let go there: the branch is merged into origin's default branch, or the session pushed it and origin no longer has it. Only a clean worktree goes (`git worktree remove` without force), then `git worktree prune`, and the session forgets the path; a worktree no session names, or one a live session works in, stays. `scan` runs `find` three levels under `/home/bot` (`REPO_SCAN_DEPTH`), skipping `.worktrees` and `node_modules`, reads each `origin` as a file and keeps at most 200; a clone of a remembered repository updates its checkout, any other becomes a found row (`found_path`, never cloned, not offered to a Bot, not counted until remembered), and found rows the scan no longer sees are dropped unless `find` printed nothing (GH6). `rescue` (GH5, `POST /repos/rescue`, then `GET /repos/rescue/{requestId}` every 2 seconds) saves, for each checkout's main worktree and each session worktree not starting, running or waiting, commits on no remote branch and uncommitted changes to tracked files (through `git stash create`, so HEAD, the index and the working tree are untouched) to `openbots/rescue/<UTC minute>/<repository>/<branch>` and pushes it as the runner with a write credential; its results reach every process over the bus and stay readable for 10 minutes.

**The App's webhook.** `POST /api/v1/github/app/webhook` (`routes/github-app-webhook.ts`), outside the authenticated API like the ingress and in its order: the caller's per-address rate limit before the body is read, the payload size limit, then `X-Hub-Signature-256` against the App's webhook secret in constant time (401 with no App or a bad signature, counted on a failed-check bucket per address). After verification the answer is 202 whatever happened, except 429 when the installation's minute is spent, so GitHub never retries a delivery already taken. `services/github-app-webhook.ts` then finds the organizations with a connection to the installation through `githubInstallationWorkspaces` (`db/scope.ts`), which calls `openbots_github_installation_workspaces()`, a SECURITY DEFINER function owned by `openbots_system` that returns organization ids only (`drizzle/0029`); `drizzle/0030` holds that role to the five columns it reads, never `secrets`. Each organization is handled in its own scope, and one's failure does not stop the next. `installation` deleted or suspended marks every connection to it `revoked` or `needs_reinstall`, unsuspended `connected`; `installation_repositories` moves `last_synced_at` and drops removed repositories from every owner's reach. Any other event goes to each enabled Routine of a connection's owner whose GitHub trigger matches (event, action, repository, label, text and `installation_id`, `hooks/match.ts`) and whose repository is in that owner's reach, through the Routine's own endpoint (`acceptDelivery`: logged, idempotent on `X-GitHub-Delivery`, framed as data), as a `webhook` run with the stricter floor (P2). A `push` moves the repository's `last_remote_push_at`.

**Templates (CA11).** `CODING_ROUTINE_TEMPLATES` in `git.ts`, listed by `GET /routines/templates`, made with `template: {id, params: {repo, label?}}` on `POST /bots/{id}/routines` (`routineFromTemplate`, `services/routines.ts`); the template decides the name, prompt and trigger. "Fix issues labeled bot" waits on `label_added` (label `bot` unless the owner names another), "Review new pull requests" on `pr_opened`, and "Weekly dependency update" runs weekly on Monday at 09:00. An event trigger waits on the picked repository, and on its installation when a remembered repository reaches it through an App connection, so the App's webhook delivers it with nothing pasted into GitHub; without one, the endpoint is a plain GitHub one with a token and signing secret, returned once. The web form is `apps/web/src/features/routines/templates.tsx`.

**Tables.** Migrations `0028_git_connections.sql`, `0029_github_app_installations.sql` and `0030_github_app_scope.sql`, schema `apps/server/src/db/schema/git.ts`.

| Table | Columns | Notes |
| --- | --- | --- |
| `git_connections` | `owner_id`, `provider` (`github`), `kind` (`device`, `app`, `oauth`, `token`), `installation_id`, `account_login`, `account_type`, `act_as` (`bot`, `owner`), `secrets`, `repositories` (jsonb: `fullName`, `push`, `admin`), `repositories_synced_at`, `status` (`pending`, `connected`, `needs_reinstall`, `revoked`, `error`), `last_synced_at`, `error` | An organization's, with forced RLS and `organization_isolation`. One per owner per installation (partial unique index). `secrets` is sealed like `connectors.secrets`. `openbots_system` may read five columns, for the webhook's lookup |
| `instance_settings` | `key`, `value` (sealed JSON) | The install's, no organization's, like `instance_keys`. `github_app` is the self-hoster's App |
| `github_state_nonces` | `nonce`, `expires_at` | The install's. Spent flow states, kept until their state would have expired |
| `repos` (existing) | adds `last_remote_push_at`, `found_path`; `connection_id` now references `git_connections` (`on delete set null`) | `keep_cloned` and `pinned` are now set from the page. Forgetting a connection keeps its repositories |

**Routes.** Under `/api/v1`, all owner-scoped; another owner's connection or repository is 404. The route table is at the top of `routes/git-connections.ts`.

| Route | Purpose |
| --- | --- |
| `GET /git-connections`, `POST /git-connections/token`, `DELETE /git-connections/{id}` | The owner's connections; connect with a pasted token; forget one (its repositories stay) |
| `GET /git-connections/github-app`, `DELETE /git-connections/github-app` | Which App the install has and whether the manifest flow is available (`publicUrlOk`); forget a stored App (admins only, 409 for one from config) |
| `POST /git-connections/github-app/manifest`, `GET .../manifest/callback` | The manifest flow (admins only, self-hosted only) |
| `GET /git-connections/github-app/install`, `GET /git-connections/github-app/callback` | To the install page with a signed state; GitHub's return, which binds the installation (or, with a `reauth` state, reads the reach again) and redirects to `/connectors?connection=<id>` |
| `GET /git-connections/{id}/reauthorize`, `POST /git-connections/{id}/sync` | Authorize again on GitHub; list again and refresh the status |
| `GET /git-connections/{id}/repositories?q=`, `PATCH /git-connections/{id}` | The picker's list; `actAs` (App connections only; `owner` is 409 `ACT_AS_NEEDS_SIGN_IN` without a GitHub sign-in) |
| `POST /repos/remember`, `GET /repos/found`, `POST /repos/found/remember`, `POST /repos/scan` | Remember picked repositories and clone each; the found clones; remember one where it is; queue a scan (409 without a computer) |
| `PATCH /repos/{id}`, `DELETE /repos/{id}?deleteFiles` | `keepCloned` and `pinned`; forget, removing the clone only when asked |
| `POST /repos/rescue`, `GET /repos/rescue/{requestId}` | Queue a rescue; its progress and results, for its owner only |
| `GET /routines/templates` | The coding Routine templates |
| `POST /api/v1/github/app/webhook` | The App's webhook: unauthenticated, HMAC checked |

The web side: the GitHub card on the Connectors page (`apps/web/src/features/tools/github-card.tsx`), the picker (`apps/web/src/features/repos/picker.tsx`), and the Repositories section with found clones, rescue and disk use (`apps/web/src/features/repos/repositories.tsx`).

**Still later.** A screen for the `oauth` connection kind; a periodic rescue; other git hosts (only `github.com` gets a credential). Reset computer, which runs rescue first, is 22.14.

### 22.13 Phase 3: Codex, pi and polish

Phase 3 registers the Codex and pi adapters beside Claude Code (`services/coder-adapters/index.ts`) and adds API keys per agent, a model per agent, the safety-net commit, View diff and coding usage. Every flag and event below was checked against the pinned CLIs (`@openai/codex` 0.166.0, `@earendil-works/pi-coding-agent` 1.5.0); the commands and what each printed are in [CODING_AGENT_VENDORS.md](CODING_AGENT_VENDORS.md), and the recorded streams in `apps/server/src/services/__fixtures__/coders/`.

**Codex (`coder-adapters/codex.ts`).** A session runs `codex app-server --listen stdio://`, JSON-RPC over stdio with one object per line, and the adapter speaks the protocol itself (`transport: 'jsonrpc'`, so the runner keeps stdin open): `initialize`, `initialized`, then `thread/start` with the worktree as `cwd` (or `thread/resume` with the vendor session id, and a new thread, said in the feed, when that one is gone), then `turn/start` with the preamble and the prompt. The preamble also says the sandbox has no network, so installs fail and the agent should say so. The posture is set as `-c` overrides, the highest config layer, and again in the thread and turn parameters: `approval_policy="on-request"`, `approvals_reviewer="user"` (approvals come to OpenBots, never Codex's own reviewer), `sandbox_mode="workspace-write"` (`"read-only"` to plan), `sandbox_workspace_write.network_access=false`, `sandbox_workspace_write.writable_roots=["<repo>/.git"]` (a worktree's git dir and objects live under `<repo>/.git`, outside the workspace, so a commit needs it writable; a plan session gets none) and the model provider. A model override goes in the thread parameters. `on-request` means Codex runs commands and edits inside its sandbox without asking and asks before it steps outside it: a command it wants run unsandboxed or with the network, a write outside the writable roots. Each `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` becomes an OpenBots approval like any agent's prompt: `classify` reads a command through Codex's `bash -lc` wrapper (`unwrapShell`) with the shared classifier and a file change by its strictest path, `coderActionDecision` decides, and the adapter answers `accept` or `decline`. Codex asks less than Claude Code and pi do, since 0.166.0 refuses `untrusted` (ask for all but known safe reads) in config ("no longer supported"). Any other server request (user input, MCP elicitation, permissions, tool calls) gets a JSON-RPC error, so Codex does not wait on it. app-server has no `--ignore-user-config`, so `$CODEX_HOME/config.toml`, which the coder user can write, is read: the overrides beat a hostile one on the policy, the reviewer, the sandbox, its network and roots and the provider (checked against such a file, CODING_AGENT_VENDORS.md), while what they do not cover, such as MCP servers and `notify`, still loads from it. An `api_key` session names its own provider, `model_providers.openbots` reading `OPENAI_API_KEY` from the environment (with `base_url` when the account has one), since app-server's built-in provider ignores the key variables; a plan sign-in uses `model_provider="openai"` and the sign-in in `$CODEX_HOME`. The feed starts with `CODEX_POSTURE` ("Codex works inside its own sandbox with no network and asks before it steps outside it; OpenBots still gates pushes."). The parser reads `item/started` and `item/completed` (messages, reasoning summaries shown as "Thinking: ...", commands, file changes, MCP and web search calls), `thread/tokenUsage/updated` (tokens, this process's only, since a resumed thread's total counts its earlier turns; Codex reports no cost) and `turn/completed`, whose status says how the turn ended; `willRetry` errors are not failures. After `turn/completed` the session emits its result and the runner closes stdin, on which app-server exits 0. Sign-in is `codex login --device-auth`: the login driver reads the fixed link and the code (`1PVB-90DS9`, four and five capitals or digits) and nothing is pasted back. The terminal's resume preset is `codex resume <id>`.

**pi (`coder-adapters/pi.ts`).** A session runs `pi -p --mode json --session-id <id> --no-extensions -e <CODER_PI_EXTENSION> --no-mcp --no-approve --tools read,bash,edit,write,grep,find,ls` (`read,grep,find,ls` to plan), the model flags, then the prompt after `--`. `--session-id` opens the worktree's session with that id or creates it, so the first run and a continued one pass the same flag; the id is the OpenBots session id, and the terminal's preset is `pi --session <id>`. A model override goes in as `--model`; for an `api_key` account also `--provider <id>` with the model in pi's `provider/model` form (`google/gemini-2.5-pro`). pi refuses `--provider` without `--model`, so with no override neither is passed and pi picks the one provider key it has. The environment adds `OPENBOTS_CODER_MODE` and `PI_SKIP_VERSION_CHECK=1`. pi exits 0 when the provider refused it, so the parser reads the outcome from the last assistant message's `stopReason` (`stop` is success), never the exit code, and takes tokens and `cost.total` from each assistant message. pi has no sandbox and no approval mode. Its one gate is the OpenBots extension (`apps/computer-agent/src/coder-pi-extension.ts`, at `/app/apps/computer-agent/dist/coder-pi-extension.js` in the image): its `tool_call` hook runs before every tool call, blocks every tool but the read ones in plan mode without asking, and otherwise asks the owner over the session's socket. `--no-extensions` with one `-e` loads only it, `--no-mcp` and `--tools` keep the tools to pi's own, and `--no-approve` ignores the repository's `.pi/` settings. `classify` maps pi's tools onto Claude Code's (`bash` as Bash, `edit` and `write` as Edit and Write with their path). JSON mode has no UI channel, so an approval goes through the extension, not `--mode rpc`.

**One approval socket.** The pi extension speaks the same protocol as the Claude Code permission MCP server (22.4): one JSON line `{request_id, tool_name, input}` to `$OPENBOTS_CODER_SOCKET`, one line `{decision, message?}` back, through the same `askOwner` with the same 24 hour limit. A deny blocks the call with the owner's message as the reason the model reads. No socket, no answer, a malformed answer or a throw all block. The runner cannot tell the two apart and needs no pi path.

**Provider keys.** An `api_key` account's key reaches the CLI in the session's environment, in the vendor's names (`coderProviderEnv`, `services/coder-provider-env.ts`): Claude Code `ANTHROPIC_API_KEY` (and `ANTHROPIC_BASE_URL` for a compatible endpoint), Codex `OPENAI_API_KEY` and `CODEX_API_KEY` (and `OPENAI_BASE_URL`; the session's own provider reads `OPENAI_API_KEY` and takes the base URL as its `base_url`), pi one variable per provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`) and no base URL, since pi reads a custom endpoint only from its own `models.json`. Which providers fit each agent is `CODER_PROVIDER_KINDS` (`packages/shared/src/coders.ts`), used by the Settings picker, `PUT /coders/{agent}/api-key` and the launch alike; a provider that does not fit is refused with the reason (400 `CODER_PROVIDER_UNSUPPORTED`). The provider must still be the owner's or the instance's when the session starts. A plan sign-in gets no key variable. The key is masked as `[key]` in everything the session keeps or shows: each stdout line before it is logged or parsed (so no feed line, result or error made from it can carry it), and stderr only once its line is whole, so a key split across chunks is still caught.

**A refused key.** When an `api_key` account's session fails with a 401, "unauthorized" or the adapter's not signed in text in the CLI's own words (the result's error, error events and stderr, never the model's summary), the session fails with "The <provider> API key for <agent> was rejected. Check it under Settings > Models.", the account's `last_error` says so and its `auth_kind` stays `api_key`: no sign-in widget is posted and nothing switches it to a plan. `lastErrorKind` tells the card whether `last_error` is a lapsed sign-in (`sign_in`), a refused key (`key`) or something else, so it words each plainly. A Codex plan sign-in that OpenAI refuses reads "Codex could not sign in to OpenAI. Sign in again under Settings > Coding agents." (`signInErrorForOwner`); the raw text stays in the session log.

**Check and the terminal sign-in.** pi has no headless login (`/login` runs in its own terminal UI), so its adapter's sign-in is `{kind: 'terminal'}` with its instructions and the preset `pi`, and `terminalLogin` turns that into `CoderLoginInTerminalError` with a terminal (`cwd`, user `coder`, preset `pi`). From Settings, `POST /coders/pi/login` answers 409 `CODER_LOGIN_IN_TERMINAL` with that terminal, and the card opens the Computer page's terminal there. For a Bot, the sign-in is recorded and its `coder_login` widget carries the instructions instead of a link. `POST /coders/{agent}/check` (`checkCoderSignIn`, `services/coder-accounts.ts`) runs the CLI's own status check as the coder user with the agent's config directory: `claude auth status` (22.5), `codex login status` (`Logged in using ChatGPT` is `subscription`, any other `Logged in` line `api_key` with no provider) or `pi auth check --provider <id> --json` for each provider in `PI_CHECK_PROVIDERS`, six at a time (an OAuth sign-in is `subscription`, named by its plan; otherwise ready keys are `api_key`, named by their providers). The status line is never kept, since it can hold a masked key. A sign-in found is written with the CLI version and audited as `coder.sign_in`, and for pi `completeTerminalLogins` ends every open sign-in for it as `signed_in`, so the runs waiting on them resume. Not signed in, the card is left as it was.

**Billing.** No stream says whether a plan or API credits paid. The parser takes it from the account's `auth_kind` (`accountBilling`): `subscription` bills the plan, `api_key` the API. The widgets word a plan session by agent ("On your Claude plan", "On your ChatGPT plan", "On your plan").

**The safety-net commit.** After every `edit` or `pr` session, whatever the agent, `commitLeftovers` (`services/session-git.ts`) commits what the agent itself changed and left uncommitted, after `assertRunnable` and before the branch is read, so the branch, the diff and a PR carry it. It stages only the paths the session's own `file_change` events named (inside the worktree, `worktreeRelative`) that `git status --porcelain -z --untracked-files=all` still reports, with `git add -A -- :(literal)<path>...`, and leaves out any whose name reads like a secret (`looksSecret`: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, and names holding `credentials`, `.secret` or `token`). Then one `commit --no-verify` as the Bot with the owner's trailer, "<agent>: changes from an OpenBots session". Everything else git reports, such as a build's or a test's output, stays uncommitted, and the feed and the summary list it ("Left uncommitted: ...", saying which may hold secrets). Plan sessions and clean trees get nothing; a failure is logged and the changes stay in the worktree.

**View diff (CA5).** A settle with commits saves `git diff origin/<base>...HEAD` (at most 1 MB, then a marker line) as a code Artifact titled "Diff: <branch>", the owner's, by the session's run or the owner, in the session's chat. One per session: a continued session's settle writes a new version of the Artifact its last settle made (`writeArtifact`), and makes a new one only when that is gone. The id goes on the row (`diff_artifact_id`) and in the result, where the web widget's View diff and the phone's link open it. A settle with no commits carries none. Discard leaves the Artifact.

**Usage (5.8).** `GET /bots/{id}/usage` adds `coding` beside the runs' sums (`services/usage.ts`): the Bot's sessions created in the window, their input and output tokens from `coding_sessions.usage`, the cost API billed sessions reported (null when none did; plan sessions are left out) and how many sessions were on a plan. Bot Settings shows it as "Coding agents" (`apps/web/src/features/bots/bot-usage.tsx`).

**A model per agent (CA9).** `tool_policy.coder.models` maps an agent to a model name as its CLI names it (`CoderModelNameSchema`, `packages/shared/src/policy.ts`): it starts with a letter or digit and holds only letters, digits and `._:/@+-`, so it cannot read as a flag. The stored `coder` section is read key by key (`readCoderPolicy`), so a model that does not parse is dropped and the rest are kept. `code_task` resolves the model (the call's, the Bot's, then the owner's default from `PUT /coders/defaults`, else it asks with `coder_choice`) and stores it on `coding_sessions.model`; the runner passes the session's model, or the Bot's for sessions from before it was kept, as the adapter's `model`; the web editor shows the problem inline and saves nothing while a name is bad.

**Still later.** Codex asking for every command, should a later Codex accept a stricter policy than `on-request`; pi on `--mode rpc` with confirm round trips; pausing the Bot's session while the owner has the terminal, and Hand back (CA7); per-session uids, so concurrent sessions cannot read each other's environment (S-24); a coder-only agent for a laptop (CA13); other agents (CA14); other git hosts; the Phase 2 items still open (22.12).

### 22.14 Reset computer, rescue first (GH5)

Reset computer on the Computer page gives the owner a computer with an empty home, and saves unpushed work before anything is lost. It is three calls under `/api/v1` (`routes/computer.ts`, `services/computer-reset.ts`), Docker only: with the remote provider each answers 409 `RESET_UNSUPPORTED`, since that machine is not the server's to remove.

| Route | Purpose |
| --- | --- |
| `POST /computer/reset/prepare` | Queues the rescue job (22.12) over every checkout of the owner's computer, starting it if it is off, and remembers the coding sessions then live. Answers a `requestId` |
| `GET /computer/reset/{requestId}` | The rescue's progress (`running`, `done`), its results, what it could not push (`unsaved`), its error, the live sessions a reset would stop (`runningSessions`) and when the prepare expires. 404 for another owner's prepare or one older than 15 minutes |
| `POST /computer/reset` | `{requestId, resetSignIns?}`. Refused with 409 `RESET_NOT_PREPARED` without a prepare of this owner and computer, once it is older than 15 minutes (`RESET_PREPARE_TTL_MS`), or while its rescue runs; with 409 `CODING_SESSION_RUNNING` while a session runs that the owner was not shown. A prepare is used once |

A prepare and the rescue's results reach every process over the bus, so the process that takes the reset need not be the one that took the prepare. A rescue that failed outright does not block the reset: the status said so, and a computer that will not start is when a reset helps. The reset itself (`destroyComputer`, `services/computer.ts`) stops the computer if it is up, which ends its stdio connectors and coding sessions (`stop_all` on the coder control channel when there is nothing to stop), removes the container and its home volume through the provider, and the state volume only with `resetSignIns`, since that volume holds the cookie store and the coding agents' sign-ins. The row stays, `stopped`, with no machine. Then, in one transaction, every checkout on the computer becomes `missing`, every session of the owner forgets its worktree path, with `resetSignIns` every coding agent account signed in on the computer (one with no Settings > Models provider) goes back to `none`, and the audit log gets `computer.reset` with the counts and whether anything was left unsaved. The next start makes a fresh computer with the same volume name, and its reconcile (22.12) clones every `keep_cloned` repository again, most recently used first.

The docker guard lets the server remove only computer volumes: `DELETE /volumes/{name}` passes for `openbots-home-*` and `openbots-state-*` alone, with any `force` dropped, so a volume a container still uses stays (`packages/computer/src/docker-guard.ts`). The web dialog is `apps/web/src/features/computer/reset-dialog.tsx`: it prepares as it opens, polls every 2 seconds, shows what was pushed to rescue branches, what could not be saved and the running sessions, offers "Also forget the coding agent sign-ins" (which also removes the browser logins, since both are on the state volume), and only then Reset.
