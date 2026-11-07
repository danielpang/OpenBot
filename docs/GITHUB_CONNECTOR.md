# Shared GitHub connector OAuth App

The catalog's **GitHub** MCP connector supports GitHub's device authorization flow. This
connects repositories, issues and pull requests to Bots. It does not create an OpenBots account
or change how the owner accesses OpenBots. The separate `github_builtin` connector still uses
its personal access token.

## Create and share the app

1. Open [GitHub OAuth Apps](https://github.com/settings/developers) and choose **New OAuth App**.
   For an organization-owned app, use the organization's Settings > Developer settings instead.
   Create an **OAuth App**, not a GitHub App.
2. Name it **OpenBots**, or **OpenBots GitHub Connector**, and set its homepage to
   `https://openbots.dev` (or your actual product homepage). Use a clear description so people
   recognize what they are authorizing.
3. GitHub's registration form requires an authorization callback URL. You can use
   `https://openbots.dev/oauth/unused` for a device-only app; this is a placeholder and does not
   need a working endpoint. Device authorization never redirects to it. Do not configure a
   redirect-based flow for this app unless you also register its real callback.
4. Register the app, then enable **Device Flow** in the app's settings and save.
5. Copy the **Client ID**. It is public and safe to distribute. No client secret is needed.
   If GitHub generated a secret, do not copy it into the repository, build or self-hosted image.
6. There is no public/private toggle or publishing approval for an OAuth App. Other GitHub.com
   users can authorize it through GitHub's device page. A Marketplace listing is not required.
   Organization policies, OAuth App restrictions and SAML SSO can still require owner approval
   or additional authorization before organization repositories are accessible.

## Configure an instance now

Set this on the OpenBots **server**, then restart it:

```dotenv
OPENBOTS_GITHUB_CLIENT_ID=your_public_client_id
```

For Compose, put it in the stack's `.env` and recreate the server:

```sh
docker compose up -d --force-recreate openbots
```

For the standalone image, pass `-e OPENBOTS_GITHUB_CLIENT_ID=...` when creating the container,
use your hosting platform's environment settings, or set it in the instance's persisted dotenv
file. Restart the instance after changing it.

Do not use `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` for this. Those are the existing,
separate OpenBots sign-in settings.

## Bundle one public ID for all self-hosters

Set `DEFAULT_GITHUB_CONNECTOR_CLIENT_ID` in `apps/server/src/config.ts` to the OAuth App's
**public client ID**, then build and release the server image normally. Every installation of
that build can use **Connect** without configuring an app. The constant is intentionally empty
until the real OAuth App exists. A secret must never be added alongside it.

`OPENBOTS_GITHUB_CLIENT_ID` overrides the bundled ID, so a self-hoster can use an independent
OAuth App without rebuilding. Alternatively, the connector's Advanced settings accept a
per-connector client ID. Leave its client secret empty for device flow. An explicitly supplied
client ID and secret retain the existing redirect flow, using the displayed callback URL.

When neither a bundled nor an instance ID is configured, GitHub still offers the existing
Advanced client setup and personal-access-token alternatives. Other connectors are unchanged.

## What the owner sees

1. Open **Connectors**, find **GitHub**, and press **Connect**.
2. OpenBots displays a short-lived code and opens `https://github.com/login/device` in a popup
   or the Mac app's default browser. A manual link remains available if the browser blocks it.
3. Enter the displayed code, check the app name and permissions, and approve access.
4. OpenBots polls GitHub, stores the token encrypted on that self-hosted server and tests the
   connector for its tools. No public callback URL, tunnel or central OpenBots auth broker is
   required. The server needs outbound access to GitHub and GitHub's MCP endpoint.

Only approve a device code you just requested on an instance you trust. An untrusted
self-hosted instance receives the GitHub token you authorize; sharing an app ID does not make
that instance trustworthy.

## Permissions and operational tradeoffs

- Requested OAuth scopes are `repo`, `read:org` and `read:user`, matching the GitHub connector.
  `repo` is broad read/write access to repositories the user can access, subject to organization
  policies. This is not a per-repository GitHub App installation. Use the personal-access-token
  option with a narrowly scoped fine-grained PAT when that is preferable.
- The device code and resulting access token are encrypted in the connector's secrets. The
  browser receives only the user code, verification URL, expiry, polling interval and status.
  Polling requires the connector owner's existing OpenBots authorization.
- The server enforces polling intervals, including GitHub's `slow_down` response. Expired or
  denied codes require a new Connect attempt. Cancel stops polling in that page; an unused
  device code expires on GitHub rather than being remotely revoked by Cancel.
- Users can revoke the app under GitHub Settings > Applications > Authorized OAuth Apps.
  Revocation can affect other installations using the same app identity. Do not assume tokens
  or grants are isolated by self-hosted instance. Reconnect if GitHub rejects a token.
- One shared OAuth App is a shared operational dependency: app suspension or restrictions can
  affect every installation. Support independent OAuth Apps for self-hosters who need isolation.
- This flow targets GitHub.com. GitHub Enterprise Server requires a separate integration.

Protocol reference: [GitHub device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
