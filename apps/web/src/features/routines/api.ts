import { unwrap, type components } from '@openbots/api-client';
import type { CodingRoutineTemplate } from '@openbots/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../app/api.js';
import { endpointsQuery } from '../webhooks/api.js';

// The REST calls behind the Bot's Routines tab (plan 14.1; R1, R3, R4). The
// list is refetched while the tab is open, so last and next runs move as
// the scheduler starts runs.

export type Routine = components['schemas']['Routine'];
export type RoutineRun = NonNullable<components['schemas']['RoutineRun']>;
export type CreateRoutine = components['schemas']['CreateRoutine'];
export type UpdateRoutine = components['schemas']['UpdateRoutine'];

export const ROUTINES_REFRESH_MS = 15_000;

/** The coding Routine templates New Routine offers (CA11). */
export const routineTemplatesQuery = queryOptions({
  queryKey: ['routine-templates'],
  queryFn: async () =>
    (await unwrap(api.GET('/api/v1/routines/templates'))).templates as CodingRoutineTemplate[],
  staleTime: Infinity,
});

export const routinesQuery = (botId: string) =>
  queryOptions({
    queryKey: ['routines', botId],
    queryFn: async () =>
      (await unwrap(api.GET('/api/v1/bots/{id}/routines', { params: { path: { id: botId } } })))
        .items,
    refetchInterval: ROUTINES_REFRESH_MS,
  });

export const routineRunsQuery = (routineId: string) =>
  queryOptions({
    queryKey: ['routine-runs', routineId],
    queryFn: async () =>
      (await unwrap(api.GET('/api/v1/routines/{id}/runs', { params: { path: { id: routineId } } })))
        .items as RoutineRun[],
    refetchInterval: ROUTINES_REFRESH_MS,
  });

export function createRoutine(botId: string, body: CreateRoutine) {
  return unwrap(api.POST('/api/v1/bots/{id}/routines', { params: { path: { id: botId } }, body }));
}

/** Create, edit, run now and delete, each refreshing the Bot's list and the Routine's runs. */
export function useRoutineActions(botId: string) {
  const queryClient = useQueryClient();
  const refresh = async (routineId?: string) => {
    await queryClient.invalidateQueries({ queryKey: routinesQuery(botId).queryKey });
    // An event Routine's endpoint is made, or turned off and on, with it (R2, H2).
    await queryClient.invalidateQueries({ queryKey: endpointsQuery(botId).queryKey });
    if (routineId) {
      await queryClient.invalidateQueries({ queryKey: routineRunsQuery(routineId).queryKey });
    }
  };
  const path = (id: string) => ({ params: { path: { id } } });
  return {
    create: useMutation({
      mutationFn: (body: CreateRoutine) => createRoutine(botId, body),
      onSuccess: () => refresh(),
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: UpdateRoutine }) =>
        unwrap(api.PATCH('/api/v1/routines/{id}', { ...path(id), body })),
      onSuccess: (routine) => refresh(routine.id),
    }),
    runNow: useMutation({
      mutationFn: async (id: string) =>
        (await unwrap(api.POST('/api/v1/routines/{id}/run-now', path(id)))) as RoutineRun,
      onSuccess: (run) => refresh(run.routineId),
    }),
    remove: useMutation({
      mutationFn: (id: string) => unwrap(api.DELETE('/api/v1/routines/{id}', path(id))),
      onSuccess: () => refresh(),
    }),
  };
}
