// @vitest-environment happy-dom
import { EditorView } from '@codemirror/view';
import type { WsClient } from '@openbots/api-client';
import type { WsEvent } from '@openbots/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RightPanelProvider, useRightPanel } from '../../app/right-panel.js';
import { readPanel, writePanel } from '../transcript/panel.js';
import { RealtimeContext, type Realtime } from '../transcript/realtime.js';
import type { Artifact, ArtifactVersion } from './api.js';
import { ArtifactsTab } from './artifacts-tab.js';
import { ArtifactPart } from './card.js';
import { parseCsv, parseTable } from './data.js';
import { ArtifactViewer } from './viewer.js';

// The Artifact UI against a fake REST server and socket: the card and its
// live version, switching versions, the diff, and an edit that saves a
// version attributed to the user (A2); the Bot's Artifacts tab (A4).

const ID = '00000000-0000-4000-8000-0000000000a1';
const BOT = '00000000-0000-4000-8000-0000000000b1';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    puts: [] as unknown[],
    texts: [] as string[],
    kind: 'document' as string,
    title: 'Q3 summary',
    mime: 'text/markdown',
    handle: (async () => Response.error()) as (request: Request) => Promise<Response>,
  };
  // The api client keeps the fetch it was created with, so swap it before any import.
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    state.handle(input instanceof Request ? input : new Request(String(input), init));
  return state;
});

function version(n: number, createdBy: 'bot' | 'user'): ArtifactVersion {
  return {
    id: `00000000-0000-4000-8000-00000000010${n}`,
    artifactId: ID,
    version: n,
    mime: server.mime,
    size: server.texts[n - 1]!.length,
    summary: n === 1 ? '+2 −0' : '+1 −1',
    createdBy,
    createdByRunId: createdBy === 'bot' ? '00000000-0000-4000-8000-0000000000f1' : null,
    createdByUserId: createdBy === 'user' ? '00000000-0000-4000-8000-000000000001' : null,
    createdAt: `2026-10-18T10:0${n}:00.000Z`,
  };
}
const versions = () =>
  server.texts.map((_, i) => version(i + 1, i === 2 ? 'user' : 'bot')).reverse();
function artifact(): Artifact {
  return {
    id: ID,
    botId: BOT,
    chatId: null,
    kind: server.kind as Artifact['kind'],
    title: server.title,
    currentVersion: versions()[0]!,
    createdAt: '2026-10-18T10:01:00.000Z',
    updatedAt: `2026-10-18T10:0${server.texts.length}:00.000Z`,
  };
}

beforeEach(() => {
  server.puts = [];
  server.kind = 'document';
  server.title = 'Q3 summary';
  server.mime = 'text/markdown';
  server.texts = ['# Q3\n\nRevenue up.\n', '# Q3\n\nRevenue up 12%.\n'];
  server.handle = async (request) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const content = /\/versions\/(\d+)\/content$/.exec(pathname);
    if (content) {
      const text = server.texts[Number(content[1]) - 1];
      return text === undefined
        ? Response.json({ title: 'Not found' }, { status: 404 })
        : new Response(text, { headers: { 'content-type': server.mime } });
    }
    if (pathname === `/api/v1/artifacts/${ID}/versions`)
      return Response.json({ items: versions() });
    if (pathname === `/api/v1/artifacts/${ID}` && request.method === 'PUT') {
      const body = (await request.json()) as { content: string };
      server.puts.push(body);
      server.texts.push(body.content);
      return Response.json(artifact());
    }
    if (pathname === `/api/v1/artifacts/${ID}`) return Response.json(artifact());
    if (pathname === `/api/v1/bots/${BOT}/artifacts`) return Response.json({ items: [artifact()] });
    if (pathname === '/api/v1/bots') return Response.json({ items: [{ id: BOT, name: 'Grace' }] });
    return Response.json({ title: 'Not found' }, { status: 404 });
  };
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeRealtime() {
  const handlers = new Map<string, Set<(e: WsEvent) => void>>();
  const client = {
    on(type: string, handler: (e: WsEvent) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => handlers.get(type)!.delete(handler);
    },
  } as unknown as WsClient;
  const realtime: Realtime = { client, onResync: () => () => {} };
  const emit = (type: string, payload: unknown) =>
    act(() => {
      for (const h of handlers.get(type) ?? []) h({ type, ts: 0, bot_id: BOT, payload } as WsEvent);
    });
  return { realtime, emit };
}

let root: Root | undefined;
let host: HTMLElement;
let live: ReturnType<typeof fakeRealtime>;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  localStorage.clear();
});

function Slot() {
  const { content } = useRightPanel();
  return content ? <aside>{content}</aside> : null;
}

function render(ui: ReactNode) {
  live = fakeRealtime();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <RealtimeContext value={live.realtime}>
          <RightPanelProvider>
            {ui}
            <Slot />
          </RightPanelProvider>
        </RealtimeContext>
      </QueryClientProvider>,
    ),
  );
  return host;
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  if (check()) return;
  throw new Error(`timed out waiting for ${what}: ${host.textContent}`);
}

const button = (label: string, within: ParentNode = host) =>
  [...within.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );
const click = (el: HTMLElement | undefined) => act(() => el!.click());

describe('the Artifact card', () => {
  it('shows the posted version, follows artifact.updated, and opens the viewer', () => {
    const onOpen = vi.fn();
    render(
      <ArtifactPart
        part={{ artifact_id: ID, title: 'Q3 summary', kind: 'document', version: 1 }}
        onOpen={onOpen}
      />,
    );
    expect(host.textContent).toContain('Q3 summary');
    expect(host.textContent).toContain('Document · v1');

    live.emit('artifact.updated', { artifactId: 'someone-else', title: 'Other', version: 9 });
    expect(host.textContent).toContain('v1');
    live.emit('artifact.updated', { artifactId: ID, title: 'Q3 report', version: 2 });
    expect(host.textContent).toContain('Q3 report');
    expect(host.textContent).toContain('Document · v2');
    expect(host.querySelector('a[download]')?.getAttribute('href')).toBe(
      `/api/v1/artifacts/${ID}/download?version=2`,
    );

    click(button('Open'));
    expect(onOpen).toHaveBeenCalledWith(ID, 2);
  });
});

describe('<ArtifactViewer>', () => {
  it('renders the current document and switches versions from the history', async () => {
    render(<ArtifactViewer artifactId={ID} />);
    await until(() => !!host.querySelector('h1'), 'the markdown');
    expect(host.textContent).toContain('v2 (current)');
    expect(host.textContent).toContain('Revenue up 12%.');
    expect(host.querySelector('[aria-current="true"]')?.textContent).toContain('v2');

    click(historyRow(1));
    await until(() => host.textContent!.includes('Revenue up.'), 'version 1');
    expect(host.textContent).toContain('v1 of 2');
    expect(button('Edit')).toBeUndefined();
    expect(host.querySelector('a[download]')?.getAttribute('href')).toBe(
      `/api/v1/artifacts/${ID}/download?version=1`,
    );
  });

  it('shows a line diff between any two versions', async () => {
    render(<ArtifactViewer artifactId={ID} />);
    await until(() => !!button('Compare'), 'the toolbar');
    click(button('Compare'));
    await until(() => !!host.querySelector('[data-diff]'), 'the diff');
    expect(host.querySelector('pre')?.getAttribute('aria-label')).toBe('Changes from v1 to v2');
    expect(lines('removed')).toEqual(['- Revenue up.']);
    expect(lines('added')).toEqual(['+ Revenue up 12%.']);

    const to = host.querySelector<HTMLSelectElement>('select[aria-label="Compare to"]')!;
    act(() => {
      to.value = '1';
      to.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => host.textContent!.includes('No differences.'), 'v1 against itself');
  });

  it('saves an edit as a new version attributed to the user', async () => {
    render(<ArtifactViewer artifactId={ID} />);
    await until(() => !!button('Edit'), 'the toolbar');
    click(button('Edit'));
    await until(() => !!host.querySelector('.cm-content'), 'the editor');
    expect(button('Save')!.disabled).toBe(true);

    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\nCosts flat.\n' } });
    });
    expect(button('Save')!.disabled).toBe(false);
    click(button('Save'));

    await until(() => host.textContent!.includes('v3 (current)'), 'the saved version');
    expect(server.puts).toEqual([
      { content: '# Q3\n\nRevenue up 12%.\n\nCosts flat.\n', baseVersion: 2 },
    ]);
    expect(byline(3)).toBe('Edited by you');
    expect(byline(2)).toBe('By Grace · Run activity log');
    expect(host.textContent).toContain('Costs flat.');
    expect(host.querySelector('.cm-editor')).toBeNull();
  });

  it('names the Bot and opens the run that made a version (A1)', async () => {
    render(<ArtifactViewer artifactId={ID} />);
    await until(() => byline(2) === 'By Grace · Run activity log', 'the history');
    expect(byline(1)).toBe('By Grace · Run activity log');
    click(button('Run activity log', host.querySelector('li[data-version="2"]')!));
    expect(readPanel(BOT)).toEqual({
      kind: 'activity',
      runId: '00000000-0000-4000-8000-0000000000f1',
    });
  });

  it('reapplies an edit onto the version the Bot saved meanwhile (A2)', async () => {
    server.texts = ['# Q3\n\nRevenue up.\n\nCosts flat.\n\nOutlook steady.\n'];
    const put = server.handle;
    let conflicts = 1;
    server.handle = async (request) => {
      if (request.method === 'PUT' && conflicts-- > 0) {
        // The Bot saved v2 while the owner was editing v1.
        server.texts.push('# Q3\n\nRevenue up.\n\nCosts flat.\n\nOutlook strong.\n');
        return Response.json(
          { title: 'Conflict', code: 'VERSION_CONFLICT', detail: 'The Artifact is at version 2' },
          { status: 409 },
        );
      }
      return put(request);
    };
    render(<ArtifactViewer artifactId={ID} />);
    await until(() => !!button('Edit'), 'the toolbar');
    click(button('Edit'));
    await until(() => !!host.querySelector('.cm-content'), 'the editor');
    edit((text) => text.replace('Revenue up.', 'Revenue up 12%.'));
    click(button('Save'));
    await until(() => !!button('Reapply my changes'), 'the conflict');
    expect(host.textContent).toContain('A newer version was saved while you were editing v1.');
    click(button('Reapply my changes'));
    await until(() => !!host.querySelector('[data-rebased="2"]'), 'the reapplied edit');
    click(button('Save'));
    await until(() => host.textContent!.includes('v3 (current)'), 'the saved version');
    expect(server.puts).toEqual([
      {
        content: '# Q3\n\nRevenue up 12%.\n\nCosts flat.\n\nOutlook strong.\n',
        baseVersion: 2,
      },
    ]);
  });

  it('saves the owner’s text as the newest version when the edits overlap (A2)', async () => {
    server.texts = ['# Q3\n\nRevenue up.\n'];
    const put = server.handle;
    let conflicts = 1;
    server.handle = async (request) => {
      if (request.method === 'PUT' && conflicts-- > 0) {
        server.texts.push('# Q3\n\nRevenue down.\n');
        return Response.json({ title: 'Conflict', code: 'VERSION_CONFLICT' }, { status: 409 });
      }
      return put(request);
    };
    render(<ArtifactViewer artifactId={ID} />);
    await until(() => !!button('Edit'), 'the toolbar');
    click(button('Edit'));
    await until(() => !!host.querySelector('.cm-content'), 'the editor');
    edit((text) => text.replace('Revenue up.', 'Revenue up 12%.'));
    click(button('Save'));
    await until(() => !!button('Reapply my changes'), 'the conflict');
    click(button('Reapply my changes'));
    await until(() => host.textContent!.includes('cannot be reapplied'), 'the overlap');
    expect(button('Reapply my changes')).toBeUndefined();
    click(button('Save mine as newest'));
    await until(() => host.textContent!.includes('v3 (current)'), 'the saved version');
    expect(server.puts).toEqual([{ content: '# Q3\n\nRevenue up 12%.\n', baseVersion: 2 }]);
    // The Bot's version stays in the history.
    expect(historyRow(2)).toBeDefined();
  });

  it('shows CSV and JSON data as a table and code in CodeMirror', async () => {
    server.kind = 'data';
    server.mime = 'text/csv';
    server.title = 'Sales';
    server.texts = ['region,total\nEMEA,12\n"North, America",30\n'];
    render(<ArtifactViewer artifactId={ID} />);
    await until(() => !!host.querySelector('table'), 'the table');
    expect([...host.querySelectorAll('th')].map((th) => th.textContent)).toEqual([
      'region',
      'total',
    ]);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
    act(() => root!.unmount());

    server.kind = 'code';
    server.mime = 'text/x-python';
    server.title = 'report.py';
    server.texts = ['print("hi")\n'];
    render(<ArtifactViewer artifactId={ID} />);
    await until(() => !!host.querySelector('.cm-content'), 'the code view');
    expect(host.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    expect(host.textContent).toContain('print("hi")');
  });
});

describe('<ArtifactViewer> with binary versions', () => {
  it('shows an image through <img> with no editing or diff', async () => {
    server.kind = 'design';
    server.mime = 'image/png';
    server.title = 'Logo.png';
    server.texts = ['png v1', 'png v2'];
    render(<ArtifactViewer artifactId={ID} />);
    await until(() => !!host.querySelector('img'), 'the image');
    expect(host.querySelector('img')?.getAttribute('src')).toBe(
      `/api/v1/artifacts/${ID}/versions/2/content`,
    );
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('Logo.png');
    expect(button('Edit')).toBeUndefined();
    expect(button('Compare')).toBeUndefined();
    expect(host.querySelector('a[download]')?.getAttribute('href')).toBe(
      `/api/v1/artifacts/${ID}/download?version=2`,
    );
  });

  it("shows a PDF in the browser's viewer over a blob URL", async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf-preview');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      server.kind = 'file';
      server.mime = 'application/pdf';
      server.title = 'Q3 deck.pdf';
      server.texts = ['%PDF-1.7'];
      render(<ArtifactViewer artifactId={ID} />);
      await until(() => !!host.querySelector('iframe'), 'the PDF preview');
      expect(host.querySelector('iframe')?.getAttribute('src')).toBe('blob:pdf-preview');
      expect(created).toHaveBeenCalledWith(expect.any(Blob));
      expect(button('Edit')).toBeUndefined();
      act(() => root!.unmount());
      root = undefined;
      expect(revoked).toHaveBeenCalledWith('blob:pdf-preview');
    } finally {
      created.mockRestore();
      revoked.mockRestore();
    }
  });

  it('previews a text version of a file as text (A2)', async () => {
    server.kind = 'file';
    server.mime = 'text/plain';
    server.title = 'build.log';
    server.texts = ['step 1 ok\nstep 2 failed\n'];
    render(<ArtifactViewer artifactId={ID} />);
    await until(() => !!host.querySelector('.cm-content'), 'the text');
    expect(host.textContent).toContain('step 2 failed');
    expect(host.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    expect(host.textContent).not.toContain('No preview');
    // Files are not edited inline; only the text kinds are.
    expect(button('Edit')).toBeUndefined();
  });

  it('offers a download for other binary files', async () => {
    server.kind = 'file';
    server.mime = 'application/zip';
    server.title = 'site.zip';
    server.texts = ['x'.repeat(1536)];
    render(<ArtifactViewer artifactId={ID} />);
    await until(() => host.textContent!.includes('No preview'), 'the placeholder');
    expect(host.textContent).toContain(
      'No preview for this file (1.5 KB). Download it to open it.',
    );
    expect(button('Edit')).toBeUndefined();
  });
});

describe('the Bot Artifacts tab', () => {
  it('lists what the Bot produced and opens one in the right panel', async () => {
    render(<ArtifactsTab botId={BOT} />);
    await until(() => !!host.querySelector('li button'), 'the list');
    const row = host.querySelector<HTMLButtonElement>('li button')!;
    expect(row.textContent).toContain('Q3 summary');
    expect(row.textContent).toContain('Document');
    expect(row.textContent).toContain('2 versions');

    click(row);
    await until(() => !!host.querySelector('aside h3'), 'the viewer');
    expect(host.querySelector('aside h2')?.textContent).toBe('Artifact');
    expect(readPanel(BOT)).toEqual({ kind: 'artifact', artifactId: ID });

    server.texts.push('# Q3\n\nRevenue up 14%.\n');
    live.emit('artifact.updated', { artifactId: ID, title: 'Q3 summary', version: 3 });
    await until(() => row.textContent!.includes('3 versions'), 'the refreshed list');
  });

  it('remembers the viewer per Bot without a pinned version', () => {
    writePanel(BOT, { kind: 'artifact', artifactId: ID, version: 1 });
    expect(readPanel(BOT)).toEqual({ kind: 'artifact', artifactId: ID });
  });
});

describe('parseTable', () => {
  it('reads quoted CSV fields', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\r\n1,\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['1', ''],
    ]);
  });

  it('reads JSON arrays of objects, arrays of arrays and one object', () => {
    expect(parseTable('[{"a":1},{"b":{"c":2}}]', 'application/json')).toEqual({
      columns: ['a', 'b'],
      rows: [
        ['1', ''],
        ['', '{"c":2}'],
      ],
    });
    expect(parseTable('[[1,2],[3]]', 'application/json')).toEqual({
      columns: ['1', '2'],
      rows: [
        ['1', '2'],
        ['3', ''],
      ],
    });
    expect(parseTable('{"k":"v"}', 'application/json')?.rows).toEqual([['k', 'v']]);
    expect(parseTable('"text"', 'application/json')).toBeNull();
    expect(parseTable('not json', 'application/json')).toBeNull();
  });
});

/** Who made version `n`, under its row in the history. */
function byline(n: number) {
  return host.querySelector(`li[data-version="${n}"] > span`)?.textContent;
}

function historyRow(n: number) {
  return [...host.querySelectorAll<HTMLButtonElement>('ol button')].find((b) =>
    b.textContent!.startsWith(`v${n}`),
  )!;
}

/** Replaces the editor's text through CodeMirror, as typing would. */
function edit(change: (text: string) => string) {
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
  const text = view.state.doc.toString();
  act(() => {
    view.dispatch({ changes: { from: 0, to: text.length, insert: change(text) } });
  });
}

function lines(type: string) {
  return [...host.querySelectorAll(`[data-diff="${type}"]`)].map((el) => el.textContent);
}
