import type { ModelCapabilities, ModelNeed } from '@openbots/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { capabilitiesQuery } from '../../app/api.js';
import { pickerModelsQuery, type ProviderModel } from '../models/api.js';
import { pickerNeeds } from '../models/ModelPicker.js';
import { BotStep } from '../setup/setup-wizard.js';
import {
  BotModelFields,
  NO_VISION_HINT,
  THINKING_HELP,
  thinkingOf,
  withThinking,
} from './bot-model.js';
import type { Bot } from './queries.js';

// The model section of Bot Settings (L4, plan 3) and the setup wizard's
// first Bot, rendered with their queries already answered.

const PROVIDER_ID = '00000000-0000-4000-8000-0000000000a1';
const BOT_ID = '00000000-0000-4000-8000-0000000000b1';

const capabilities = (over: Partial<ModelCapabilities>): ModelCapabilities => ({
  tools: true,
  vision: false,
  reasoning: false,
  context_window: null,
  max_output: null,
  ...over,
});

function model(modelId: string, over: Partial<ModelCapabilities> = {}): ProviderModel {
  return {
    id: `00000000-0000-4000-8000-${modelId.length.toString().padStart(12, '0')}`,
    providerId: PROVIDER_ID,
    modelId,
    displayName: modelId,
    capabilities: capabilities(over),
    pricing: null,
    enabled: true,
    source: 'catalog',
  };
}

const provider = {
  id: PROVIDER_ID,
  name: 'Anthropic',
  slug: 'anthropic',
  kind: 'anthropic' as const,
  protocol: 'native' as const,
  status: 'ok' as const,
};

const bot = (toolPolicy: Bot['toolPolicy'] = {}): Bot => ({
  id: BOT_ID,
  handle: 'ada',
  name: 'Ada',
  label: null,
  description: '',
  avatar: { kind: 'generated', seed: 'ada' },
  modelConfig: null,
  isMain: false,
  toolPolicy,
  pinned: false,
  hidden: false,
  chatId: BOT_ID,
  state: { botId: BOT_ID, state: 'idle', currentAction: null, runId: null, updatedAt: '' },
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
});

const blind = model('blind-thinker', { reasoning: true });
const seer = model('seer', { vision: true });

function seeded(computer: boolean) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(capabilitiesQuery.queryKey, {
    oauth: { github: false, google: false },
    computer,
    deployment: 'self_hosted',
  });
  const answer = (needs: ModelNeed[], models: ProviderModel[], botId?: string) =>
    queryClient.setQueryData(pickerModelsQuery(pickerNeeds(needs), botId).queryKey, {
      groups: [{ provider, models }],
      default: { provider_id: PROVIDER_ID, model_id: 'seer' },
    });
  answer([], [blind, seer]);
  answer([], [blind, seer], BOT_ID);
  answer(['vision'], [seer], BOT_ID);
  return queryClient;
}

function render(queryClient: QueryClient, node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory(),
  });
  return router.load().then(() =>
    renderToString(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
}

/** The markup with React's text separators dropped and apostrophes unescaped. */
const plainText = (html: string) => html.replaceAll('<!-- -->', '').replaceAll('&#x27;', "'");

const fields = async (computer: boolean, toolPolicy?: Bot['toolPolicy']) =>
  plainText(
    await render(
      seeded(computer),
      <BotModelFields
        bot={bot(toolPolicy)}
        value={{ provider_id: PROVIDER_ID, model_id: 'blind-thinker', reasoning: true }}
        onChange={() => {}}
      />,
    ),
  );

describe('Bot Settings model section', () => {
  it('hides models without vision for a Bot with a computer, and says why', async () => {
    const html = await fields(true);
    expect(html).toContain('blind-thinker (unavailable)');
    expect(html).toContain(NO_VISION_HINT);
    expect(html).toContain('seer · unknown context');
  });

  it('keeps every model with tools for a Bot without the computer', async () => {
    for (const html of [
      await fields(false),
      await fields(true, { groups: { computer: 'deny' } }),
    ]) {
      expect(html).not.toContain('(unavailable)');
      expect(html).not.toContain(NO_VISION_HINT);
      expect(html).toContain('blind-thinker · unknown context');
    }
  });

  it('shows Thinking only for a model that reasons', async () => {
    const html = await fields(false);
    expect(html).toContain('>Thinking</span>');
    expect(html).toMatch(/<option value="on" selected="">On \(the model decides how much\)/);
    expect(html).toContain(THINKING_HELP);

    const plain = await render(
      seeded(false),
      <BotModelFields
        bot={bot()}
        value={{ provider_id: PROVIDER_ID, model_id: 'seer' }}
        onChange={() => {}}
      />,
    );
    expect(plain).not.toContain('Thinking');
  });

  it('maps the Thinking choice to model_config.reasoning', () => {
    expect(thinkingOf(undefined)).toBe('off');
    expect(thinkingOf(false)).toBe('off');
    expect(thinkingOf(true)).toBe('on');
    expect(thinkingOf('high')).toBe('high');
    const config = { provider_id: PROVIDER_ID, model_id: 'm', max_steps: 9 };
    expect(withThinking(config, 'off')).toEqual({ ...config, reasoning: false });
    expect(withThinking(config, 'on')).toEqual({ ...config, reasoning: true });
    expect(withThinking(config, 'low')).toEqual({ ...config, reasoning: 'low' });
  });
});

describe('setup wizard first Bot', () => {
  it('asks only for a name and an icon; the server picks the default model (plan 3)', async () => {
    const html = await render(seeded(false), <BotStep />);
    expect(html).toContain('value="Assistant"');
    expect(html).toContain('aria-label="Icon preview"');
    expect(html).toContain('>Create Bot</button>');
    expect(html).not.toContain('<select');
  });
});
