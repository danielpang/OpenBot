import type { MessagePart } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { labelFor } from '../activity/labels.js';
import { createPolicy, defaultPolicy } from '../policy/index.js';
import { executeRun, type StepRecord } from '../run/execute.js';
import { scriptedModel } from '../testing.js';
import {
  artifactCardPart,
  COMPUTER_UNAVAILABLE,
  updateArtifact,
  type ArtifactServices,
  type ArtifactWrite,
} from './artifacts.js';
import { toolFacts, toolsFor } from './index.js';
import type { ToolContext } from './types.js';

const run = { id: 'run-1', botId: 'bot-1', chatId: 'chat-1', trigger: 'message' };
const memory = {
  remember: async () => ({ id: 'm', kind: 'fact' as const, content: '' }),
  search: async () => [],
};

/** Artifacts in memory; updates by patch report a fixed diff. */
function fakeArtifacts() {
  const versions = new Map<string, { title: string; content: string[] }>();
  const writes: ArtifactWrite[] = [];
  const services: ArtifactServices = {
    async create({ title, kind, ...body }) {
      const id = `art-${versions.size + 1}`;
      versions.set(id, { title, content: ['content' in body ? body.content : '(bytes)'] });
      const written = { artifact_id: id, title, kind, version: 1 };
      writes.push(written);
      return written;
    },
    async update(id, change) {
      const a = versions.get(id);
      if (!a) throw new Error('Artifact not found');
      a.content.push(
        'content' in change
          ? change.content
          : 'patch' in change
            ? `patched: ${change.patch}`
            : '(bytes)',
      );
      const written = {
        artifact_id: id,
        title: a.title,
        kind: 'document' as const,
        version: a.content.length,
        added: 14,
        removed: 10,
      };
      writes.push(written);
      return written;
    },
    async read(id, version) {
      const a = versions.get(id);
      if (!a) throw new Error('Artifact not found');
      const v = version ?? a.content.length;
      return {
        artifact_id: id,
        title: a.title,
        kind: 'document',
        version: v,
        current_version: a.content.length,
        mime: 'text/markdown',
        size: a.content[v - 1]!.length,
        content: a.content[v - 1]!,
      };
    },
    async readBytes(id, version) {
      const read = await services.read(id, version);
      return { ...read, bytes: new TextEncoder().encode(read.content) };
    },
  };
  return { services, writes };
}

const ctx = (artifacts?: ArtifactServices): ToolContext => ({
  run,
  memory,
  ...(artifacts ? { artifacts } : {}),
});

async function drive(c: ToolContext, script: Parameters<typeof scriptedModel>[0]) {
  const parts: MessagePart[] = [];
  const steps: StepRecord[] = [];
  await executeRun({
    run,
    model: scriptedModel(script),
    instructions: 'test',
    messages: [{ role: 'user', content: 'write it up' }],
    tools: toolsFor(c),
    toolContext: c,
    policy: defaultPolicy,
    abortSignal: new AbortController().signal,
    sink: {
      text: async () => {},
      reasoning: async () => {},
      part: async (p) => parts.push(p) - 1,
    },
    setState: async () => {},
    recordStep: async (s) => {
      steps.push(s);
    },
    drainSteering: async () => [],
  });
  return { parts, steps };
}

describe('artifact tools', () => {
  it('are offered only with an artifact backend', () => {
    expect(Object.keys(toolsFor(ctx()))).not.toContain('create_artifact');
    expect(Object.keys(toolsFor(ctx(fakeArtifacts().services)))).toEqual(
      expect.arrayContaining([
        'create_artifact',
        'update_artifact',
        'read_artifact',
        'publish_artifact',
        'artifact_to_computer',
      ]),
    );
  });

  it('run without asking: they only write OpenBots storage', () => {
    const facts = toolFacts(ctx(fakeArtifacts().services));
    const policy = createPolicy({ facts: (n) => facts.get(n) });
    for (const tool of [
      'create_artifact',
      'update_artifact',
      'read_artifact',
      'publish_artifact',
      'artifact_to_computer',
    ]) {
      expect(facts.get(tool)?.group).toBe('artifacts');
      expect((policy.evaluate(run, tool, {}) as { decision: string }).decision).toBe('auto');
    }
  });

  it('post a card after each create and update, with activity labels', async () => {
    const { services, writes } = fakeArtifacts();
    const { parts, steps } = await drive(ctx(services), [
      [
        {
          tool: 'create_artifact',
          args: { title: 'Q3 summary', kind: 'document', content: '# Q3' },
          id: 'c1',
        },
      ],
      [
        {
          tool: 'update_artifact',
          args: { id: 'art-1', patch: '@@ -1 +1 @@\n-a\n+b\n' },
          id: 'u1',
        },
      ],
      [{ tool: 'read_artifact', args: { id: 'art-1', version: 1 }, id: 'r1' }],
      [{ text: 'Done.' }],
    ]);
    expect(writes.map((w) => w.version)).toEqual([1, 2]);
    expect(parts.map((p) => p.type)).toEqual([
      'tool_call',
      'tool_result',
      'artifact',
      'tool_call',
      'tool_result',
      'artifact',
      'tool_call',
      'tool_result',
    ]);
    expect(parts[2]).toEqual({
      type: 'artifact',
      artifact_id: 'art-1',
      title: 'Q3 summary',
      kind: 'document',
      version: 1,
    });
    expect(parts[5]).toMatchObject({ type: 'artifact', artifact_id: 'art-1', version: 2 });
    expect((parts[7] as { result: { content: string } }).result.content).toBe('# Q3');
    expect(steps.filter((s) => s.type === 'tool_call').map((s) => s.label)).toEqual([
      'Created "Q3 summary"',
      'Updated "Q3 summary" +14 −10',
      'Read "Q3 summary"',
    ]);
  });

  it('answer the documented error for the computer tools when there is no computer', async () => {
    const { parts } = await drive(ctx(fakeArtifacts().services), [
      [
        { tool: 'publish_artifact', args: { path: '/home/bot/out.pdf' }, id: 'p1' },
        { tool: 'artifact_to_computer', args: { id: 'art-1', path: '/tmp/a.md' }, id: 'p2' },
      ],
      [{ text: 'No computer.' }],
    ]);
    const results = parts.filter((p) => p.type === 'tool_result');
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r).toMatchObject({ is_error: true, result: { error: COMPUTER_UNAVAILABLE } });
    }
    expect(COMPUTER_UNAVAILABLE).toBe('the computer is not available on this install');
    expect(parts.some((p) => p.type === 'artifact')).toBe(false);
  });

  it('take exactly one of content and patch', () => {
    const schema = updateArtifact.inputSchema;
    expect(schema.safeParse({ id: 'a', content: 'x' }).success).toBe(true);
    expect(schema.safeParse({ id: 'a', patch: '@@' }).success).toBe(true);
    expect(schema.safeParse({ id: 'a' }).success).toBe(false);
    expect(schema.safeParse({ id: 'a', content: 'x', patch: '@@' }).success).toBe(false);
  });

  it('make no card for an error or another tool', () => {
    expect(artifactCardPart('update_artifact', { error: 'nope' })).toBeNull();
    expect(artifactCardPart('read_artifact', { artifact_id: 'a', title: 't' })).toBeNull();
  });

  it('label in progress without a title', () => {
    expect(labelFor('update_artifact', { id: 'a' })).toBe('Updating artifact');
    expect(labelFor('update_artifact', { id: 'a' }, { error: true })).toBe('Updated artifact');
    expect(labelFor('publish_artifact', { path: '/x/report.pdf' })).toBe('Publishing report.pdf');
  });
});
