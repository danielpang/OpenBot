import { unwrap, type components } from '@openbots/api-client';
import type { ModelNeed } from '@openbots/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../app/api.js';

// Providers and models (L1 to L5). Members read; the mutations below are
// admin-only on the server, so the UI offers them to admins only.

export type Provider = components['schemas']['Provider'];
export type ProviderModel = components['schemas']['ProviderModel'];
export type ProviderPreset = components['schemas']['ProviderPreset'];
export type CreateProvider = components['schemas']['CreateProvider'];
export type UpdateProvider = components['schemas']['UpdateProvider'];
export type ModelInput = components['schemas']['ModelInput'];

export const providersQuery = queryOptions({
  queryKey: ['providers'],
  queryFn: () => unwrap(api.GET('/api/v1/providers')),
});

export const presetsQuery = queryOptions({
  queryKey: ['providers', 'presets'],
  queryFn: () => unwrap(api.GET('/api/v1/providers/presets')),
  staleTime: Infinity,
});

export const providerModelsQuery = (id: string) =>
  queryOptions({
    queryKey: ['providers', id, 'models'],
    queryFn: () => unwrap(api.GET('/api/v1/providers/{id}/models', { params: { path: { id } } })),
  });

/**
 * Enabled models with every need, grouped by provider, for the Bot model
 * picker, and the model a new Bot gets. With `botId` the server adds what
 * that Bot needs (vision once it uses its computer, L4).
 */
export const pickerModelsQuery = (needs: readonly ModelNeed[], botId?: string) =>
  queryOptions({
    queryKey: ['models', [...needs].sort().join(','), botId ?? null],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/models', {
          params: { query: { needs: needs.join(','), ...(botId ? { botId } : {}) } },
        }),
      ),
  });

export type PickerGroup = Awaited<
  ReturnType<NonNullable<ReturnType<typeof pickerModelsQuery>['queryFn']>>
>['groups'][number];

export const createProvider = (body: CreateProvider) =>
  unwrap(api.POST('/api/v1/providers', { body }));

export const updateProvider = (id: string, body: UpdateProvider) =>
  unwrap(api.PATCH('/api/v1/providers/{id}', { params: { path: { id } }, body }));

export const deleteProvider = (id: string) =>
  unwrap(api.DELETE('/api/v1/providers/{id}', { params: { path: { id } } }));

export const testProvider = (id: string, modelId?: string) =>
  unwrap(
    api.POST('/api/v1/providers/{id}/test', {
      params: { path: { id } },
      body: modelId ? { modelId } : {},
    }),
  );

export const discoverModels = (id: string) =>
  unwrap(api.POST('/api/v1/providers/{id}/discover', { params: { path: { id } } }));

export const putModels = (id: string, models: ModelInput[], remove: string[]) =>
  unwrap(
    api.PUT('/api/v1/providers/{id}/models', {
      params: { path: { id } },
      body: { models, remove },
    }),
  );
