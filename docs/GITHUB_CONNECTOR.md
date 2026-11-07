# Shared GitHub App connector

The catalog's **GitHub** MCP connector uses a public **GitHub App**. Owners install it on their
personal account or organization, select repositories, then authorize a user access token with
GitHub's device flow. This connects repositories, issues and pull requests to Bots without
adding an OpenBots account system or changing how the owner accesses OpenBots.

The separate `github_builtin` connector still uses a personal access token.

## Create a public GitHub App

1. Open [GitHub Apps settings](https://github.com/settings/apps) and choose **New GitHub App**.
   For an organization-owned app, use the organization's Settings > Developer settings >
   GitHub Apps instead. Do not create an OAuth App.
2. Choose a recognizable name, such as **OpenBots GitHub Connector**, and set the homepage to
   `https://openbots.dev` or your actual product homepage. GitHub App names must be unique.
3. Under user authorization, enable **Device Flow**. Keep user access token expiration enabled
   (the default). OpenBots handles expiring access tokens and rotating refresh tokens without
   a client secret. No browser callback or hosted OAuth broker is needed for this flow.
   Leave the callback and setup URLs empty; do not enable authorization during installation,
   which uses a different redirect-based flow.
4. Disable **Active** under Webhook. This integration does not need an incoming webhook URL.
5. Set the repository permissions needed by the tools you want to offer:

   | Repository permission | Suggested access                   | Purpose                                                |
   | --------------------- | ---------------------------------- | ------------------------------------------------------ |
   | Metadata              | Read-only (automatically required) | Repository information                                 |
   | Contents              | Read and write                     | Read code and create/update repository files           |
   | Issues                | Read and write                     | Read, open and comment on issues                       |
   | Pull requests         | Read and write                     | Read, open, comment on and update pull requests        |
   | Actions               | Read-only, optional                | Inspect workflow runs and checks through Actions tools |

   Leave unrelated permissions disabled. Use read-only permissions instead if Bots should not
   write. Workflow-file changes or additional MCP tools may need further permissions; grant
   them deliberately. Organization/user permissions are not needed for the basic repository
   integration. Changing app permissions can require installation owners to approve the update.

6. Under **Where can this GitHub App be installed?**, select **Any account**. This makes it a
   public app that other people and organizations can install. Register the app.
7. Copy the app's **Client ID**, not its numeric App ID, and its **slug**, the name in
   `https://github.com/apps/your-app-slug`.
8. Do not generate or distribute a private key or client secret for this integration. Neither
   is used by the device authorization or device-token refresh flow.

The public installation link is:

```text
https://github.com/apps/your-app-slug/installations/new
```

No Marketplace listing is required. Organization owners may need to approve an installation.
Public visibility permits installation; it does not grant access to anyone's repositories by
itself. Installation and user authorization are separate steps.

## Configure an instance

Set both public identifiers on the OpenBots **server**, then restart it:

```dotenv
OPENBOTS_GITHUB_CLIENT_ID=your_github_app_client_id
OPENBOTS_GITHUB_APP_SLUG=your-app-slug
```

For Compose, put them in the stack's `.env` and recreate the server:

```sh
docker compose up -d --force-recreate openbots
```

For the standalone image, pass both variables with `docker run -e`, use your hosting
platform's environment settings, or put them in the instance's persisted dotenv file and
restart. These values are public, not secrets.

Do not use `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` for this. Those remain the separate,
existing OpenBots sign-in settings.

## Bundle the public app for every self-hoster

Set both constants in `apps/server/src/config.ts`, then build and release normally:

```ts
export const DEFAULT_GITHUB_CONNECTOR_CLIENT_ID = 'your_github_app_client_id';
export const DEFAULT_GITHUB_CONNECTOR_APP_SLUG = 'your-app-slug';
```

Both defaults are intentionally empty until the real GitHub App exists. A secret or private
key must never be added alongside them. Self-hosters can override both environment variables
to use their own GitHub App without rebuilding. A client-ID override does not inherit the
bundled app's slug, which could otherwise link users to the wrong app.

Alternatively, Advanced on a GitHub connector accepts a per-connector public **client ID**
and **GitHub App slug**. The GitHub form does not ask for a secret. Other connectors keep
their existing OAuth configuration, and GitHub's personal-access-token alternative remains
available. An OAuth App client or redirect-based GitHub client configuration is not used by
this GitHub App integration. Reconnect existing connectors with the GitHub App identifiers.

## What the owner sees

1. Open **Connectors**, find **GitHub**, and press **Connect**.
2. OpenBots shows a short-lived device code and opens the app's GitHub installation page.
   Choose a personal account or organization and **Only select repositories**, then choose
   the repositories to share. An organization member may need to request approval instead.
3. Return to OpenBots, open its **GitHub authorization** link, enter the displayed code, check
   the app identity and permissions, and approve. If installation took too long, press Connect
   again to get a new code. Never approve an unexpected device code.
4. OpenBots exchanges the device code, verifies a non-suspended installation of the configured
   app visible to that user, saves the user access token encrypted, and tests the MCP connector.
   Authorizing without installing does not count as a successful connection; OpenBots explains
   how to install and reconnect.
5. **Manage repositories** opens GitHub's installation page again to change repository access
   or install the app on another account or organization. A self-hoster's custom app uses its
   own installation link, not the shared app's link.

A user access token is limited by both the app's registered permissions and installations and
the authorizing user's own access. Installing on a repository does not grant the user rights
they did not already have. This is not the broad OAuth `repo` scope. GitHub enforces access to
private repositories; public resources may also be readable according to GitHub's API rules.

## Tokens and security

- This integration uses **GitHub App user access tokens** (`ghu_`), not app installation tokens
  (`ghs_`). Bots act on behalf of the authorizing GitHub user. No app-wide private key, signing
  service or installation-token broker is involved.
- GitHub's default expiring user tokens last eight hours, with refresh tokens lasting six
  months. The server records both expirations and rotates tokens when needed. GitHub explicitly
  permits refreshing tokens obtained through device flow **without `client_secret`**. The
  device-flow marker and app identifiers are stored with the sealed credentials so refresh
  does not accidentally fall back to generic OAuth discovery.
- Refresh runs under a database row lock, preventing simultaneous API/worker processes from
  spending the same single-use refresh token. Provider errors never echo token values. If
  refresh expires or is rejected, reconnect through device authorization.
- An app configured to issue non-expiring user tokens is supported, but keeping expiration
  enabled is recommended. Never silently treat an expiring token as permanent.
- Device codes, access tokens and refresh tokens are encrypted on the self-hosted server.
  The browser receives only public app/installation links, the user code, expiry, polling
  interval and status. The self-hosted server still receives a sensitive GitHub credential:
  only authorize instances you trust.
- GitHub device polling intervals and `slow_down` are enforced. Denied/expired codes require
  a new Connect attempt. Cancel stops polling in that page; an unused code expires on GitHub.
- Users can revoke authorization under Settings > Applications > Authorized GitHub Apps, or
  remove/reconfigure the installation under Installed GitHub Apps. Authorization revocation
  and uninstalling are different operations. Revocation may affect other instances using the
  same user and app identity; do not assume grants are isolated per self-hosted instance.
- A shared public app is an operational dependency: suspension, permission changes or deletion
  can affect every installation. Self-hosters who need independence can register their own app.
- This flow targets GitHub.com. GitHub Enterprise Server needs a separate integration.

## References

- [GitHub App user tokens and device flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)
- [Refreshing GitHub App user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens#refreshing-a-user-access-token-with-a-refresh-token)
- [GitHub MCP host integration and GitHub App support](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)
