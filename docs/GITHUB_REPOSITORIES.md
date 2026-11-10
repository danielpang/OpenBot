# GitHub repositories for coding agents

Use **Connectors → GitHub for coding agents → Connect GitHub**, the only normal GitHub connection
entry in settings. The add-connector catalog omits the MCP and built-in alternatives. Existing
tool connections stay under **Existing GitHub tool connections** (collapsed unless directly
linked) with their settings and disconnect controls, so existing Bots keep working; see
[GITHUB_CONNECTOR.md](GITHUB_CONNECTOR.md). They do not populate coding-agent git access. No
credentials are silently deleted or converted, and OpenBots account sign-in is unchanged.

## Mac and self-hosted setup

The default public App is [openbots-github](https://github.com/apps/openbots-github), client ID
`Iv23liyL74CRKUWIUXhq`. A Mac or localhost needs no public HTTPS URL, OAuth callback, App private
key or client secret.

1. Connect GitHub and install the App on your personal account or organization.
2. Choose selected repositories. An organization may require its administrator's approval.
3. Back in OpenBots, open **Authorize on GitHub** and enter the short-lived code shown. Check the
   App and account before approving. Never authorize an unexpected device code.
4. Keep OpenBots open. It waits for both user authorization and an active installation.
5. In **Choose repositories**, check the repositories and press **Select N** (for example,
   **Select 6**). The existing checkout runner clones them when your computer is running. Start
   coding from that remembered repository.
6. Approve a branch push and PR through the coding session's existing approval controls.

Afterwards:

- **Manage repositories** reopens the connection's own App installation page.
- **Sync** refreshes the user/installation intersection, including newly granted repositories and
  removed access.
- **Reconnect GitHub** renews expired/revoked authorization, keeping working credentials unless
  replacement succeeds. It must use the same immutable GitHub user ID; add another connection for
  a different account.
- **Disconnect** deletes the server's encrypted credentials. Revoke the grant under GitHub
  Settings → Applications to remove it on GitHub too.
- Cancel stops that page's polling. Unused device codes expire on GitHub.

## Your own App

**Use a different GitHub App** accepts only its public client ID and slug. Enable **Device Flow**
in the App's settings. See [App registration and permissions](GITHUB_CONNECTOR.md#optional-create-your-own-public-github-app).

Alternatively, set both `OPENBOTS_GITHUB_CLIENT_ID` and `OPENBOTS_GITHUB_APP_SLUG` on the server
(see [Default app and custom overrides](GITHUB_CONNECTOR.md#default-app-and-custom-overrides)).
This changes defaults for both coding repositories and the MCP connector. Existing connections
keep their own identifiers, including for refresh. No shared signing key or secret is distributed.

Server-managed Apps from `GITHUB_APP_*` or the self-hosted admin manifest remain available under
**Advanced: server-managed GitHub App**. This distinct mode needs HTTPS for callbacks/webhooks and
sealed server secrets. It supports narrowed installation tokens, App/bot PR identity, and
automatic App-webhook delivery. Device connections have no installation-token signing key and do
not attach to that webhook flow: configure a reachable repository webhook for event Routines
instead. Scheduled work needs no webhook.

## Credential and approval boundaries

Token types, lifetimes and refresh are explained in
[Tokens and security](GITHUB_CONNECTOR.md#tokens-and-security). Specific to coding connections:

- Device-issued tokens refresh without a client secret. Expired or rejected refresh credentials
  require reconnecting.
- User tokens (`ghu_`), unlike installation tokens (`ghs_`), intersect the App installation's
  selected repositories and the authorizing user's access. GitHub cannot narrow them per
  credential request to one repository or to read-only.
- OpenBots lists `/user/installations` and `/user/installations/{id}/repositories` with the user
  token, filtering by the requested App slug and non-suspended installations. It never
  substitutes an App-wide list or `/user/repos`. Repository selection also checks the owned
  connection and its permission snapshot. Installation write permission and user push permission
  are both needed.
- Tokens and device codes are sealed in `git_connections.secrets`, covered by existing master-key
  rotation and workspace RLS. The API exposes only public codes, links and connection metadata.
  All GitHub calls use fixed HTTPS origins, outbound guards, no redirects and timeouts.
- Polls, reconnects and rotating refresh tokens are database-serialized across API/worker
  processes. Errors never echo provider bodies or tokens.
- Runner clone/fetch still runs as the isolated `runner` user with locked-down Git configuration.
  A coding sandbox gets **no user token for fetch or before push approval**. The credential
  helper serves one only for the approved session's push username and exact repository path.
- After an approved push exposes the token, it may be used for any repository that grant reaches.
  This is a real residual risk, not a per-repository token guarantee. Limit the App's repository
  selection, or choose a server-managed App if you need GitHub-enforced per-repository read
  tokens.
- PRs use the authorizing user's identity. Existing push and PR approvals are unchanged.

## Connection recovery and duplicate protection

- The legacy MCP path defaults a bare GitHub Connect request to OAuth/device authorization, not
  bearer auth. A supplied PAT or explicit auth choice still selects the requested mode.
- Repeated default catalog Connect requests reuse one owned connection under a database lock,
  including connectors without OAuth. The UI coalesces rapid clicks and retains a created
  connection across failed/cancelled starts.
- Coding device starts reuse one connection per owned App, including failed/expired attempts and
  reconnects. Concurrent starts receive the same valid code. Different custom Apps remain
  separate.

- Startup repairs empty legacy GitHub bearer records.
- Redundant default rows without credentials, a custom client or authorization in progress are
  consolidated into the retained row. Bot bindings move with them. Overlapping permissions merge
  restrictively, never widening allowlists or relaxing approval, including inherited group denial.
- PATs, named/custom connections, credential-bearing rows and compatibility rows referenced by
  slug-specific Bot/webhook policies are preserved.
- Old credential-free coding attempts are similarly consolidated when Connect is retried.

- Server worker/all startup rechecks usable MCP connections in each workspace in the background,
  with bounded concurrency and live status updates.
- Opening Connectors after a new Mac/browser session refreshes existing connection status once,
  even if Docker kept running.
- Missing credentials or consent, blocked connectors, suspended members, and built-ins are not
  tested.
- Neither check starts a stopped computer merely to test stdio MCPs. Both use the same server-side
  eligibility policy, with a second no-wake guard at process launch if the computer stops after
  preflight. Manual Test and actual tool use can still start it.
- Real failures remain failures. Checks never authorize accounts or mark them healthy untested.
- A sync whose authorization changed returns a conflict without overwriting a successful
  reconnect's status or repository access.

## Verification

Tests in `apps/server/src/routes/git-device.test.ts` and
`apps/web/src/features/repos/repos.test.tsx` run against a **fake GitHub API**. They cover the
real coding-connection routes, picker, remembered repository binding, runner and sandbox
credential paths, refresh, organization/owner isolation, installation waiting, denial, expiry, and
custom App identifiers. Existing checkout/runner tests cover clone/fetch and approved push/PR
orchestration.

A release still needs this **real GitHub check**, which those tests do not imply:

1. Connect a selected private test repository on a Mac/localhost and authorize the code.
2. Select and clone it, then run a coding task.
3. Verify an unapproved push is denied.
4. Approve a branch push and PR, and verify both on GitHub.
5. Remove repository access and verify sync/operations fail closed.
6. Reconnect, then disconnect.
7. Check an organization requiring approval, and a custom App if used.

Only server-managed App installation/callback verification needs a public HTTPS endpoint.
