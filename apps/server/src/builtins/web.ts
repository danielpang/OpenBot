import { Readability } from '@mozilla/readability';
import type { FetchedPage, HttpRequestInput, HttpResponse } from '@openbots/agent';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { guardedFetch, type NetOptions } from './net.js';

// web_fetch and http_request (plan 5.4). A page is reduced to its readable
// part (Mozilla Readability over linkedom) and turned into markdown; the agent
// side frames it as data (P2). http_request returns the raw status, headers
// and text body. Both read at most a few megabytes from the network.

export const MAX_FETCH_BYTES = 3 * 1024 * 1024;
export const MAX_HTTP_BODY_CHARS = 40_000;

const USER_AGENT = 'OpenBots/1.0 (+https://github.com/danielpang/OpenBots)';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
turndown.remove(['script', 'style', 'noscript', 'iframe']);

const isHtml = (type: string) => /\btext\/html\b|application\/xhtml\+xml/i.test(type);
const isText = (type: string) =>
  !type || /^text\/|[/+](json|xml|javascript|csv|yaml|markdown)\b/i.test(type);

function charset(type: string) {
  const match = /charset=([^;]+)/i.exec(type);
  try {
    return new TextDecoder(match?.[1]?.trim() ?? 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

/** The readable part of an HTML document as markdown, with its title. */
export function htmlToMarkdown(html: string): { title: string | null; markdown: string } {
  const { document } = parseHTML(html);
  const title = document.querySelector('title')?.textContent?.trim() || null;
  let content: string | null;
  let articleTitle: string | null = null;
  try {
    const article = new Readability(
      document as unknown as ConstructorParameters<typeof Readability>[0],
      {
        charThreshold: 100,
      },
    ).parse();
    content = article?.content ?? null;
    articleTitle = article?.title?.trim() || null;
  } catch {
    content = null;
  }
  // Pages Readability cannot read (a short page, an app shell) fall back to the whole body.
  const source = content ?? parseHTML(html).document.body?.innerHTML ?? html;
  const markdown = turndown
    .turndown(source)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: articleTitle ?? title, markdown };
}

export async function fetchPage(url: string, net: NetOptions = {}): Promise<FetchedPage> {
  const res = await guardedFetch(
    url,
    {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
    },
    MAX_FETCH_BYTES,
    net,
  );
  const type = res.headers.get('content-type') ?? '';
  if (!isHtml(type) && !isText(type)) {
    throw new Error(`${res.url} is ${type.split(';')[0]}, not a page that can be read as text`);
  }
  const text = charset(type).decode(res.body);
  if (res.status >= 400 && !text.trim()) throw new Error(`${res.url} answered HTTP ${res.status}`);
  if (!isHtml(type)) {
    return { url: res.url, status: res.status, contentType: type, title: null, markdown: text };
  }
  const page = htmlToMarkdown(text);
  return { url: res.url, status: res.status, contentType: type, ...page };
}

export async function httpRequest(
  request: HttpRequestInput,
  net: NetOptions = {},
): Promise<HttpResponse> {
  const method = request.method.toUpperCase();
  const res = await guardedFetch(
    request.url,
    {
      method,
      headers: { 'user-agent': USER_AGENT, ...request.headers },
      ...(request.body !== undefined && method !== 'GET' && method !== 'HEAD'
        ? { body: request.body }
        : {}),
    },
    MAX_FETCH_BYTES,
    net,
  );
  const type = res.headers.get('content-type') ?? '';
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  let body =
    isText(type) || isHtml(type)
      ? charset(type).decode(res.body)
      : `[${res.body.length} bytes of ${type.split(';')[0] || 'binary data'}]`;
  let truncated = res.truncated;
  if (body.length > MAX_HTTP_BODY_CHARS) {
    body = body.slice(0, MAX_HTTP_BODY_CHARS);
    truncated = true;
  }
  return { status: res.status, headers, body, truncated };
}
