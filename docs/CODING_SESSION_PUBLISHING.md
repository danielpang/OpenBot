# Coding-session publishing

Coding agents publish through OpenBots, not through `git push`, `gh pr create`, or vendor PR integrations.

## Agent contract

After completing an edit or PR task, the agent runs the relevant checks, commits its changes, and automatically calls `publish_pull_request` with:

```json
{
  "title": "Fix reconnect handling",
  "body": "Summary of changes and verification performed",
  "draft": false
}
```

Codex and Claude Code receive this as an OpenBots stdio MCP tool. The pi extension registers the same operation as a native tool. Plan-only sessions cannot publish. If the owner declines or publication fails, the agent reports that outcome rather than bypassing it with a different tool.

"Automatically" means the agent requests publication without needing a second prompt. It does **not** bypass approval. Both the push and PR policy must allow the operation; the stricter decision wins, including Bot/webhook trigger floors. An `ask` decision produces one approval for pushing and opening the PR.

## Transport and authority

The tool uses the existing per-process Unix socket and authenticated computer-agent control connection:

```
Agent tool -> session socket -> computer agent -> session runner
           -> policy/approval -> runner Git -> GitHub API -> PR URL
```

There is no public publishing HTTP endpoint and no new database migration. The caller may supply only title, body, and draft status. Repository, owner, workspace, worktree, branch, and base come from the running session; callers cannot override them. GitHub tokens stay in trusted runner operations, and the coding process's credential relay never receives push credentials.

## Runner behavior

`apps/server/src/services/coder-publish.ts` implements publishing for both the live tool and the existing end-of-session PR-mode fallback:

- Validate trusted checkout configuration and require a clean worktree and commits.
- Capture the commit SHA before requesting approval.
- Revalidate the checkout and check cancellation after approval.
- Push that exact SHA to the session's branch, without force or `-u`.
- Record the pushed SHA and PR URL in the existing session row.
- Return the existing result when the same SHA has already been published.
- Push follow-up commits to the existing session PR without creating another PR.
- On GitHub's duplicate-PR response, look up the matching open head/base PR to recover a create that succeeded before its URL was persisted.

A live tool attempt, including an owner denial, suppresses the exit-time fallback for that turn. This avoids a second approval after an explicit decision. PR-mode sessions retain their fallback if the agent never called the tool.

## Git configuration ownership

Publishing no longer asks the coder process to run `git push -u`. That command can atomically replace `.git/config` as the coder user when it saves upstream settings. The runner pushes an explicit SHA/ref instead, without changing upstream configuration.

The existing ownership/configuration checks remain enforced. This is not an operating-system sandbox redesign: arbitrary Git configuration changes by a coding process can still cause the checkout to be refused. Agent instructions explicitly prohibit those changes. An already coder-owned or unsafe `.git/config` is **not** automatically trusted or repaired; review its contents and restore a trusted checkout before resuming.

## Rollout

Deploy the updated server and rebuild the computer image together: the image contains the stdio MCP server and pi extension. New or resumed coding processes receive the updated tool configuration and instructions. Already running processes retain their original configuration.
