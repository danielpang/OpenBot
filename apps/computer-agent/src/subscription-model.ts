import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withSubscriptionAuthLock, SUBSCRIPTION_AUTH_LOCK } from './subscription-auth-lock.js';

// Invoked only over authenticated WS /coder, as the credential-owning coder uid.
// Use the same pinned runtime as pi, but never start a coding loop or execute tools.
const MODULES = '/opt/openbots/coders/node_modules';
type Json = Record<string, unknown>;
type Credential = {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
};
type Agent = 'claude' | 'codex' | 'pi';

export function readSubscriptionCredential(
  agent: Agent,
  data: Json,
  provider: string,
): Credential | undefined {
  if (agent === 'pi') {
    const credential = data[provider] as Credential | undefined;
    return credential?.type === 'oauth' ? credential : undefined;
  }
  if (agent === 'claude') {
    const tokens = data.claudeAiOauth as Json | undefined;
    if (
      typeof tokens?.accessToken !== 'string' ||
      typeof tokens.refreshToken !== 'string' ||
      typeof tokens.expiresAt !== 'number'
    )
      return;
    return {
      type: 'oauth',
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: tokens.expiresAt,
    };
  }
  const tokens = data.tokens as Json | undefined;
  if (typeof tokens?.access_token !== 'string' || typeof tokens.refresh_token !== 'string') return;
  const payload = JSON.parse(
    Buffer.from(tokens.access_token.split('.')[1] ?? '', 'base64url').toString(),
  ) as { exp?: number };
  return {
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: (payload.exp ?? 0) * 1000,
    ...(typeof tokens.account_id === 'string' ? { accountId: tokens.account_id } : {}),
  };
}

export function writeSubscriptionCredential(
  agent: Agent,
  data: Json,
  provider: string,
  next: Credential,
): Json {
  if (agent === 'pi') return { ...data, [provider]: next };
  if (agent === 'claude')
    return {
      ...data,
      claudeAiOauth: {
        ...(data.claudeAiOauth as Json),
        accessToken: next.access,
        refreshToken: next.refresh,
        expiresAt: next.expires,
      },
    };
  return {
    ...data,
    tokens: {
      ...(data.tokens as Json),
      access_token: next.access,
      refresh_token: next.refresh,
      ...(next.accountId ? { account_id: next.accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
}

interface Backend {
  withLockAsync<T>(
    fn: (current: string | undefined) => Promise<{ result: T; next?: string }>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
}
interface PiEvent {
  type: string;
  contentIndex: number;
  delta?: string;
  toolCall?: { id: string; name: string; arguments: unknown };
  reason?: string;
  message?: {
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
    errorMessage?: string;
  };
  error?: { errorMessage?: string };
}

export interface SubscriptionRequest {
  agent: Agent;
  provider: string;
  modelId: string;
  context: Json;
  capabilities?: {
    reasoning: boolean;
    vision: boolean;
    context_window: number | null;
    max_output: number | null;
  };
  temperature?: number;
  maxTokens?: number;
  reasoning?: string;
  toolChoice?: { type: string; toolName?: string };
}

export function subscriptionFailure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const code =
    /401|unauthori[sz]ed|not signed in|oauth|refresh|credentials? (?:not|store)|authentication|invalid.*token/i.test(
      message,
    )
      ? 'subscription_auth'
      : /429|rate.?limit|quota/i.test(message)
        ? 'subscription_limit'
        : 'subscription_request';
  return {
    type: 'error',
    code,
    error:
      code === 'subscription_auth'
        ? 'The subscription is not signed in. Reconnect in Settings > Models.'
        : 'The subscription request failed. Check your plan limits and selected model in Settings > Models.',
  };
}

/** Exported for pinned-runtime HTTP fixture tests. Production module paths are fixed. */
export async function runSubscription(
  request: SubscriptionRequest,
  options: {
    modules?: string;
    authDir?: string;
    signal?: AbortSignal;
    emit?: (event: Json) => void;
  } = {},
) {
  const modules = options.modules ?? MODULES;
  const writes = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>) => {
    writes.add(operation);
    void operation.then(
      () => writes.delete(operation),
      () => writes.delete(operation),
    );
    return operation;
  };
  try {
    const { agent, provider } = request;
    if (
      !['claude', 'codex', 'pi'].includes(agent) ||
      !['anthropic', 'openai-codex', 'xai'].includes(provider)
    )
      throw new Error('Unsupported subscription connection');
    if (
      (agent === 'claude' && provider !== 'anthropic') ||
      (agent === 'codex' && provider !== 'openai-codex')
    )
      throw new Error('Subscription provider does not match its account');
    const authDir =
      options.authDir ??
      process.env[
        agent === 'claude'
          ? 'CLAUDE_CONFIG_DIR'
          : agent === 'codex'
            ? 'CODEX_HOME'
            : 'PI_CODING_AGENT_DIR'
      ];
    if (!authDir) throw new Error('Subscription credential directory is unavailable');
    const authPath = join(authDir, agent === 'claude' ? '.credentials.json' : 'auth.json');
    const { FileAuthStorageBackend } = (await import(
      `${modules}/@earendil-works/pi-coding-agent/dist/core/auth-storage.js`
    )) as { FileAuthStorageBackend: new (path: string) => Backend };
    const backend = new FileAuthStorageBackend(authPath);
    const credentials = {
      async read() {
        // Native CLIs can commit their file while a valid-token snapshot is read.
        // A short parse retry avoids treating an in-progress truncate/write as logout.
        for (let attempt = 0; ; attempt++) {
          try {
            return await backend.withLockAsync(
              async (raw) => ({
                result: readSubscriptionCredential(
                  agent,
                  JSON.parse(raw ?? '{}') as Json,
                  provider,
                ),
              }),
              { signal: options.signal },
            );
          } catch (error) {
            if (!(error instanceof SyntaxError) || agent === 'pi' || attempt >= 2) throw error;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      },
      async modify(
        _id: string,
        fn: (current: Credential | undefined) => Promise<Credential | undefined>,
        lockOptions?: { signal?: AbortSignal },
      ) {
        const commit = () =>
          backend.withLockAsync(async (raw) => {
            const data = JSON.parse(raw ?? '{}') as Json;
            const current = readSubscriptionCredential(agent, data, provider);
            if (!current)
              throw new Error('Subscription is not signed in. Reconnect it in Settings > Models.');
            const next = await fn(current);
            return {
              result: next ?? current,
              ...(next
                ? {
                    next: JSON.stringify(
                      writeSubscriptionCredential(agent, data, provider, next),
                      null,
                      2,
                    ),
                  }
                : {}),
            };
          }, lockOptions);
        return track(
          withSubscriptionAuthLock(
            join(authDir, SUBSCRIPTION_AUTH_LOCK),
            lockOptions?.signal,
            commit,
          ),
        );
      },
      async list() {
        return (await this.read()) ? [{ providerId: provider, type: 'oauth' }] : [];
      },
      async delete() {
        throw new Error('Use Settings > Models to disconnect a subscription');
      },
    };
    if (!(await credentials.read()))
      throw new Error('Subscription is not signed in. Reconnect it in Settings > Models.');
    const { createModels } = (await import(`${modules}/@earendil-works/pi-ai/dist/index.js`)) as {
      createModels(options: unknown): {
        setProvider(provider: unknown): void;
        getModel(provider: string, id: string): (Json & { api: string }) | undefined;
        getModels(provider: string): (Json & { api: string })[];
        streamSimple(model: unknown, context: unknown, options: unknown): AsyncIterable<PiEvent>;
      };
    };
    const { builtinProviders } = (await import(
      `${modules}/@earendil-works/pi-ai/dist/providers/all.js`
    )) as { builtinProviders(): { id: string }[] };
    // Ambient API keys must never replace an expired or missing subscription.
    const models = createModels({
      credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    const builtin = builtinProviders().find((p) => p.id === provider);
    if (!builtin) throw new Error('This runtime does not support the subscription provider');
    models.setProvider(builtin);
    // OpenBots' catalog can be newer than the pinned runtime's. Preserve the
    // requested vendor id; use that provider's protocol template for new models.
    const catalog = models.getModels(provider);
    const template =
      catalog.find((m) => m.reasoning === request.capabilities?.reasoning) ?? catalog[0];
    const model =
      models.getModel(provider, request.modelId) ??
      (template
        ? {
            ...template,
            id: request.modelId,
            name: request.modelId,
            ...(request.capabilities
              ? {
                  reasoning: request.capabilities.reasoning,
                  input: request.capabilities.vision ? ['text', 'image'] : ['text'],
                  contextWindow: request.capabilities.context_window ?? template.contextWindow,
                  maxTokens: request.capabilities.max_output ?? template.maxTokens,
                }
              : {}),
          }
        : undefined);
    if (!model) throw new Error(`No subscription protocol is available for ${provider}`);
    // Keep assistant provenance accurate when a provider uses a different API for OAuth.
    const messages = request.context.messages as Json[];
    for (const message of messages) {
      if (message.role === 'assistant') {
        message.api = model.api;
        // Opaque reasoning is intentionally not stored by OpenBots. Responses item IDs
        // must not reference discarded rs_* items; preserve only the call-id portion.
        if (provider === 'openai-codex' || provider === 'xai')
          for (const block of message.content as Json[])
            if (block.type === 'toolCall' && typeof block.id === 'string')
              block.id = block.id.split('|')[0];
      } else if (
        message.role === 'toolResult' &&
        (provider === 'openai-codex' || provider === 'xai') &&
        typeof message.toolCallId === 'string'
      )
        message.toolCallId = message.toolCallId.split('|')[0];
    }
    if (request.toolChoice?.type === 'tool')
      request.context.tools = (request.context.tools as Json[] | undefined)?.filter(
        (t) => t.name === request.toolChoice?.toolName,
      );
    const emit =
      options.emit ?? ((part: Json) => process.stdout.write(`${JSON.stringify(part)}\n`));
    let finished = false;
    for await (const event of models.streamSimple(model, request.context, {
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      reasoning: request.reasoning,
      toolChoice: request.toolChoice?.type === 'none' ? 'none' : 'auto',
      transport: 'sse',
      signal: options.signal,
    })) {
      const id = String(event.contentIndex);
      if (event.type === 'text_start') emit({ type: 'text-start', id });
      else if (event.type === 'text_delta') emit({ type: 'text-delta', id, delta: event.delta });
      else if (event.type === 'text_end') emit({ type: 'text-end', id });
      else if (event.type === 'toolcall_end' && event.toolCall)
        emit({
          type: 'tool-call',
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.name,
          input: JSON.stringify(event.toolCall.arguments),
        });
      else if (event.type === 'error')
        throw new Error(event.error?.errorMessage ?? 'The subscription request failed');
      else if (event.type === 'done' && event.message) {
        const usage = event.message.usage;
        emit({
          type: 'finish',
          finishReason: {
            unified:
              event.reason === 'toolUse'
                ? 'tool-calls'
                : event.reason === 'length'
                  ? 'length'
                  : 'stop',
            raw: event.reason,
          },
          usage: {
            inputTokens: {
              total: usage.input + usage.cacheRead + usage.cacheWrite,
              noCache: usage.input,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
            },
            outputTokens: { total: usage.output, text: undefined, reasoning: undefined },
          },
          providerMetadata: { subscription: { billed: 'subscription' } },
        });
        finished = true;
      }
    }
    if (!finished) throw new Error('The subscription response did not finish');
  } finally {
    // SDK refreshes deliberately outlive cancellation after a token may have rotated.
    await Promise.allSettled([...writes]);
  }
}

async function main() {
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Subscription request cancelled'));
  process.on('SIGUSR1', cancel);
  process.on('SIGTERM', cancel);
  process.stdout.on('error', () => {}); // A disconnected reader must not interrupt a refresh commit.
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (input.length > 16_000_000)
        throw new Error('Subscription request exceeded its size limit');
    }
    await runSubscription(JSON.parse(input) as SubscriptionRequest, { signal: abort.signal });
  } finally {
    process.off('SIGUSR1', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    // Only fixed messages and an allowlisted classification cross the credential boundary.
    process.stdout.write(`${JSON.stringify(subscriptionFailure(error))}\n`);
    process.exitCode = 1;
  });
}
