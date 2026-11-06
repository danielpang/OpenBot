# Vendor facts: Codex CLI and pi

Reference for the Phase 3 adapters (`apps/server/src/services/coder-adapters/codex.ts` and `pi.ts`, plan 22.13). Checked on 2026-11-05 against the pinned versions in
`docker/coders/package.json`: `@openai/codex` 0.166.0 and `@earendil-works/pi-coding-agent` 1.5.0,
installed with `npm i --ignore-scripts` (the Codex launcher found `@openai/codex-darwin-arm64`
without install scripts). Every command ran with `HOME`, `CODEX_HOME` and `PI_CODING_AGENT_DIR` set
to empty scratch directories and no provider keys in the environment.

Tags: **VERIFIED** means the command was run here and the output is quoted. **DOCUMENTED** means it
comes from the installed package (its docs, its generated protocol schema or the strings in its
binary) but was not exercised. **UNVERIFIED** means neither: it needs a signed in account.

Fixtures built from these runs are in `apps/server/src/services/__fixtures__/coders/` (see its README).

## Codex CLI 0.166.0

`codex --version` prints `codex-cli 0.166.0`. VERIFIED

### Flags for `codex exec` (VERIFIED, from `codex exec --help`)

```
Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]
Commands:
  resume  Resume a previous session by id or pick the most recent with --last
  -m, --model <MODEL>             Model the agent should use
  -s, --sandbox <SANDBOX_MODE>    [possible values: read-only, workspace-write, danger-full-access]
  -C, --cd <DIR>                  Tell the agent to use the specified directory as its working root
      --add-dir <DIR>             Additional directories that should be writable alongside the primary workspace
      --skip-git-repo-check       Allow running Codex outside a Git repository
      --ephemeral                 Run without persisting session files to disk
      --ignore-user-config        Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`
      --output-schema <FILE>      Path to a JSON Schema file describing the model's final response shape
      --json                      Print events to stdout as JSONL
  -o, --output-last-message <FILE>
  -c, --config <key=value>        Override a configuration value ... parsed as TOML
      --approve-for-me            Route approval requests through automatic review using the workspace-write sandbox
      --dangerously-bypass-approvals-and-sandbox
```

- **Approval policy is not an `exec` flag.** `codex exec -a never --json "x"` fails with
  `error: unexpected argument '-a' found`. VERIFIED. `-a, --ask-for-approval` exists only on the
  top level (`codex --help`: `on-request` and `never`; the protocol type also has `untrusted` and
  `granular`). `codex -a never exec --json "x"` parses and starts a thread, and so does
  `codex exec -c approval_policy='"never"' -s read-only --json "x"`. VERIFIED (both reached
  `thread.started`). Use `-c approval_policy="never"` and `-c sandbox_mode="..."`: `-c` is accepted
  by `exec` and `exec resume` alike.
- **`exec resume` takes neither `-s` nor `-C`.** Both answer `error: unexpected argument`. VERIFIED.
  Its flags are `-c`, `-m`, `--last`, `--all`, `--json`, `--output-schema`, `-o`,
  `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `-i`. So a resumed run sets the
  sandbox through `-c sandbox_mode=...` and its working directory through the process cwd.
- Resume: `codex exec resume [SESSION_ID] [PROMPT]` ("Conversation/session id (UUID) or thread
  name"). The id is `thread.started.thread_id`. The interactive resume for takeover is
  `codex resume` (top-level command, "use --last to continue the most recent"). VERIFIED (help).
- **Committing from a worktree.** The session's worktree is `<repo>/.worktrees/<slug>`; its git dir
  is `<repo>/.git/worktrees/<slug>` and its objects and refs are in `<repo>/.git`, outside the
  `workspace-write` root, so a commit inside the sandbox needs `<repo>/.git` writable. `exec`
  takes `--add-dir <DIR>` ("Additional directories that should be writable alongside the primary
  workspace"). VERIFIED (help). `exec resume` does not list `--add-dir` (VERIFIED: its flags are
  `-c`, `--last`, `--all`, `--enable`, `--disable`, `-i`, `--strict-config`, `-m`,
  `--dangerously-bypass-*`, `--worktree`, `--thread-source`, `--cyber-access-program`,
  `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`,
  `--output-schema`, `--json`, `-o`), so a resumed session passes
  `-c 'sandbox_workspace_write.writable_roots=["<repo>/.git"]'` (a TOML array). The key
  `sandbox_workspace_write.writable_roots` is in the binary's strings, as is `network_access`
  (VERIFIED, `grep -a`); that a commit then succeeds was not run (it needs a sign-in). A plan
  session (`read-only`) gets neither. The runner also commits whatever a session left
  uncommitted, so the branch holds the work even if the sandbox refused the commit.
- **Config hardening.** `--ignore-user-config` is an `exec` and `exec resume` flag (not top level):
  "Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`". VERIFIED (help). Every
  session passes it, so a `config.toml` on the state volume (which the `coder` user can write)
  cannot change the sandbox, the approval policy or the model provider; the sign-in in
  `$CODEX_HOME/auth.json` still applies. Every session also passes
  `-c sandbox_workspace_write.network_access=false`: off is the default, the flag says so
  explicitly. A `read-only` sandbox ignores the `sandbox_workspace_write` table.
- When stdin is not a TTY, exec prints `Reading additional input from stdin...` on stderr and
  appends stdin to the prompt (`If stdin is piped and a prompt is also provided, stdin is appended
as a <stdin> block`). The runner should give it `/dev/null` or close stdin. VERIFIED.

### `codex exec --json` event stream

Observed with no credentials (`codex-needs-login.jsonl`, exit code 1). VERIFIED:

```
{"type":"thread.started","thread_id":"01a1ad5f-b5bb-71d3-bc7a-2ea7665db158"}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, ...)"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: ..."}}
{"type":"error","message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, ..."}
{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: ..."}}
```

A missing login is a `turn.failed` whose message contains `401 Unauthorized`, after about ten
`error` lines of retries (roughly 15 seconds). The `error` lines with `Reconnecting...` are retries,
not the end. stderr carries tracing lines (`ERROR codex_api::endpoint::responses_websocket: ...`),
never protocol data.

The full set of event and item names, DOCUMENTED from the `ThreadEvent` serde strings in the 0.166.0
binary (shapes beyond the observed lines are UNVERIFIED):

- Events: `thread.started` {thread_id}, `turn.started`, `turn.completed` {usage}, `turn.failed`
  {error.message}, `item.started`, `item.updated`, `item.completed` {item}, `error` {message}
  (also `thread.failed` appears in the binary).
- Item types: `agent_message` {text}, `reasoning` {text}, `command_execution` {command,
  aggregated_output, exit_code, status: in_progress | completed | failed | declined},
  `file_change` {changes: [{path, kind: add | delete | update}], status}, `mcp_tool_call` {server,
  tool, arguments, result, error, status}, `collab_tool_call`, `web_search` {query, action},
  `todo_list` {items}, `error` {message}.
- Usage on `turn.completed`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`,
  `output_tokens`, `reasoning_output_tokens`. No cost and no billing field: billing comes from the
  login kind (below).

### Login

- `codex login --help` (VERIFIED) lists `status`, `--with-api-key` ("Read the API key from stdin"),
  `--with-access-token` and `--device-auth` (no help text, no "beta" label).
- `codex login --device-auth` (VERIFIED, killed after 5 s, `codex-login.txt`) prints, with ANSI
  colors:

  ```
  Follow these steps to sign in with ChatGPT using device code authorization:

  1. Open this link in your browser and sign in to your account
     https://auth.openai.com/codex/device

  2. Enter this one-time code (expires in 15 minutes)
     1PVB-90DS9

  Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.
  ```

  The URL is fixed; the code is 4 + 5 uppercase letters and digits joined by `-`. Parse after
  stripping ANSI. Nothing is read back from stdin; the process polls and exits when the owner
  finishes. What it prints on success, and whether the ChatGPT account must first allow device
  codes in its security settings, is UNVERIFIED.

- `codex login status` prints `Not logged in` and exits 1. VERIFIED. The literal signed in strings in the
  binary are `Logged in using ChatGPT`, `Logged in using access token`, `Logged in using personal
access token`, `Logged in using workload identity` and two Amazon Bedrock variants. DOCUMENTED.
  The API key line is formatted at run time (no literal found), so match `Logged in using ChatGPT`
  for `billed: 'subscription'` and treat any other `Logged in` line as `api`.
- Files: `$CODEX_HOME` (default `~/.codex`) holds `config.toml`, `auth.json`, `log/`, `tmp/`. With
  an empty `CODEX_HOME` a run created `auth.lock`, `log/` and `tmp/` there and nothing in `HOME`.
  VERIFIED. `auth.json` itself only appears after a login. DOCUMENTED.

### Approvals

- `exec` has no channel to ask anyone: with `approval_policy="never"` a command the sandbox blocks
  fails back to the model ("Execution failures are immediately returned to the model", top-level
  help). VERIFIED (help text). So `exec` gives sandbox enforcement only, never an OpenBots approval.
- `codex app-server` exists (`[experimental]`, `--listen stdio://` default). VERIFIED (help). It is
  JSON-RPC; `codex app-server generate-ts --out DIR` and `generate-json-schema --out DIR` write the
  protocol for this exact version. VERIFIED (ran; 97 TS files). From those types, DOCUMENTED:
  - Client requests include `initialize`, `thread/start`, `thread/resume`, `turn/start`,
    `turn/interrupt`, `account/login/start` (`{"type":"chatgptDeviceCode"}` among the variants),
    `account/read`.
  - Server requests that need an answer: `item/commandExecution/requestApproval` (params:
    threadId, turnId, itemId, command, cwd, reason, commandActions, approvalId),
    `item/fileChange/requestApproval` (threadId, turnId, itemId, reason, grantRoot),
    `item/permissions/requestApproval`, `item/tool/requestUserInput`,
    `mcpServer/elicitation/request`.
  - Decisions: command `accept | acceptForSession | decline | cancel` (plus execpolicy and network
    amendments); file change `accept | acceptForSession | decline | cancel`.
  - `AskForApproval` is `"untrusted" | "on-request" | {granular: ...} | "never"`.

## pi 1.5.0

`pi --version` prints `1.5.0`. VERIFIED

### Flags (VERIFIED, from `pi --help`)

```
  --provider <name>              Provider to search for --model (requires --model)
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --api-key <key>                API key (defaults to env vars)
  --mode <mode>                  Output mode: text (default), json, or rpc
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue the most recent session for the current directory
  --resume, -r                   Pick a session to resume
  --session <path|id>            Open a session by file path or full/partial ID
  --session-id <id>              Use the current directory's existing session with the ID, creating it otherwise
  --session-dir <dir>            Directory for session storage and lookup
  --no-session                   Don't save session (ephemeral)
  --tools, -t <tools>            Comma-separated allowlist of tool names or patterns (*) to enable
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max
  --extension, -e <path>         Load an extension file or builtin:<name> (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery and built-in extensions (explicit -e paths still work)
  --approve, -a / --no-approve, -na   Trust / ignore project-local files for this run
  --offline                      Disable startup network operations (same as PI_OFFLINE=1)
  --list-models [search]         List available models (with optional fuzzy search)
  --no-mcp                       Disable built-in MCP support: no servers connect and no MCP tools
```

- **Flags the launch uses**, each in `pi --help` of the pinned 1.5.0 (VERIFIED): `-p`, `--mode json`,
  `--session-id`, `--no-extensions`, `-e`, `--no-mcp` ("Disable built-in MCP support: no servers
  connect and no MCP tools"), `--no-approve`, `--tools`, `--provider`, `--model`. None was dropped.
- **`--provider` requires `--model`.** `pi --provider anthropic -p "hi"` exits with
  `Error: --provider requires --model (for example: --provider anthropic --model <pattern>)`.
  VERIFIED. So an `api_key` session passes `--provider <id> --model <id>/<model>` only when the Bot
  sets a model; without one it passes neither, and pi picks a model it has a credential for, which
  is the one provider key in the session's environment.
- **Provider ids.** `pi --list-models` with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`
  and `XAI_API_KEY` set lists the providers `anthropic`, `openai`, `google` and `xai`. VERIFIED. The
  OpenBots provider kinds map one to one (`PI_PROVIDERS` in `coder-adapters/pi.ts`). `--model` takes
  `provider/id` (help: `supports "provider/id"`); a bare override gets the prefix.
- **Billing.** pi's stream has `usage.cost` but not whether a plan or API credits paid; the parser
  takes the account's `auth_kind` (`piParser({ billing })`) for `usage.billed`.
- A refused key: `ANTHROPIC_API_KEY=sk-ant-bogus pi --provider anthropic --model
anthropic/claude-sonnet-4-5 -p --mode json "hi"` ends `stopReason: "error"` with
  `errorMessage: "401 {...authentication_error...invalid x-api-key...}"` and exit 0. VERIFIED. The
  runner reads a 401 on an `api_key` account as a rejected key, not a missing sign-in.
- There is no `--list-providers`. `pi --list-models` with no credentials prints `No models
available. Use /login to log into a provider via OAuth or API key.` VERIFIED.
- Resume for the adapter: `pi --session <id>` with the id from the session header (an id works, not
  only a file path). Takeover: `pi --continue` in the worktree. DOCUMENTED (help and
  `docs/sessions.md`).
- No sandbox and no approval mode of its own: the only gate is an extension (below) plus `--tools`.

### `pi -p --mode json` event stream

No credentials (`pi-needs-login.jsonl`, exit 1). VERIFIED: stdout holds only the session header,
the reason goes to stderr.

```
{"type":"session","version":3,"id":"01a1ad60-d993-71b8-9779-d00facbfad91","timestamp":"2026-11-05T20:22:47.956Z","cwd":"..."}
stderr: No API key found for the selected model.

Use /login to log into a provider via OAuth or API key. See: .../docs/providers.md
```

With `--model anthropic/claude-sonnet-4-5` the stderr line is `No API key found for anthropic.`
VERIFIED.

A rejected key (`pi-invalid-key.jsonl`) **exits 0**. VERIFIED. The failure is only in the stream:
`agent_start`, `turn_start`, `message_start`/`message_end` for the system and user messages, then an
assistant `message_end` with `"stopReason":"error"` and `"errorMessage":"401 {...authentication_error...}"`,
`turn_end`, `agent_end`, `agent_settled {"aborted":false}`. The adapter must read success from the
last assistant `stopReason` (`stop` is success; `error`, `aborted`, `length` are not), never from the
exit code.

Other events, DOCUMENTED in `docs/json.md`: `message_update` {usage, assistantMessageEvent:
text_start/delta/end, thinking_start/delta/end, toolcall_start/delta/end}, `tool_execution_start`
{toolCallId, toolName, args}, `tool_execution_update` {partialResult}, `tool_execution_end`
{result, isError, durationMs}, `auto_retry_start`/`auto_retry_end`, `compaction_start`/`compaction_end`,
`queue_update`. Usage on each assistant message: `input`, `output`, `cacheRead`, `cacheWrite`,
`totalTokens`, `cost.total` (USD). Tool calls are `{type:"toolCall", id, name, arguments}`; built in
tools are `read`, `bash`, `edit` {path, edits[{oldText,newText}]}, `write` {path, content}, `grep`,
`find`, `ls`. `edit` results carry `details.patch` (a unified diff). Framing is strict LF JSONL; the
docs warn that Node's `readline` splits on U+2028 and must not be used.

### RPC mode (DOCUMENTED, `docs/rpc.md`, `docs/rpc-commands.md`)

`pi --mode rpc` reads commands on stdin and writes responses and the same session events on stdout
(no session header). Commands carry an optional `id`; the response is
`{"id","type":"response","command","success","data"|"error"}`. `{"type":"prompt","message":"..."}`
answers `data.disposition: "started" | "queued" | "handled"`; wait for `agent_settled`. Other
commands: `abort`, `steer`, `follow_up`, `get_state` (session id and file), `set_model`,
`get_session_stats`, `switch_session`. Closing stdin shuts pi down.

### Approvals: the `tool_call` extension hook (DOCUMENTED, `docs/extensions.md`)

```ts
pi.on('tool_call', async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input (mutable)
  return { block: true, reason: 'Dangerous command', terminate: true };
});
```

- Fired after `tool_execution_start`, before the tool runs. Returning `{block: true, reason}` stops
  the call; a handler that throws also blocks ("fail-safe").
- Loading: `pi -e /path/ext.ts` (works even with `--no-extensions`), or auto-discovery from
  `$PI_CODING_AGENT_DIR/extensions/*.ts` or `*/index.ts`, or `settings.json` `"extensions": [...]`.
  Project `.pi/extensions` load only for a trusted project. Use `-e` plus `--no-extensions` so only
  the OpenBots extension runs.
- `ctx.ui.confirm(title, message)` in RPC mode becomes
  `{"type":"extension_ui_request","id","method":"confirm","title","message","timeout"?}` on stdout
  and waits for `{"type":"extension_ui_response","id","confirmed":true|false}` on stdin. In
  `-p`/json mode `ctx.hasUI` is false, so an approval needs RPC mode (or the extension talking to
  the runner itself).

### Login and config

- `pi auth` has only `print-api-key`, `print-bearer-token` and `check`. VERIFIED. There is no
  headless login command; `/login` runs in the TUI. `pi auth check --provider anthropic --json`
  prints `{"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}` and
  exits 1; an unknown provider gives `"reason":"provider_not_found"`. VERIFIED. This is the status
  probe for the Settings card.
- OAuth providers in pi-ai 1.5.0, DOCUMENTED from `pi-ai/dist/auth/oauth/*.js`: `anthropic`
  "Anthropic (Claude Pro/Max)" (methods: browser, or "Copy code login (headless)": "Paste the code
  Anthropic shows after you sign in:"), `openai-codex` "OpenAI (ChatGPT Plus/Pro)" (browser on
  `http://localhost:1455/auth/callback`, or "Device code login (headless)" against
  `https://auth.openai.com/codex/device`), OpenAI ChatGPT subscription, GitHub Copilot, Kimi Code,
  xAI, Meta, OpenRouter. All but OpenRouter are marked `isSubscription: true`.
  `pi auth check --provider openai-codex` answers `not_ready`, so that id exists. VERIFIED.
- Files under `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`): a first run created `auth.json`
  (`{}`), `models-store.json` and `sessions/<cwd as dashes>/`. VERIFIED. Also `settings.json`,
  `models.json`, `mcp.json`, `extensions/`, `skills/`. DOCUMENTED. `auth.json` holds one credential
  per provider id: `{"type":"api_key","key"}` or `{"type":"oauth","access","refresh","expires"}`.
  DOCUMENTED. `PI_CODING_AGENT_SESSION_DIR` or `--session-dir` moves the sessions.
- Billing: the assistant message carries `provider` (for example `openai-codex` or `anthropic`)
  and `cost.total`. Subscription versus API follows from the provider's credential type in
  `auth.json`, not from the stream. UNVERIFIED for a signed in plan (cost may be reported as zero).

## Against the design doc ("The three agents")

1. Codex headless row: right that approvals need `codex app-server`. But `codex exec` does not
   take `--ask-for-approval`; pass `-c approval_policy="never"` (and `-c sandbox_mode=...`, since
   `exec resume` has no `-s`). VERIFIED.
2. Codex resume row: `codex exec resume <id>` is right; note it also has no `-C`, so set the
   process cwd. The takeover command `codex resume` exists. VERIFIED.
3. Codex sign in: `codex login --device-auth` works without any flag or "beta" notice in 0.166.0
   and printed a link and code at once. Whether a ChatGPT account must enable device codes first is
   UNVERIFIED. The code is never typed back into Codex, so the widget needs no paste field for
   Codex.
4. pi resume row: `--session` takes an id as well as a file. VERIFIED (help).
5. pi headless row: `-p --mode json` exits 0 on a provider error, and exits 1 with only a stderr
   message when no credential exists. The adapter cannot trust the exit code. VERIFIED.
6. pi sign in: there is no `pi login` subcommand; `/login` is TUI only, so I4's plan to open it in
   the owner's terminal stands. Both subscription providers offer a headless method (Anthropic copy
   code, OpenAI device code), which the terminal flow can pick. DOCUMENTED.
7. Approval hook row for pi: right (`tool_call`), but a confirm round trip needs `--mode rpc`; in
   json mode the extension has no UI. DOCUMENTED.
8. Usage row ("in the stream"): true for tokens on both. Codex reports no cost and pi reports cost
   but neither says subscription or API; take that from the login. DOCUMENTED.

## Reasoning events

Codex emits `reasoning` items (short summaries) and pi emits `thinking` content blocks (raw model
thinking, possibly redacted). No `reasoning` CoderEvent was added: `describeEvent` in
`apps/server/src/services/coder-state.ts` switches over every event type, so a new member needs a server change.
Adapters map a Codex `reasoning` item to `text` and drop pi `thinking` blocks.
