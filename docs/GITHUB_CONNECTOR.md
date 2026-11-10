# Legacy GitHub tool connector

New GitHub connections use **GitHub for coding agents**; see [GITHUB_REPOSITORIES.md](GITHUB_REPOSITORIES.md). The add-connector catalog no longer offers the MCP and built-in GitHub choices. Existing tool connections remain under **Existing GitHub tool connections**, with credentials and Bot usage preserved. This document covers that compatibility path.

The catalog's **GitHub** MCP connector uses a public **GitHub App**. Owners install it on a personal account or organization, select repositories, then authorize a user access token with GitHub's device flow. Bots get repositories, issues and pull requests with no OpenBots account system and no change to how the owner accesses OpenBots.

**Coding-agent repository access is a separate connection** (**GitHub for coding agents → Connect GitHub**). Authorizing this MCP connector does not connect the repository picker or git credentials. Both flows share the public App defaults but keep separate owned credentials.

The separate `github_builtin` connector still uses a personal access token.

## Optional: create your own public GitHub App

End users do **not** need this. These steps are for operators replacing the shared OpenBots App.

1. In [GitHub Apps settings](https://github.com/settings/apps), choose **New GitHub App**. For an
   organization, use its Settings > Developer settings > GitHub Apps. Do not create an OAuth App.
2. Pick a unique name, such as **OpenBots GitHub Connector**. Set the homepage to
   `https://openbots.dev` or your product homepage.
3. Under user authorization, enable **Device Flow** and keep user access token expiration enabled
   (the default). Leave the callback and setup URLs empty. Do not enable authorization during
   installation, a different redirect-based flow. No browser callback or hosted OAuth broker is
   needed.
4. Disable **Active** under Webhook. No incoming webhook URL is needed.
5. Set the repository permissions for the tools you want to offer:

   | Repository permission | Suggested access                   | Purpose                                                |
   | --------------------- | ---------------------------------- | ------------------------------------------------------ |
   | Metadata              | Read-only (automatically required) | Repository information                                 |
   | Contents              | Read and write                     | Read code and create/update repository files           |
   | Issues                | Read and write                     | Read, open and comment on issues                       |
   | Pull requests         | Read and write                     | Read, open, comment on and update pull requests        |
   | Actions               | Read-only, optional                | Inspect workflow runs and checks through Actions tools |

   Use read-only access if Bots should not write, and leave unrelated permissions disabled.
   Workflow-file changes or additional MCP tools may need further permissions; grant them
   deliberately. Organization/user permissions are not needed. Changing permissions can require
   installation owners to approve the update.

6. Under **Where can this GitHub App be installed?**, select **Any account** so other people and
   organizations can install it. Register the app.
7. Copy the **Client ID** (not the numeric App ID) and the **slug**, the name in
   `https://github.com/apps/your-app-slug`.
8. Do not generate or distribute a private key or client secret. This flow uses neither.

The public installation link is:

```text
https://github.com/apps/your-app-slug/installations/new
```

No Marketplace listing is required. Organization owners may need to approve an installation. A
public app can be installed by anyone but grants no repository access by itself; installation and
user authorization are separate steps.

## Default app and custom overrides

OpenBots, including the server used by the Mac app, defaults to the public
[`openbots-github`](https://github.com/apps/openbots-github) GitHub App. No app registration or
environment configuration is required.

To use your own App, set both public identifiers (not secrets) on the OpenBots **server**, then
restart it:

```dotenv
OPENBOTS_GITHUB_CLIENT_ID=your_github_app_client_id
OPENBOTS_GITHUB_APP_SLUG=your-app-slug
```

For Compose, put them in the stack's `.env` and recreate the server:

```sh
docker compose up -d --force-recreate openbots
```

For the standalone image, pass both with `docker run -e`, use your hosting platform's environment
settings, or put them in the instance's persisted dotenv file and restart.

Do not use `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` for this. Those are the separate OpenBots
sign-in settings.

## Bundle the public app for every self-hoster

These public constants in `apps/server/src/config.ts` ship in every server build, including the
server image used by the Mac app:

```ts
export const DEFAULT_GITHUB_CONNECTOR_CLIENT_ID = 'Iv23liyL74CRKUWIUXhq';
export const DEFAULT_GITHUB_CONNECTOR_APP_SLUG = 'openbots-github';
```

Never add a secret or private key alongside them. The environment variables above override both
without a rebuild. A client-ID override does not inherit the bundled slug, which could link users
to the wrong app.

Advanced on a GitHub connector also accepts a per-connector public **client ID** and **GitHub App
slug**. The form asks for no secret. Other connectors keep their OAuth configuration, and GitHub's
personal-access-token alternative remains available. OAuth App clients and redirect-based GitHub
client configuration are not used. Reconnect existing connectors with the GitHub App identifiers.

## What the owner sees

1. For an existing MCP connection, open **Connectors → Existing GitHub tool connections**, find
   **GitHub**, and press **Connect** or **Reconnect**.
2. OpenBots shows a short-lived device code and opens the app's GitHub installation page. Choose
   a personal account or organization, **Only select repositories**, and the repositories to
   share. An organization member may need to request approval instead.
3. Back in OpenBots, open the **GitHub authorization** link, enter the code, check the app
   identity and permissions, and approve. If installation took too long, press Connect again for
   a new code. Never approve an unexpected device code.
4. OpenBots exchanges the code, verifies a non-suspended installation of the configured app
   visible to that user, saves the user access token encrypted, and tests the MCP connector.
   Authorizing without installing does not connect; OpenBots explains how to install and
   reconnect.
5. **Manage repositories** reopens the installation page to change repository access or install
   on another account or organization. A custom app uses its own installation link, not the
   shared app's.

The token is limited by the app's registered permissions and installations and by the authorizing
user's own access, so installing on a repository grants the user no new rights. This is not the
broad OAuth `repo` scope. GitHub enforces private repository access; public resources may also be
readable under GitHub's API rules.

## Tokens and security

- Tokens are **GitHub App user access tokens** (`ghu_`), not installation tokens (`ghs_`). Bots
  act as the authorizing GitHub user. There is no app-wide private key, signing service or
  installation-token broker.
- By default, user tokens last eight hours and refresh tokens six months. The server records both
  expirations and rotates tokens as needed. GitHub permits refreshing device-flow tokens
  **without `client_secret`**. The device-flow marker and app identifiers are stored with the
  sealed credentials, so refresh never falls back to generic OAuth discovery.
- Refresh runs under a database row lock, so concurrent API/worker processes cannot spend the same
  single-use refresh token. Provider errors never echo token values. If refresh expires or is
  rejected, reconnect through device authorization.
- Apps issuing non-expiring user tokens are supported, but keep expiration enabled. Never silently
  treat an expiring token as permanent.
- Device codes, access tokens and refresh tokens are encrypted on the self-hosted server. The
  browser receives only public app/installation links, the user code, expiry, polling interval
  and status. The server still holds a sensitive GitHub credential: only authorize instances you
  trust.
- GitHub's polling intervals and `slow_down` are enforced. Denied/expired codes require a new
  Connect attempt. Cancel stops polling in that page; an unused code expires on GitHub.
- Users can revoke authorization under Settings > Applications > Authorized GitHub Apps, or
  remove/reconfigure the installation under Installed GitHub Apps. These are different
  operations. Revocation may affect other instances using the same user and app identity; do not
  assume grants are isolated per self-hosted instance.
- A shared public app is an operational dependency: its suspension, permission changes or deletion
  can affect every installation. Register your own app if you need independence.
- This flow targets GitHub.com. GitHub Enterprise Server needs a separate integration.

## References

- [GitHub App user tokens and device flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)
- [Refreshing GitHub App user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens#refreshing-a-user-access-token-with-a-refresh-token)
- [GitHub MCP host integration and GitHub App support](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)
