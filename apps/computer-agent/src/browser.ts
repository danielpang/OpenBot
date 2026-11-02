import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { ZodError } from 'zod';
import type { DevToolsEndpoint } from './devtools.js';
import { AgentError } from './errors.js';
import {
  BrowserActionSchemas,
  type BrowserActionName,
  type BrowserResult,
  type ScreenInfo,
} from './protocol.js';

// DOM mode (plan 9.3): Playwright attached over CDP to the screen's Chromium,
// through the agent's bridge to Chromium's DevTools pipe (devtools.ts).
// `snapshot` returns Playwright's AI-mode aria snapshot, whose `[ref=eN]`
// markers the other actions take; a ref resolves against the latest snapshot.

const DEFAULT_TIMEOUT_MS = 15_000;

export class BrowserPool {
  private readonly browsers = new Map<number, Promise<Browser>>();

  constructor(private readonly endpoint: (info: ScreenInfo) => DevToolsEndpoint) {}

  private connect(info: ScreenInfo): Promise<Browser> {
    let pending = this.browsers.get(info.n);
    if (!pending) {
      const { url, headers } = this.endpoint(info);
      // noDefaults: Playwright would otherwise send downloads to its own
      // temporary directory, which the screen's user cannot write, instead
      // of the shared one in Chromium's settings (screens.ts).
      pending = chromium.connectOverCDP(url, { headers, noDefaults: true }).then((browser) => {
        browser.once('disconnected', () => {
          if (this.browsers.get(info.n) === pending) this.browsers.delete(info.n);
        });
        return browser;
      });
      pending.catch(() => this.browsers.delete(info.n));
      this.browsers.set(info.n, pending);
    }
    return pending;
  }

  /**
   * The profile's own context, whose cookies are the screen's (cookies.ts).
   * A connection to a Chromium that has since exited is dropped for a new one.
   */
  async context(info: ScreenInfo): Promise<BrowserContext> {
    let browser = await this.connect(info);
    if (!browser.isConnected()) {
      this.browsers.delete(info.n);
      browser = await this.connect(info);
    }
    return browser.contexts()[0] ?? (await browser.newContext());
  }

  /** The tab the Bot works in: the most recently opened one still open. */
  async page(info: ScreenInfo): Promise<Page> {
    const context = await this.context(info);
    const open = context.pages().filter((p) => !p.isClosed());
    return open.at(-1) ?? (await context.newPage());
  }

  async run(info: ScreenInfo, action: BrowserActionName, body: unknown): Promise<BrowserResult> {
    if (!(action in BrowserActionSchemas)) {
      throw new AgentError(404, 'UNKNOWN_BROWSER_ACTION', `No browser action "${action}"`);
    }
    const page = await this.page(info);
    try {
      await perform(page, action, body);
    } catch (err) {
      if (err instanceof AgentError || err instanceof ZodError) throw err;
      const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      throw new AgentError(422, 'BROWSER_ACTION_FAILED', message);
    }
    // A click may have opened a tab; report on the one now in front.
    const current = await this.page(info);
    const result: BrowserResult = { url: current.url(), title: await current.title() };
    if (action === 'snapshot') result.snapshot = await current.ariaSnapshot({ mode: 'ai' });
    return result;
  }

  async disconnect(n: number): Promise<void> {
    const pending = this.browsers.get(n);
    this.browsers.delete(n);
    // Closing a CDP connection leaves the browser itself running.
    await pending?.then((b) => b.close()).catch(() => undefined);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.browsers.keys()].map((n) => this.disconnect(n)));
  }
}

async function perform(page: Page, action: BrowserActionName, body: unknown): Promise<void> {
  switch (action) {
    case 'navigate': {
      const a = BrowserActionSchemas.navigate.parse(body);
      const url = /^[a-z][a-z0-9+.-]*:/i.test(a.url) ? a.url : `https://${a.url}`;
      await page.goto(url, { timeout: a.timeoutMs ?? DEFAULT_TIMEOUT_MS * 2 });
      return;
    }
    case 'snapshot':
      BrowserActionSchemas.snapshot.parse(body ?? {});
      return;
    case 'click': {
      const a = BrowserActionSchemas.click.parse(body);
      const target = page.getByRef(a.ref);
      const opts = { button: a.button, timeout: a.timeoutMs ?? DEFAULT_TIMEOUT_MS };
      await (a.doubleClick ? target.dblclick(opts) : target.click(opts));
      return;
    }
    case 'type': {
      const a = BrowserActionSchemas.type.parse(body);
      const target = page.getByRef(a.ref);
      const timeout = a.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      await target.fill(a.text, { timeout });
      if (a.submit) await target.press('Enter', { timeout });
      return;
    }
    case 'press': {
      const a = BrowserActionSchemas.press.parse(body);
      if (a.ref)
        await page.getByRef(a.ref).press(a.key, { timeout: a.timeoutMs ?? DEFAULT_TIMEOUT_MS });
      else await page.keyboard.press(a.key);
      return;
    }
    case 'wait': {
      const a = BrowserActionSchemas.wait.parse(body);
      const timeout = a.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (a.ms !== undefined) await page.waitForTimeout(a.ms);
      if (a.text) await page.getByText(a.text).first().waitFor({ state: 'visible', timeout });
      if (a.textGone)
        await page.getByText(a.textGone).first().waitFor({ state: 'hidden', timeout });
      return;
    }
  }
}
