# Coder adapter fixtures

Captured on 2026-11-05 against the versions pinned in `docker/coders/package.json`:
`@openai/codex` 0.166.0 (`codex-cli 0.166.0`, darwin arm64 binary) and
`@earendil-works/pi-coding-agent` 1.5.0. Every run used empty `HOME`, `CODEX_HOME` and
`PI_CODING_AGENT_DIR` directories and no provider keys. See
`../../coder-adapters/VENDOR-FACTS.md` for the commands and what each one showed.

| File                      | Source                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex-needs-login.jsonl` | Verbatim stdout of `codex exec --json --skip-git-repo-check "say hi"` with no auth (exit 1).                                                                                                                                |
| `codex-login.txt`         | Verbatim output of `codex login --device-auth`, killed after 5 s (ANSI colors kept). The code is dead.                                                                                                                      |
| `codex-success.jsonl`     | Built by hand from the observed envelope and the item shapes in the 0.166.0 binary. Not a capture.                                                                                                                          |
| `pi-needs-login.jsonl`    | Verbatim stdout of `pi -p --mode json --offline "say hi"` with no credentials (exit 1). The reason goes to stderr only: `No API key found for the selected model.` and a `/login` hint. cwd rewritten.                      |
| `pi-invalid-key.jsonl`    | Verbatim stdout of the same run with `ANTHROPIC_API_KEY=sk-ant-fake-key --model anthropic/claude-sonnet-4-5 --no-session`: a 401 in `errorMessage` with `stopReason: "error"`, and exit 0. cwd and install paths rewritten. |
| `pi-success.jsonl`        | Built by hand from the observed envelope and `docs/json.md`, `docs/message-types.md`. Not a capture.                                                                                                                        |

There is no `pi-login.txt`: pi has no headless login command (only `/login` in its TUI), so
nothing could be captured without a terminal.

The `claude-*` files predate these and come from Claude Code.
