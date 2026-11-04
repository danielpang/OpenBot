import { PREVIEW_BROWSER_BUNDLE, PREVIEW_THIRD_PARTY_NOTICES } from './generated';
import { previewSocketPath } from './bridge';

export function previewHTML(botId: string, session: string): string {
  if (!/^[a-zA-Z0-9-]{16,128}$/.test(session)) throw new Error('Invalid preview session');
  const config = JSON.stringify({ path: previewSocketPath(botId), session }).replace(
    /</g,
    '\\u003c',
  );
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; worker-src blob:; base-uri 'none'; form-action 'none'"><style>html,body,#screen{margin:0;width:100%;height:100%;overflow:hidden;background:#111;color:#fff}canvas{pointer-events:none}</style></head><body><div id="screen" role="img" aria-label="View-only Bot screen"></div><script type="module">window.__previewConfig=${config};${PREVIEW_BROWSER_BUNDLE}</script><script type="application/json" id="third-party-notices">${JSON.stringify(PREVIEW_THIRD_PARTY_NOTICES).replace(/</g, '\\u003c')}</script></body></html>`;
}
