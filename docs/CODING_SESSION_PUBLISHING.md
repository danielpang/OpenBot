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

`apps/server/src/services/coder-publish.ts` implements publishing for both the live tool and completion-time reconciliation in edit and PR sessions:

- Validate trusted checkout configuration and require a clean worktree and commits.
- Capture the commit SHA before requesting approval.
- Revalidate the checkout and check cancellation after approval.
- Push that exact SHA to the session's branch, without force or `-u`.
- Record the pushed SHA and PR URL in the existing session row.
- Return an existing result only after GitHub confirms an open matching head/base PR whose head SHA equals this commit. A saved URL and pushed SHA alone are not proof.
- Push follow-up commits to the existing session PR without creating another PR.
- On GitHub's duplicate-PR response, look up the matching open head/base PR to recover a create that succeeded before its URL was persisted.

The runner reconciles final HEAD even if the agent never called the tool, or made more changes after publishing. This includes the safety-net commit of eligible leftover edits. A different SHA requires authorization again; an explicit approval can be reused during the same turn only for the identical SHA and PR metadata, after checking current policy. Auto permission is not cached as an explicit approval.

Explicit denials and cancellations suppress further automatic publication for that turn. Other failures permit one completion-time attempt, not an unbounded retry loop. If that attempt still fails, the final summary and session error retain the publication failure independently of successful coding completion. A historical PR URL is not presented as this turn's publication result.

Stop and the session time limit abort publication, expire or deny pending waiters, and cancel in-flight runner Git and GitHub requests. Cancellation cannot undo a push or a GitHub create that already reached the remote. A later turn checks GitHub and can recover such a PR without creating a duplicate.

## Git configuration ownership

Publishing no longer asks the coder process to run `git push -u`. That command can atomically replace `.git/config` as the coder user when it saves upstream settings. The runner pushes an explicit SHA/ref instead, without changing upstream configuration.

The existing ownership/configuration checks remain enforced. This is not an operating-system sandbox redesign: arbitrary Git configuration changes by a coding process can still cause the checkout to be refused. Agent instructions explicitly prohibit those changes. An already coder-owned or unsafe `.git/config` is **not** automatically trusted or repaired; review its contents and restore a trusted checkout before resuming.

## Rollout

Deploy the updated server and rebuild the computer image together: the image contains the stdio MCP server and pi extension. New or resumed coding processes receive the updated tool configuration and instructions. Already running processes retain their original configuration.
