import { createAgentClient, ScreenLocks, type ComputerAgentClient } from '@openbots/computer';
import { startFakeAgent, TINY_PNG, type FakeAgent } from '@openbots/computer/testing';
import { OWNER_HAS_SCREEN, type ArtifactKind, type MessagePart } from '@openbots/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { labelFor } from '../activity/labels.js';
import { createPolicy, defaultPolicy } from '../policy/index.js';
import { executeRun, type ExecuteRunInput, type StepRecord } from '../run/execute.js';
import { injectToolResult } from '../run/state.js';
import { scriptedModel } from '../testing.js';
import { fileText, type ArtifactBody, type ArtifactServices } from './artifacts.js';
import {
  anthropicComputer,
  IMAGE_TOOLS,
  OwnerHasScreen,
  screenshotModelOutput,
  screenshotTranscript,
  type ComputerServices,
} from './computer.js';
import { toolFacts, toolsFor } from './index.js';
import type { AnyAgentTool, ToolContext } from './types.js';

const run = { id: 'run-1', botId: 'bot-1', chatId: 'chat-1', trigger: 'message' };
const memory = {
  remember: async () => ({ id: 'm', kind: 'fact' as const, content: '' }),
  search: async () => [],
};

let agent: FakeAgent;
let client: ComputerAgentClient;
let ownerHasScreen: boolean;
const locks = new ScreenLocks();

const services = (): ComputerServices => ({
  agent: async () => client,
  screen: (fn) =>
    locks.run(run.botId, async () => {
      if (ownerHasScreen) throw new OwnerHasScreen();
      if (!agent.screens.has(0)) await client.startScreen({ n: 0 });
      return fn(0, client);
    }),
  screenFree: async () => {
    if (ownerHasScreen) throw new OwnerHasScreen();
  },
});

function ctx(more: Partial<ToolContext> = {}): ToolContext {
  return { run, memory, computer: services(), ...more };
}

const tools = (c = ctx()) => toolsFor(c);
const call = (name: string, args: unknown, c = ctx()) =>
  (tools(c)[name] as AnyAgentTool).execute(args as never, c);

beforeEach(async () => {
  agent = await startFakeAgent();
  client = createAgentClient({ url: agent.url, token: agent.token });
  ownerHasScreen = false;
});
afterEach(() => agent.close());

describe('computer tools', () => {
  it('are offered only with a computer, in the computer group', () => {
    expect(Object.keys(toolsFor({ run, memory }))).not.toContain('bash');
    expect(Object.keys(tools())).toEqual(
      expect.arrayContaining([
        'bash',
        'read_file',
        'write_file',
        'edit_file',
        'list_dir',
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
        'browser_type',
        'browser_press',
        'browser_screenshot',
        'computer',
      ]),
    );
    expect(toolFacts(ctx()).get('bash')?.group).toBe('computer');
  });

  it('can leave out the screenshot tools for a model without vision (L4)', () => {
    const blind = Object.keys(toolsFor(ctx(), undefined, IMAGE_TOOLS));
    expect(blind).not.toContain('computer');
    expect(blind).not.toContain('browser_screenshot');
    // The text-based browser and file tools stay.
    expect(blind).toEqual(expect.arrayContaining(['bash', 'browser_snapshot', 'browser_click']));
    expect(Object.keys(tools())).toEqual(expect.arrayContaining([...IMAGE_TOOLS]));
  });

  it('ask before bash and file writes, and run reads and screen actions (policy)', () => {
    const facts = toolFacts(ctx());
    const policy = createPolicy({ facts: (n) => facts.get(n) });
    const decide = (tool: string, args: unknown = {}) =>
      (policy.evaluate(run, tool, args) as { decision: string }).decision;
    expect(decide('bash', { command: 'ls' })).toBe('ask');
    expect(decide('write_file', { path: 'a' })).toBe('ask');
    expect(decide('edit_file', { path: 'a' })).toBe('ask');
    for (const tool of [
      'read_file',
      'list_dir',
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_screenshot',
      'computer',
    ]) {
      expect(decide(tool), tool).toBe('auto');
    }
  });

  it('bash runs in /home/bot and returns what the label reads', async () => {
    agent.exec = (req) => ({ stdout: `Tests  212 passed\n`, stderr: req.cwd ?? '', code: 0 });
    const result = await call('bash', { command: 'npm test' });
    expect(result).toEqual({ exitCode: 0, stdout: 'Tests  212 passed\n', stderr: '/home/bot' });
    expect(labelFor('bash', { command: 'npm test' }, result)).toBe('Ran npm test: 212 passed');
    agent.exec = () => ({ stderr: 'x'.repeat(40_000), code: 1 });
    const failed = (await call('bash', { command: 'make', cwd: 'app' })) as { stderr: string };
    expect(failed.stderr.length).toBeLessThan(31_000);
    expect(failed.stderr).toMatch(/^\[10000 characters cut\]/);
    expect(agent.calls.at(-1)).toMatchObject({ body: { cwd: '/home/bot/app' } });
    expect(agent.calls.at(-1)!.body).not.toHaveProperty('screen');
  });

  it("bash runs on the Bot's own screen when it has one, to reach that display only (S-7)", async () => {
    const c = ctx({ computer: { ...services(), screenNumber: async () => 4 } });
    await call('bash', { command: 'xdotool getmouselocation' }, c);
    expect(agent.calls.at(-1)).toMatchObject({
      path: '/exec',
      body: { command: 'xdotool getmouselocation', screen: 4 },
    });
  });

  it('read, write, edit and list files, with labels', async () => {
    expect(await call('write_file', { path: 'src/math.ts', content: 'a\nb\nc\n' })).toEqual({
      path: '/home/bot/src/math.ts',
      size: 6,
      lines: 3,
    });
    expect(await call('read_file', { path: '~/src/math.ts', offset: 2, limit: 1 })).toEqual({
      path: '/home/bot/src/math.ts',
      content: 'b',
      lines: 3,
    });
    const edited = await call('edit_file', {
      path: 'src/math.ts',
      old_string: 'b',
      new_string: 'B\nB2',
    });
    expect(edited).toEqual({
      path: '/home/bot/src/math.ts',
      replacements: 1,
      added: 2,
      removed: 1,
    });
    expect(labelFor('edit_file', { path: 'src/math.ts' }, edited)).toBe('Edited math.ts +2 −1');
    expect(new TextDecoder().decode(agent.files.get('src/math.ts'))).toBe('a\nB\nB2\nc\n');
    await expect(
      call('edit_file', { path: 'src/math.ts', old_string: 'zzz', new_string: '' }),
    ).rejects.toThrow(/not found/);
    await call('write_file', { path: 'twice.txt', content: 'x x' });
    await expect(
      call('edit_file', { path: 'twice.txt', old_string: 'x', new_string: 'y' }),
    ).rejects.toThrow(/2 times/);
    expect(
      await call('edit_file', {
        path: 'twice.txt',
        old_string: 'x',
        new_string: 'y',
        replace_all: true,
      }),
    ).toMatchObject({ replacements: 2 });
    expect(await call('list_dir', {})).toEqual({
      path: '/home/bot',
      entries: [
        { name: 'src', type: 'dir' },
        { name: 'twice.txt', type: 'file', size: 3 },
      ],
    });
    agent.files.set('bin', new Uint8Array([0, 1, 2]));
    await expect(call('read_file', { path: 'bin' })).rejects.toThrow(/binary/);
    expect(labelFor('read_file', { path: 'AGENTS.md' }, {})).toBe('Read AGENTS.md');
    expect(labelFor('write_file', { path: 'a/b.md' })).toBe('Writing b.md');
  });

  it('drive the browser on the Bot screen', async () => {
    expect(await call('browser_navigate', { url: 'https://github.com/login' })).toEqual({
      url: 'https://github.com/login',
      title: 'Title of https://github.com/login',
    });
    const page = (await call('browser_snapshot', {})) as { snapshot: string };
    expect(page.snapshot).toContain('[ref=e2]');
    await call('browser_click', { ref: 'e2', element: 'More link' });
    await call('browser_type', { ref: 'e3', text: 'dana', submit: true });
    await call('browser_press', { key: 'Enter' });
    expect(agent.browser.map((b) => b.action)).toEqual([
      { action: 'navigate', url: 'https://github.com/login' },
      { action: 'snapshot' },
      { action: 'click', ref: 'e2' },
      { action: 'type', ref: 'e3', text: 'dana', submit: true },
      { action: 'press', key: 'Enter' },
    ]);
    expect(agent.screens.get(0)).toMatchObject({ display: ':10', cdpPort: 9222 });
    expect(labelFor('browser_navigate', { url: 'https://github.com/login' }, {})).toBe(
      'Opened github.com',
    );
    expect(labelFor('browser_click', { ref: 'e2', element: 'More link' }, {})).toBe(
      'Clicked More link',
    );
  });

  it('operate the screen in pixel mode', async () => {
    expect(await call('computer', { action: 'click', coordinate: [10, 20] })).toEqual({ ok: true });
    await call('computer', { action: 'type', text: 'hello' });
    await call('computer', { action: 'drag', from: [1, 1], to: [5, 5] });
    expect(agent.inputs.map((i) => i.action)).toEqual([
      { action: 'click', x: 10, y: 20 },
      { action: 'type', text: 'hello' },
      { action: 'drag', from: { x: 1, y: 1 }, to: { x: 5, y: 5 } },
    ]);
    await expect(call('computer', { action: 'click' })).rejects.toThrow();
    expect(labelFor('computer', { action: 'click', coordinate: [10, 20] }, {})).toBe(
      'Clicked at 10, 20',
    );
    expect(labelFor('computer', { action: 'left_click', coordinate: [1, 2] })).toBe(
      'Clicking at 1, 2',
    );
  });

  it('answer that the owner has the screen during a takeover, and touch nothing', async () => {
    ownerHasScreen = true;
    const result = await call('computer', { action: 'click', coordinate: [1, 1] });
    expect(result).toEqual({ status: 'owner_has_screen', message: OWNER_HAS_SCREEN });
    expect(await call('browser_navigate', { url: 'https://x.test' })).toEqual(result);
    expect(agent.inputs).toEqual([]);
    expect(agent.browser).toEqual([]);
    expect(labelFor('computer', {}, result)).toBe('Waiting: the owner has the screen');
    // Files are not on the screen: they keep working.
    expect(await call('list_dir', {})).toMatchObject({ path: '/home/bot' });
  });

  it('hold bash while the owner has the screen, since a command can drive it too (S-7)', async () => {
    let runs = 0;
    agent.exec = () => {
      runs++;
      return { stdout: '', exitCode: 0 };
    };
    ownerHasScreen = true;
    const held = await call('bash', { command: 'DISPLAY=:10 xdotool click 1' });
    expect(held).toEqual({ status: 'owner_has_screen', message: OWNER_HAS_SCREEN });
    expect(runs).toBe(0);
    expect(labelFor('bash', { command: 'xdotool click 1' }, held)).toBe(
      'Waiting: the owner has the screen',
    );
    ownerHasScreen = false;
    expect(await call('bash', { command: 'true' })).toMatchObject({ exitCode: 0 });
    expect(runs).toBe(1);
  });

  it('take one screen action at a time per Bot (K2)', async () => {
    let inFlight = 0;
    let most = 0;
    const slow = async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
    };
    const c = ctx({
      computer: {
        agent: async () => client,
        screen: (fn) => locks.run(run.botId, async () => (await slow(), fn(0, client))),
        screenFree: async () => {},
      },
    });
    await client.startScreen({ n: 0 });
    await Promise.all([
      call('computer', { action: 'move', coordinate: [1, 1] }, c),
      call('computer', { action: 'move', coordinate: [2, 2] }, c),
      call('browser_press', { key: 'a' }, c),
    ]);
    expect(most).toBe(1);
  });
});

describe('screenshots', () => {
  it('go to the model as an image part and to the transcript without their bytes', async () => {
    const shot = await call('computer', { action: 'screenshot' });
    expect(shot).toMatchObject({ type: 'screenshot', mediaType: 'image/png', width: 1, height: 1 });
    expect(screenshotModelOutput(shot)).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'Screenshot, 1x1' },
        {
          type: 'file',
          mediaType: 'image/png',
          data: { type: 'data', data: Buffer.from(TINY_PNG).toString('base64') },
        },
      ],
    });
    expect(screenshotTranscript(shot)).toEqual({
      type: 'screenshot',
      mediaType: 'image/png',
      width: 1,
      height: 1,
      bytes: TINY_PNG.byteLength,
    });
    // Anything else is left to the default framing.
    expect(screenshotModelOutput({ ok: true })).toBeUndefined();
  });

  it('reach the model through the loop as images; the transcript and log keep no base64', async () => {
    const parts: MessagePart[] = [];
    const steps: StepRecord[] = [];
    const states: [string, string | null, string | null | undefined][] = [];
    const model = scriptedModel([
      [{ tool: 'browser_screenshot', args: {}, id: 's1' }],
      [{ text: 'I see the page.' }],
    ]);
    const c = ctx();
    await executeRun({
      run,
      model,
      instructions: 'test',
      messages: [{ role: 'user', content: 'look' }],
      tools: toolsFor(c),
      toolContext: c,
      policy: defaultPolicy,
      abortSignal: new AbortController().signal,
      sink: {
        text: async () => {},
        reasoning: async () => {},
        part: async (p) => parts.push(p) - 1,
      },
      setState: async (s, label, tool) => {
        states.push([s, label, tool]);
      },
      recordStep: async (s) => {
        steps.push(s);
      },
      drainSteering: async () => [],
    });
    const base64 = Buffer.from(TINY_PNG).toString('base64');
    const toolMessage = model.calls[1]!.prompt.find((m) => m.role === 'tool')!;
    expect(JSON.stringify(toolMessage.content)).toContain(base64);
    expect(JSON.stringify(toolMessage.content)).toContain('image/png');
    expect(JSON.stringify(parts)).not.toContain(base64);
    expect(JSON.stringify(steps)).not.toContain(base64);
    expect(parts.find((p) => p.type === 'tool_result')).toMatchObject({
      result: { type: 'screenshot', width: 1, height: 1 },
      label: 'Took screenshot',
    });
    // The working state names the tool, which lights the title-bar computer icon (I5).
    expect(states[0]).toEqual(['working', 'Taking screenshot', 'browser_screenshot']);
  });

  it('are re-encoded as images when a paused call is resumed', () => {
    const messages = [
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'c1',
            toolName: 'computer',
            output: { type: 'json' as const, value: { status: 'waiting_for_owner' } },
          },
        ],
      },
    ];
    const shot = { type: 'screenshot', mediaType: 'image/png', data: 'AAAA', width: 1, height: 1 };
    const [message] = injectToolResult(messages, 'c1', shot, screenshotModelOutput);
    expect(JSON.stringify(message)).toContain('"type":"file"');
  });
});

describe('Anthropic native computer use', () => {
  it('is used for Anthropic models that have it, and nowhere else', () => {
    const native = (providerKind: string, modelId: string, protocol = 'native') =>
      anthropicComputer({ providerKind, protocol, modelId });
    expect(native('openai', 'gpt-5')).toBeUndefined();
    expect(native('anthropic', 'claude-opus-5-5', 'anthropic_compatible')).toBeUndefined();
    expect(native('anthropic', 'some-unknown-model')).toBeUndefined();
    const ids = (id: string) =>
      (native('anthropic', id)!.create({ execute: async () => ({}) }) as { id: string }).id;
    expect(ids('claude-opus-5-5')).toBe('anthropic.computer_toolset_20260801');
    expect(ids('claude-sonnet-4-6')).toBe('anthropic.computer_20251124');
    expect(ids('claude-haiku-4-5')).toBe('anthropic.computer_20250124');
    expect(
      native('anthropic', 'claude-opus-5-5')!.toArgs({ action: 'left_click', coordinate: [3, 4] }),
    ).toEqual({
      action: 'click',
      coordinate: [3, 4],
    });
  });

  it('replaces the function tool in the loop, and native calls run as plan actions', async () => {
    const model = scriptedModel([
      [{ tool: 'computer', args: { action: 'left_click', coordinate: [7, 8] }, id: 'n1' }],
      [{ text: 'Clicked.' }],
    ]);
    const c = ctx();
    await client.startScreen({ n: 0 });
    const input: ExecuteRunInput = {
      run,
      model,
      instructions: 'test',
      messages: [{ role: 'user', content: 'click it' }],
      tools: toolsFor(c),
      toolContext: c,
      policy: defaultPolicy,
      target: { providerKind: 'anthropic', protocol: 'native', modelId: 'claude-opus-5-5' },
      abortSignal: new AbortController().signal,
      sink: { text: async () => {}, reasoning: async () => {}, part: async () => 0 },
      setState: async () => {},
      recordStep: async () => {},
      drainSteering: async () => [],
    };
    await executeRun(input);
    const offered = model.calls[0]!.tools!.find((t) => t.name === 'computer')!;
    expect(offered).toMatchObject({ type: 'provider', id: 'anthropic.computer_toolset_20260801' });
    expect(model.calls[0]!.tools!.find((t) => t.name === 'bash')).toMatchObject({
      type: 'function',
    });
    expect(agent.inputs).toEqual([{ n: 0, action: { action: 'click', x: 7, y: 8 } }]);
  });
});

describe('artifacts and the computer (A3)', () => {
  function artifacts(limit?: number) {
    const stored = new Map<
      string,
      { title: string; kind: ArtifactKind; body: ArtifactBody; version: number }
    >();
    const bytesOf = (body: ArtifactBody) =>
      'bytes' in body ? body.bytes : new TextEncoder().encode(body.content);
    const services: ArtifactServices = {
      async create({ title, kind, ...body }) {
        const id = `art-${stored.size + 1}`;
        stored.set(id, { title, kind, body, version: 1 });
        return { artifact_id: id, title, kind, version: 1 };
      },
      async update(id, change) {
        const a = stored.get(id)!;
        if (!('patch' in change)) a.body = change;
        a.version++;
        return { artifact_id: id, title: a.title, kind: a.kind, version: a.version };
      },
      async read(id) {
        const a = stored.get(id)!;
        return {
          artifact_id: id,
          title: a.title,
          kind: a.kind,
          version: a.version,
          current_version: a.version,
          mime: 'text/markdown',
          size: bytesOf(a.body).byteLength,
          ...('content' in a.body ? { content: a.body.content } : {}),
        };
      },
      async readBytes(id) {
        const a = stored.get(id)!;
        const mime = 'bytes' in a.body ? 'image/png' : 'text/markdown';
        return {
          artifact_id: id,
          title: a.title,
          kind: a.kind,
          version: a.version,
          mime,
          bytes: bytesOf(a.body),
        };
      },
      ...(limit !== undefined ? { byteLimit: async () => limit } : {}),
    };
    return { services, stored };
  }

  it('publish a computer file as an Artifact or a new version, and copy one back', async () => {
    const { services, stored } = artifacts();
    const c = ctx({ artifacts: services });
    agent.files.set('report.md', new TextEncoder().encode('# Report'));
    const published = await call('publish_artifact', { path: 'report.md' }, c);
    expect(published).toEqual({
      created: true,
      path: '/home/bot/report.md',
      artifact_id: 'art-1',
      title: 'report.md',
      kind: 'document',
      version: 1,
    });
    expect(stored.get('art-1')!.body).toEqual({ content: '# Report' });

    agent.files.set('report.md', new TextEncoder().encode('# Report v2'));
    expect(await call('publish_artifact', { path: 'report.md', id: 'art-1' }, c)).toMatchObject({
      updated: true,
      version: 2,
    });

    expect(await call('artifact_to_computer', { id: 'art-1', path: 'copy/report.md' }, c)).toEqual({
      copied: true,
      path: '/home/bot/copy/report.md',
      size: 11,
      artifact_id: 'art-1',
      title: 'report.md',
      version: 2,
    });
    expect(new TextDecoder().decode(agent.files.get('copy/report.md'))).toBe('# Report v2');

    agent.files.set('main.py', new TextEncoder().encode('print(1)'));
    expect(await call('publish_artifact', { path: 'main.py' }, c)).toMatchObject({ kind: 'code' });
  });

  it('publish binary files as bytes and copy them back unchanged', async () => {
    const { services, stored } = artifacts();
    const c = ctx({ artifacts: services });
    agent.files.set('photo.png', TINY_PNG);
    expect(await call('publish_artifact', { path: 'photo.png' }, c)).toMatchObject({
      created: true,
      artifact_id: 'art-1',
      title: 'photo.png',
      kind: 'design',
    });
    expect(stored.get('art-1')!.body).toEqual({ bytes: TINY_PNG });

    const pdf = Uint8Array.from([...new TextEncoder().encode('%PDF-1.7\n'), 0xe2, 0xe3, 0x00]);
    agent.files.set('out/report.pdf', pdf);
    expect(await call('publish_artifact', { path: 'out/report.pdf' }, c)).toMatchObject({
      kind: 'file',
    });
    expect(stored.get('art-2')!.body).toEqual({ bytes: pdf });

    // Bytes named like data are still a file, not a data Artifact.
    agent.files.set('dump.json', Uint8Array.from([0x7b, 0x00, 0x7d]));
    expect(await call('publish_artifact', { path: 'dump.json' }, c)).toMatchObject({
      kind: 'file',
    });

    expect(await call('artifact_to_computer', { id: 'art-1', path: 'back.png' }, c)).toMatchObject({
      copied: true,
      size: TINY_PNG.byteLength,
    });
    expect(agent.files.get('back.png')).toEqual(TINY_PNG);
  });

  it('refuse a file over the upload limit', async () => {
    const c = ctx({ artifacts: artifacts(16).services });
    agent.files.set('big.png', new Uint8Array(17));
    await expect(call('publish_artifact', { path: 'big.png' }, c)).rejects.toThrow(
      /too large to publish \(over 16 bytes\)/,
    );
    agent.files.set('ok.png', new Uint8Array(16));
    expect(await call('publish_artifact', { path: 'ok.png' }, c)).toMatchObject({ created: true });
  });

  it('tell text from binary content', () => {
    const text = new TextEncoder().encode('héllo');
    expect(fileText('a.txt', text)).toBe('héllo');
    expect(fileText('a.pdf', text)).toBeNull();
    expect(fileText('a.txt', Uint8Array.from([0x68, 0x00]))).toBeNull();
    expect(fileText('a.txt', Uint8Array.from([0xff, 0xfe, 0x41]))).toBeNull();
  });
});
