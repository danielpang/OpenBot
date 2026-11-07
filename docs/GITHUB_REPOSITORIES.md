# GitHub repositories for coding agents

Use **Connectors → GitHub → Repositories for coding agents → Connect GitHub**.
The GitHub MCP connector is separate: connecting it does not connect coding-agent git access.
Neither flow changes OpenBots account sign-in.

## Mac and self-hosted setup

The default public App is [openbots-github](https://github.com/apps/openbots-github), client ID
`Iv23liyL74CRKUWIUXhq`. No public HTTPS URL, OAuth callback, App private key or client secret
is required on a Mac or localhost.

1. Connect GitHub and install the App on your personal account or organization.
2. Choose selected repositories. An organization may require its administrator's approval.
3. Return to OpenBots and open **Authorize on GitHub**. Enter the short-lived code shown there.
   Check the App and account before approving. Never authorize an unexpected device code.
4. Keep OpenBots open. It waits for both user authorization and an active installation.
5. Select repositories in the picker and choose **Keep on the computer**. The existing checkout
   runner clones them when your computer is running. Start coding from that remembered repository.
6. Approve a branch push and PR through the coding session's existing approval controls.

**Manage repositories** reopens the connection's own App installation page. **Sync** refreshes
the user/installation intersection, including newly granted repositories and removed access.
**Reconnect GitHub** renews expired/revoked authorization without discarding working credentials
unless replacement succeeds. Reconnect must use the same immutable GitHub user ID; add another
connection for a different account. **Disconnect** deletes the server's encrypted credentials;
revoke the grant under GitHub Settings → Applications to revoke it on GitHub too. Cancel stops
that page's polling; unused device codes expire on GitHub.

## Your own App

**Use a different GitHub App** accepts only its public client ID and slug. Enable **Device Flow**
in the App's settings. See [App registration and permissions](GITHUB_CONNECTOR.md#create-a-public-github-app).
Alternatively, set both `OPENBOTS_GITHUB_CLIENT_ID` and `OPENBOTS_GITHUB_APP_SLUG` on the server
to change defaults for both coding repositories and the MCP connector. Existing connections keep
their own identifiers, including for refresh. No shared signing key or secret is distributed.

Existing server-managed Apps from `GITHUB_APP_*` or the self-hosted admin manifest remain
available under **Advanced: server-managed GitHub App**. This distinct mode needs HTTPS for
callbacks/webhooks and sealed server secrets. It supports narrowed installation tokens, App/bot
PR identity, and automatic App-webhook delivery. Device connections have no installation-token
signing key and do not attach to that centralized webhook flow. Configure a reachable repository
webhook for event Routines instead; scheduled work does not need a webhook.

## Credential and approval boundaries

- GitHub App **user tokens** (`ghu_`) are not installation tokens (`ghs_`). They intersect the
  App installation's selected repositories and the authorizing user's access, but GitHub cannot
  narrow them per credential request to one repository or read-only.
- OpenBots lists `/user/installations` and `/user/installations/{id}/repositories` with the user
  token, filtering by the requested App slug and non-suspended installations. It never substitutes
  an App-wide list or `/user/repos`. Repository selection also checks the owned connection and
  its permission snapshot. Installation write permission and user push permission are both needed.
- Tokens and device codes are sealed in `git_connections.secrets`, covered by existing master-key
  rotation and workspace RLS. The API exposes only public codes, links and connection metadata.
  All GitHub calls use fixed HTTPS origins, outbound guards, no redirects and timeouts.
- Polls, reconnects and rotating refresh tokens are database-serialized across API/worker
  processes. Device-issued tokens refresh without a client secret. Errors never echo provider
  bodies or tokens. Expired/rejected refresh credentials require reconnecting.
- Runner clone/fetch still runs as the isolated `runner` user with locked-down Git configuration.
  A coding sandbox gets **no user token for fetch or before push approval**. The credential helper
  serves one only for the approved session's push username and exact repository path.
- After an approved push exposes the token, it may be used for any repository that grant reaches.
  This is a real residual risk, not a per-repository token guarantee. Limit the App's repository
  selection; choose a server-managed App if you need GitHub-enforced per-repository read tokens.
  PRs use the authorizing user's identity. Existing push and PR approvals are unchanged.

## Verification

Automated coverage in `apps/server/src/routes/git-device.test.ts` and
`apps/web/src/features/repos/repos.test.tsx` exercises the real coding-connection routes, picker,
remembered repository binding, runner and sandbox credential paths, refresh, organization/owner
isolation, installation waiting, denial, expiry, and custom App identifiers against a **fake
GitHub API**. Existing checkout/runner tests cover clone/fetch and approved push/PR orchestration.

A release still needs this **real GitHub check** (not implied by those tests):
connect a selected private test repository on a Mac/localhost, authorize the code, select and
clone it, run a coding task, verify an unapproved push is denied, approve a branch push and PR,
and verify both on GitHub. Remove repository access and verify sync/operations fail closed;
reconnect, then disconnect. Check an organization requiring approval and a custom App if used.
Only server-managed App installation/callback verification needs a public HTTPS endpoint.
