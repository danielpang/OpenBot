import { MockEmbeddingModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { scriptedModel } from '../testing.js';
import {
  EMBEDDING_DIMENSIONS,
  embedderFor,
  localEmbedder,
  localEmbedding,
  modelEmbedder,
} from './embed.js';
import { extractMemories, parseExtracted } from './extract.js';

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);

describe('local embedding fallback', () => {
  it('is deterministic, normalized and 1536 wide', async () => {
    const a = localEmbedding('Dana prefers short answers');
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(a).toEqual(localEmbedding('Dana prefers short answers'));
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
    const { source, vectors } = await localEmbedder.embed(['x', 'y']);
    expect(source).toBe('local');
    expect(vectors).toHaveLength(2);
    expect(localEmbedding('')).toEqual(new Array(EMBEDDING_DIMENSIONS).fill(0));
  });

  it('ranks texts sharing words above unrelated ones', () => {
    const query = localEmbedding('when do we ship releases');
    const related = localEmbedding('The team ships releases on Thursdays');
    const unrelated = localEmbedding('Dana likes green tea');
    expect(dot(query, related)).toBeGreaterThan(dot(query, unrelated));
  });
});

describe('embedding sources (M1)', () => {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0.5);

  it('names the model as the source when it answers, and `local` when it fails', async () => {
    const working = modelEmbedder(
      'openai:text-embedding-3-small',
      new MockEmbeddingModelV4({ doEmbed: { embeddings: [vector], warnings: [] } }),
    );
    expect(await working.embed(['a'])).toEqual({
      source: 'openai:text-embedding-3-small',
      vectors: [vector],
    });

    const errors: unknown[] = [];
    const failing = modelEmbedder(
      'openai:text-embedding-3-small',
      new MockEmbeddingModelV4({
        doEmbed: async () => {
          throw new Error('quota');
        },
      }),
      (error) => errors.push(error),
    );
    expect(failing.id).toBe('openai:text-embedding-3-small');
    const fallback = await failing.embed(['a']);
    expect(fallback.source).toBe('local');
    expect(fallback.vectors).toEqual([localEmbedding('a')]);
    expect(errors).toHaveLength(1);
  });

  it('aims for OpenAI only with a key, else the local source', () => {
    const openai = { kind: 'openai', slug: 'openai', apiKey: 'sk-test' } as Parameters<
      typeof embedderFor
    >[0];
    expect(embedderFor(openai).id).toBe('openai:text-embedding-3-small');
    expect(embedderFor({ ...openai!, apiKey: '' }).id).toBe('local');
    expect(embedderFor(null).id).toBe('local');
  });
});

describe('memory extraction', () => {
  it('parses at most three new items from a reply', () => {
    const reply = `Here you go:
[{"kind":"preference","content":"Prefers tabs"},{"kind":"fact","content":"Deploys on db-2"},
 {"kind":"summary","content":"Drafted the outline"},{"kind":"fact","content":"Fourth"},
 {"kind":"fact","content":"prefers  TABS"}]`;
    expect(parseExtracted(reply, ['prefers tabs'])).toEqual([
      { kind: 'fact', content: 'Deploys on db-2' },
      { kind: 'summary', content: 'Drafted the outline' },
      { kind: 'fact', content: 'Fourth' },
    ]);
    expect(parseExtracted('nothing to remember')).toEqual([]);
    expect(parseExtracted('[{"kind":"mood","content":"happy today"}]')).toEqual([]);
  });

  it('asks the small model and returns its items', async () => {
    const model = scriptedModel([[{ text: '[{"kind":"preference","content":"Likes brevity"}]' }]]);
    const items = await extractMemories({
      model,
      transcript: ['[@dana (owner)] keep it short please'],
      existing: [],
    });
    expect(items).toEqual([{ kind: 'preference', content: 'Likes brevity' }]);
  });
});
