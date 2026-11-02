import { randomBytes } from 'node:crypto';
import type { OAuthMode } from '@openbots/mcp';

// The page a connector's OAuth sign-in ends on (plan 8): the provider sends
// the browser to `GET /api/v1/connectors/oauth/callback`, which answers with
// this small page instead of the web app. It loads nothing (no bundle, no
// sign-in) and says whether the connector is connected. Opened as a popup of
// the web app, it tells its opener the outcome with `postMessage` to the
// server's own origin and closes itself on success; the message carries the
// status and the connector id, never a token. Opened in the default browser by
// the Mac app, it links back to the app. Its one inline script and style run
// under a per-response CSP nonce; it sends no referrer and is never cached.

/** The `postMessage` data type the web app listens for. */
export const OAUTH_MESSAGE_TYPE = 'openbots:oauth';

/** Opens the Mac app (it registers the `openbots:` scheme) at the Connectors page. */
export const APP_LINK = 'openbots://connectors';

export interface OAuthPageInput {
  ok: boolean;
  /** The connector's name, shown as the provider; escaped here. */
  name: string | null;
  /** Why it failed, for the owner; escaped here. */
  reason?: string | null;
  connectorId: string | null;
  /** Unknown when the state did not check out. */
  mode: OAuthMode | null;
  /** `OPENBOTS_PUBLIC_URL`: the only origin the page posts to. */
  publicUrl: string;
}

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}

/** JSON that is safe inside a `<script>` element. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

export function renderOAuthPage(input: OAuthPageInput): {
  html: string;
  headers: Record<string, string>;
} {
  const nonce = randomBytes(16).toString('base64');
  const provider = input.name?.trim() || 'The connector';
  const title = input.ok ? `${provider} is connected` : `${provider} did not connect`;
  const lines = input.ok
    ? ['You can close this window.']
    : [
        input.reason?.trim() || 'The sign-in did not finish.',
        'You can close this window and try again.',
      ];
  const message = {
    type: OAUTH_MESSAGE_TYPE,
    status: input.ok ? 'connected' : 'error',
    connectorId: input.connectorId,
  };
  const origin = new URL(input.publicUrl).origin;
  const script =
    input.mode === 'popup'
      ? `<script nonce="${nonce}">(function () {
  var opener = window.opener;
  if (!opener || opener.closed) return;
  try { opener.postMessage(${scriptJson(message)}, ${scriptJson(origin)}); } catch (e) { return; }${
    // A failure stays open so its reason can be read.
    input.ok ? '\n  window.close();' : ''
  }
})();</script>`
      : '';
  const back =
    input.mode === 'external' ? `<a class="button" href="${APP_LINK}">Return to OpenBots</a>` : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: oklch(0.145 0 0); color: oklch(0.985 0 0);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main {
  width: 100%; max-width: 360px; padding: 32px 28px; border-radius: 12px; text-align: center;
  background: oklch(0.205 0 0); border: 1px solid oklch(1 0 0 / 10%);
}
svg.icon { width: 56px; height: 56px; display: block; margin: 0 auto 20px; }
h1 { margin: 0 0 8px; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
p { margin: 0; color: oklch(0.708 0 0); overflow-wrap: anywhere; }
p + p { margin-top: 4px; }
p.reason { color: oklch(0.704 0.191 22.216); }
.button {
  display: inline-block; margin-top: 20px; padding: 8px 14px; border-radius: 8px;
  background: oklch(0.922 0 0); color: oklch(0.205 0 0); font-weight: 500; text-decoration: none;
}
</style>
${script}
</head>
<body>
<main data-status="${message.status}">
${APP_ICON}
<h1>${escapeHtml(title)}</h1>
${lines
  .map((line, i) => `<p${!input.ok && i === 0 ? ' class="reason"' : ''}>${escapeHtml(line)}</p>`)
  .join('\n')}
${back}
</main>
</body>
</html>
`;
  return {
    html,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "img-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  };
}

/** apps/web/public/favicon.svg, inline so the page loads nothing. */
const APP_ICON = `<svg class="icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1c1c"/><stop offset="1" stop-color="#0a0a0a"/></linearGradient><linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".14"/><stop offset="1" stop-color="#FFFFFF" stop-opacity=".04"/></linearGradient></defs><rect x="0" y="0" width="1024" height="1024" rx="229.9" fill="url(#plate)"/><rect x="1.5" y="1.5" width="1021" height="1021" rx="228.4" fill="none" stroke="url(#rim)" stroke-width="3"/><svg x="-0.89" y="-32.95" width="1025.78" height="1025.78" viewBox="0 0 64 64"><path d="M9 34a23 23 0 1 0 46 0a23 23 0 1 0-46 0Z" fill="#4A9EF0"/><ellipse cx="23" cy="20" rx="7" ry="4" fill="#FFFFFF" opacity=".18"/><g fill="#0F2E66" opacity=".55"><ellipse cx="17" cy="41" rx="3.5" ry="2"/><ellipse cx="47" cy="41" rx="3.5" ry="2"/></g><circle cx="24" cy="32" r="6.5" fill="#FFFFFF"/><circle cx="24" cy="34" r="3.2" fill="#0B1F3A"/><circle cx="25.12" cy="32.88" r="1.02" fill="#FFFFFF"/><path d="M17 31.5a7 7 0 0 1 14 0Z" fill="#4A9EF0"/><path d="M17.5 31.5h13" stroke="#0B1F3A" stroke-width="2.5" stroke-linecap="round"/><circle cx="40" cy="32" r="6.5" fill="#FFFFFF"/><circle cx="40" cy="34" r="3.2" fill="#0B1F3A"/><circle cx="41.12" cy="32.88" r="1.02" fill="#FFFFFF"/><path d="M33 31.5a7 7 0 0 1 14 0Z" fill="#4A9EF0"/><path d="M33.5 31.5h13" stroke="#0B1F3A" stroke-width="2.5" stroke-linecap="round"/><circle cx="24" cy="32" r="8.5" fill="none" stroke="#0B1F3A" stroke-width="2.5"/><circle cx="40" cy="32" r="8.5" fill="none" stroke="#0B1F3A" stroke-width="2.5"/><path d="M32.5 31h-1" fill="none" stroke="#0B1F3A" stroke-width="2.5"/><path d="M15.5 30H10M48.5 30H54" fill="none" stroke="#0B1F3A" stroke-width="2.5"/></svg></svg>`;
