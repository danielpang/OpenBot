// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_CLASH } from '../stack/error-parts.js';
import { fakeBridge, local, running, work } from './fake-bridge.js';
import { createStartFlow } from './start-flow.js';
import { StartPage } from './start-page.js';

// The start page's views over their flow (plan 14.4): the welcome screen's
// three choices and each state of "Run OpenBots on this Mac", and This Mac's
// controls on the status page.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function show(bridge: ReturnType<typeof fakeBridge>, query: string) {
  const flow = createStartFlow(bridge, new URLSearchParams(query));
  await act(async () => {
    root.render(<StartPage flow={flow} />);
    await flow.start();
  });
  return flow;
}

const $ = (selector: string) => container.querySelector<HTMLElement>(selector);
const text = () => container.textContent ?? '';
const click = (selector: string) =>
  act(async () => {
    $(selector)!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe('the welcome screen', () => {
  it('shows the three choices, the account one plainly unavailable', async () => {
    await show(fakeBridge(), 'welcome=1');
    const titles = [...container.querySelectorAll('h2')].map((h) => h.textContent);
    expect(titles).toEqual([
      'Sign in to an OpenBots account',
      'Connect to a self-hosted server',
      'Run OpenBots on this Mac',
    ]);
    expect($('#cloud-go')).toBeNull();
    expect(text()).toContain('Coming soon');
    expect(text()).toContain('OpenBots accounts are not available yet.');
    // The owner's copy rule: no em or en dashes.
    expect(text()).not.toMatch(/[–—]/);
  });

  it('offers sign in when the build names a hosted server', async () => {
    const bridge = fakeBridge({ cloudUrl: 'https://app.openbots.example' });
    await show(bridge, 'welcome=1');
    await click('#cloud-go');
    expect(bridge.connect.cloud).toHaveBeenCalled();
  });

  it('shows a failed pull with its output behind "Show details"', async () => {
    const bridge = fakeBridge({ status: { ...running, services: [] } });
    bridge.stack.start.mockRejectedValueOnce(
      new Error('Pulling the OpenBots images failed.\nmanifest unknown'),
    );
    await show(bridge, 'welcome=1');
    await click('#local-go');
    expect($('#local-progress')?.textContent).toBe('Pulling the OpenBots images failed.');
    expect($('#local-details')?.tagName).toBe('DETAILS');
    expect($('#local-detail')?.textContent).toBe('manifest unknown');
    expect($('#local-check')).not.toBeNull();
  });

  it('offers "Use port N" when another app took the port', async () => {
    const bridge = fakeBridge({
      status: { ...running, services: [], port: { port: 3000, taken: true, free: 3001 } },
    });
    await show(bridge, 'welcome=1');
    await click('#local-go');
    expect($('#local-port')?.textContent).toBe('Use port 3001');
    await click('#local-port');
    expect(bridge.stack.changePort).toHaveBeenCalled();
  });

  it('offers "Use a separate network" when another stack holds the sandbox network', async () => {
    const bridge = fakeBridge({ status: { ...running, services: [] } });
    bridge.stack.start.mockRejectedValueOnce(
      new Error(`${NETWORK_CLASH}\nfailed to set up container networking: Address already in use`),
    );
    await show(bridge, 'welcome=1');
    await click('#local-go');
    expect($('#local-progress')?.textContent).toBe(NETWORK_CLASH);
    expect($('#local-detail')?.textContent).toBe(
      'failed to set up container networking: Address already in use',
    );
    expect($('#local-network')?.textContent).toBe('Use a separate network');
    await click('#local-network');
    expect(bridge.stack.useOwnNetwork).toHaveBeenCalled();
  });

  it('links to OrbStack and Docker Desktop when Docker is missing', async () => {
    const bridge = fakeBridge({
      status: {
        docker: { state: 'missing', installed: [] },
        services: [],
        upgrade: null,
        port: null,
      },
    });
    await show(bridge, 'welcome=1');
    await click('#local-go');
    const links = [...container.querySelectorAll<HTMLAnchorElement>('#docker-missing a')];
    expect(links.map((a) => a.href)).toEqual([
      'https://orbstack.dev/download',
      'https://www.docker.com/products/docker-desktop/',
    ]);
  });
});

describe('the status page', () => {
  const saved = { activeId: 'local', chosen: true, profiles: [local, work] };

  it('shows This Mac running, with Open and Stop, and the saved connections', async () => {
    await show(fakeBridge({ profiles: saved }), 'profile=local');
    expect($('[data-health]')?.textContent).toBe('Running');
    expect($('#stack-open')).not.toBeNull();
    expect($('#stack-stop')).not.toBeNull();
    expect($('#stack-start')).toBeNull();
    expect($('[aria-current="true"]')?.dataset.profile).toBe('local');
    expect(container.querySelectorAll('#profiles li')).toHaveLength(2);
  });

  it('says why the server did not open, with Try again', async () => {
    const bridge = fakeBridge({ profiles: saved, status: { ...running, services: [] } });
    await show(bridge, 'profile=local&error=ERR_CONNECTION_REFUSED');
    expect($('#error')?.textContent).toContain('Could not open the server: ERR_CONNECTION_REFUSED');
    await click('#retry');
    expect(bridge.profiles.open).toHaveBeenCalledWith('local');
  });

  it('turns a taken port into a notice with "Use port N"', async () => {
    const bridge = fakeBridge({
      profiles: saved,
      status: { ...running, services: [], port: { port: 3000, taken: true, free: 3001 } },
    });
    await show(bridge, 'profile=local');
    expect(text()).toContain('Another app is using port 3000');
    expect($('#stack-port')?.textContent).toBe('Use port 3001');
    expect($('#stack-start')).toBeNull();
  });

  it('offers "Use a separate network" beside a clash on the status page', async () => {
    const bridge = fakeBridge({ status: { ...running, services: [] } });
    bridge.stack.start.mockRejectedValueOnce(new Error(`${NETWORK_CLASH}\nAddress already in use`));
    await show(bridge, 'profile=local');
    await click('#stack-start');
    expect(text()).toContain(NETWORK_CLASH);
    await click('#stack-network');
    expect(bridge.stack.useOwnNetwork).toHaveBeenCalled();
  });

  it('shows the logs in a panel', async () => {
    await show(fakeBridge({ profiles: saved }), 'profile=local&logs=1');
    expect($('#logs')?.textContent).toBe('openbots-1 | listening\npostgres-1 | ready');
    expect($('#stack-logs')?.textContent).toBe('Hide logs');
  });
});
