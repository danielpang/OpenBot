# Coder adapter fixtures

Captured on 2026-11-05 against the versions pinned in `docker/coders/package.json`:
`@openai/codex` 0.166.0 (`codex-cli 0.166.0`, darwin arm64 binary) and
`@earendil-works/pi-coding-agent` 1.5.0. Every run used empty `HOME`, `CODEX_HOME` and
`PI_CODING_AGENT_DIR` directories and no provider keys. See
[docs/CODING_AGENT_VENDORS.md](../../../../../../docs/CODING_AGENT_VENDORS.md) for the commands and what each one showed.

| File                      | Source                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex-needs-login.jsonl` | Stdout of `codex app-server` with no auth, driven by the adapter's own session (`initialize`, `initialized`, `thread/start`, `turn/start`): ten retries, the 401, then `turn/completed` with `status: "failed"`; exit 0 on stdin EOF. Paths, the installation id and the terminal in `userAgent` rewritten; otherwise verbatim. Its first line is the real `initialize` answer. |
| `codex-login.txt`         | Verbatim output of `codex login --device-auth`, killed after 5 s (ANSI colors kept). The code is dead.                                                                                                                                                                                                                                                                          |
| `codex-success.jsonl`     | Built by hand from the `app-server` protocol schema the 0.166.0 binary generates (`codex app-server generate-ts`) and the envelope of the capture above: answers to ids 1 to 3, item notifications, token usage, `turn/completed`. Not a capture.                                                                                                                               |
| `codex-approval.jsonl`    | Built by hand from the same schema: a command item, its `item/commandExecution/requestApproval` server request (id 0), then the rest of the turn as after an `accept`. Not a capture.                                                                                                                                                                                           |
| `pi-needs-login.jsonl`    | Verbatim stdout of `pi -p --mode json --offline "say hi"` with no credentials (exit 1). The reason goes to stderr only: `No API key found for the selected model.` and a `/login` hint. cwd rewritten.                                                                                                                                                                          |
| `pi-invalid-key.jsonl`    | Verbatim stdout of the same run with `ANTHROPIC_API_KEY=sk-ant-fake-key --model anthropic/claude-sonnet-4-5 --no-session`: a 401 in `errorMessage` with `stopReason: "error"`, and exit 0. cwd and install paths rewritten.                                                                                                                                                     |
| `pi-success.jsonl`        | Built by hand from the observed envelope and `docs/json.md`, `docs/message-types.md`. Not a capture.                                                                                                                                                                                                                                                                            |

There is no `pi-login.txt`: pi has no headless login command (only `/login` in its TUI), so
nothing could be captured without a terminal.

The Claude Code sign-in files come from `@anthropic-ai/claude-code` 2.1.318 with empty
`HOME` and `CLAUDE_CONFIG_DIR`, never completing a sign-in:

| File                    | Source                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-login.txt`      | Verbatim PTY output of `BROWSER=/bin/true claude auth login --claudeai` up to its prompt: the OSC 8 link, then `Paste code here if prompted > `. The link's state is dead. |
| `claude-login-done.txt` | Built by hand from the verified success line, `Login successful.`, which the CLI prints before it exits 0. Not a capture.                                                  |

The other `claude-*` files predate these and are hand made from the documented stream-json format.
