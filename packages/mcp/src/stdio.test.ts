import { afterEach, describe, expect, it } from 'vitest';
import { unprivilegedUser } from './privileges.js';
import { StdioHost, childEnvironment, terminate } from './stdio.js';
import { TEST_STDIO_SERVER } from './testing.js';
import type { McpTool } from './types.js';

const textOf = (result: { content: unknown }) =>
  (result.content as { type: string; text: string }[])[0]!.text;

describe('StdioHost', () => {
  let host: StdioHost | undefined;
  afterEach(async () => {
    await host?.close();
    host = undefined;
  });

  const start = (options: ConstructorParameters<typeof StdioHost>[1] = {}) => {
    host = new StdioHost(
      {
        command: process.execPath,
        args: [TEST_STDIO_SERVER],
        env: { TEST_SECRET: 's3cret' },
        homeKey: 'stdio-test',
      },
      options,
    );
    return host.start();
  };

  it('lists tools, resources and prompts and calls a tool', async () => {
    const snapshot = await start();
    expect(snapshot.server).toEqual({ name: 'openbots-test-stdio', version: '1.0.0' });
    expect(snapshot.tools.map((t) => t.name)).toEqual(['echo', 'whoami', 'grow']);
    const echo = snapshot.tools[0]!;
    expect(echo.title).toBe('Echo');
    expect(echo.annotations).toMatchObject({ readOnlyHint: true });
    expect(echo.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
    });
    expect(snapshot.resources).toEqual([
      { uri: 'test://readme', name: 'readme', title: 'Readme', mimeType: 'text/plain' },
    ]);
    expect(snapshot.prompts).toEqual([{ name: 'greet', description: 'Says hello' }]);

    const result = await host!.callTool('echo', { text: 'hi there' });
    expect(textOf(result)).toBe('hi there');
  });

  it("gives the child only PATH, HOME and the connector's secrets, never the server's", async () => {
    process.env.DATABASE_URL = 'postgres://server-secret';
    process.env.OPENBOTS_MASTER_KEY = 'master-secret';
    try {
      await start();
      const who = JSON.parse(textOf(await host!.callTool('whoami', {}))) as {
        uid: number;
        env: string[];
        secret: string;
        homeWritable: boolean;
      };
      expect(who.secret).toBe('s3cret');
      expect(who.homeWritable).toBe(true);
      expect(who.env).not.toContain('DATABASE_URL');
      expect(who.env).not.toContain('OPENBOTS_MASTER_KEY');
      // Node and the OS may add a few of their own (macOS gives every process
      // __CF_USER_TEXT_ENCODING, a text encoding id); nothing from the parent
      // beyond PATH, HOME and npm's cache.
      const own = [
        'PWD',
        'SHLVL',
        '_',
        ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : []),
      ];
      for (const name of who.env) {
        expect(['PATH', 'HOME', 'npm_config_cache', 'TEST_SECRET', ...own]).toContain(name);
      }
      const dropped = unprivilegedUser();
      if (dropped) expect(who.uid).toBe(dropped.uid);
      else expect(who.uid).toBe(process.getuid?.());
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.OPENBOTS_MASTER_KEY;
    }
  });

  // Runs where this process can switch users: as root, or in the server image
  // under compose. There the child holds no capability (CAP_SETUID would let it
  // become the server's user) and cannot read this process's environment.
  it.skipIf(!unprivilegedUser())(
    "runs the child as another user with no capabilities, out of the server's /proc (S-1)",
    async () => {
      await start();
      const who = JSON.parse(textOf(await host!.callTool('whoami', {}))) as {
        uid: number;
        capEff: string | null;
        parentEnviron: boolean | string;
      };
      expect(who.uid).toBe(unprivilegedUser()!.uid);
      expect(who.uid).not.toBe(process.getuid?.());
      expect(who.capEff).toBe('0000000000000000');
      expect(who.parentEnviron).toBe('EACCES');
    },
  );

  it('builds the child environment from scratch', () => {
    const env = childEnvironment({ command: 'x', args: [], env: { A: '1' } }, '/tmp/h');
    expect(Object.keys(env).sort()).toEqual(['A', 'HOME', 'PATH', 'npm_config_cache']);
    expect(env.npm_config_cache).toBe('/tmp/h/.npm');
  });

  it('reports a new tool list after tools/list_changed', async () => {
    let changed: McpTool[] | undefined;
    const got = new Promise<void>((resolve) => {
      void start({
        onToolsChanged: (tools) => {
          changed = tools;
          resolve();
        },
      }).then(() => host!.callTool('grow', {}));
    });
    await got;
    expect(changed!.map((t) => t.name)).toContain('grown');
  });

  it('fails to start when the command does not exist', async () => {
    host = new StdioHost({ command: '/nonexistent/mcp', args: [], env: {}, user: null });
    await expect(host.start()).rejects.toThrow();
  });
});

describe('terminate (S-1)', () => {
  // A fake child: `send` records each signal and resolves only when the test
  // finishes that signal's helper; `wait` records the grace period.
  function harness(initiallyRunning = true) {
    const events: string[] = [];
    const helpers: (() => void)[] = [];
    let running = initiallyRunning;
    return {
      events,
      exit: () => (running = false),
      finishHelper: () => helpers.shift()!(),
      running: () => {
        events.push(`check:${running}`);
        return running;
      },
      send: (signal: NodeJS.Signals) => {
        events.push(`send:${signal}`);
        return new Promise<void>((resolve) =>
          helpers.push(() => {
            events.push(`done:${signal}`);
            resolve();
          }),
        );
      },
      wait: (ms: number) => {
        events.push(`wait:${ms}`);
        return Promise.resolve();
      },
    };
  }
  const tick = () => new Promise((r) => setImmediate(r));

  it('sends SIGKILL only after the SIGTERM helper finished and the grace period passed', async () => {
    const h = harness();
    const done = terminate(h.running, h.send, h.wait, 50);
    await tick();
    expect(h.events).toEqual(['check:true', 'send:SIGTERM']);
    h.finishHelper();
    await tick();
    expect(h.events).toEqual([
      'check:true',
      'send:SIGTERM',
      'done:SIGTERM',
      'wait:50',
      'check:true',
      'send:SIGKILL',
    ]);
    h.finishHelper();
    await done;
    expect(h.events.at(-1)).toBe('done:SIGKILL');
  });

  it('checks the child right before each signal and sends none once it exited', async () => {
    const gone = harness(false);
    await terminate(gone.running, gone.send, gone.wait);
    expect(gone.events).toEqual(['check:false']);

    const h = harness();
    const done = terminate(h.running, h.send, h.wait, 50);
    await tick();
    h.exit();
    h.finishHelper();
    await done;
    expect(h.events).toEqual([
      'check:true',
      'send:SIGTERM',
      'done:SIGTERM',
      'wait:50',
      'check:false',
    ]);
  });
});
