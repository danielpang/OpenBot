import { createHash } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import type { ProviderConfig } from '@openbots/models';
import { embedMany, type EmbeddingModel } from 'ai';

// Memory embeddings (M1). `bot_memories.embedding` is vector(1536). When the
// workspace has an OpenAI provider with a key, memories are embedded with
// `text-embedding-3-small` at 1536 dimensions. Otherwise, and whenever that
// call fails, a deterministic local embedding is used: signed feature hashing
// of lowercased word unigrams and bigrams into 1536 buckets, L2-normalized.
// It needs no network and no model, gives identical vectors for identical
// text, and puts texts sharing words close together, which is enough to rank
// a Bot's few hundred memories. It does not understand synonyms. Vectors from
// different sources are not comparable, so every result names the source that
// made it (`local` after a fallback too); the server records it on each
// memory, compares a query only with memories of the same source, and
// re-embeds the others in the background.

export const EMBEDDING_DIMENSIONS = 1536;
export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

/** Vectors, and the source that made them: `provider:model` or `local`. */
export interface Embeddings {
  source: string;
  vectors: number[][];
}

export interface Embedder {
  /** The source this embedder aims for: `provider:model` or `local`. */
  readonly id: string;
  /** The vectors; their `source` is `local`, not `id`, when the model call failed. */
  embed(texts: string[]): Promise<Embeddings>;
}

export const LOCAL_EMBEDDING_SOURCE = 'local';

export function localEmbedding(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const features = [...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)];
  for (const feature of features) {
    const digest = createHash('sha256').update(feature).digest();
    const bucket = digest.readUInt32BE(0) % dimensions;
    const sign = digest[4]! & 1 ? 1 : -1;
    // Bigrams count half as much as words.
    vector[bucket]! += sign * (feature.includes(' ') ? 0.5 : 1);
  }
  const norm = Math.hypot(...vector);
  return norm ? vector.map((v) => v / norm) : vector;
}

export const localEmbedder: Embedder = {
  id: LOCAL_EMBEDDING_SOURCE,
  embed: async (texts) => ({
    source: LOCAL_EMBEDDING_SOURCE,
    vectors: texts.map((t) => localEmbedding(t)),
  }),
};

/** Embeds with `model`, falling back to the local embedding when the call fails. */
export function modelEmbedder(
  id: string,
  model: EmbeddingModel,
  onError: (error: unknown) => void = () => {},
): Embedder {
  return {
    id,
    async embed(texts) {
      try {
        const { embeddings } = await embedMany({
          model,
          values: texts,
          dimensions: EMBEDDING_DIMENSIONS,
          maxRetries: 2,
        });
        return { source: id, vectors: embeddings.map((e) => e.slice(0, EMBEDDING_DIMENSIONS)) };
      } catch (error) {
        onError(error);
        return localEmbedder.embed(texts);
      }
    },
  };
}

/** The provider's embedding model when it has one we can call, else the local fallback. */
export function embedderFor(
  provider: ProviderConfig | null,
  onError?: (error: unknown) => void,
): Embedder {
  if (provider?.kind === 'openai' && provider.apiKey) {
    const openai = createOpenAI({
      apiKey: provider.apiKey,
      ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
    });
    return modelEmbedder(
      `${provider.slug}:${OPENAI_EMBEDDING_MODEL}`,
      openai.embedding(OPENAI_EMBEDDING_MODEL),
      onError,
    );
  }
  return localEmbedder;
}
