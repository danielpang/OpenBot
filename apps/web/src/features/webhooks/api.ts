import { unwrap, type components } from '@openbots/api-client';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../app/api.js';

// The REST calls behind the Bot's webhook endpoints, their delivery log
// (H1 to H5) and Settings > Events (H6). Tokens and signing secrets come back
// once, in the response that issued them, and are never fetched again.

export type Endpoint = components['schemas']['WebhookEndpoint'];
export type IssuedEndpoint = components['schemas']['IssuedWebhookEndpoint'];
export type CreateEndpoint = components['schemas']['CreateWebhookEndpoint'];
export type UpdateEndpoint = components['schemas']['UpdateWebhookEndpoint'];
export type Delivery = components['schemas']['WebhookDelivery'];
export type DeliveryResult = components['schemas']['WebhookDeliveryResult'];
export type TestEvent = components['schemas']['WebhookTestEvent'];
export type Subscription = components['schemas']['EventSubscription'];
export type IssuedSubscription = components['schemas']['IssuedEventSubscription'];
export type CreateSubscription = components['schemas']['CreateEventSubscription'];
export type UpdateSubscription = components['schemas']['UpdateEventSubscription'];
export type EventDelivery = components['schemas']['EventDelivery'];

export const DELIVERIES_REFRESH_MS = 10_000;

const path = (id: string) => ({ params: { path: { id } } });

export const endpointsQuery = (botId: string) =>
  queryOptions({
    queryKey: ['endpoints', botId],
    queryFn: async () => (await unwrap(api.GET('/api/v1/bots/{id}/endpoints', path(botId)))).items,
  });

export const deliveriesQuery = (endpointId: string) =>
  queryOptions({
    queryKey: ['endpoint-deliveries', endpointId],
    queryFn: async () =>
      (await unwrap(api.GET('/api/v1/endpoints/{id}/deliveries', path(endpointId)))).items,
    refetchInterval: DELIVERIES_REFRESH_MS,
  });

export const subscriptionsQuery = queryOptions({
  queryKey: ['event-subscriptions'],
  queryFn: async () => (await unwrap(api.GET('/api/v1/event-subscriptions'))).items,
});

export const eventDeliveriesQuery = (subscriptionId: string) =>
  queryOptions({
    queryKey: ['event-deliveries', subscriptionId],
    queryFn: async () =>
      (await unwrap(api.GET('/api/v1/event-subscriptions/{id}/deliveries', path(subscriptionId))))
        .items,
    refetchInterval: DELIVERIES_REFRESH_MS,
  });

/** Create, edit, rotate and delete a Bot's endpoints, each refreshing its list. */
export function useEndpointActions(botId: string) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: endpointsQuery(botId).queryKey });
  return {
    create: useMutation({
      mutationFn: (body: CreateEndpoint) =>
        unwrap(api.POST('/api/v1/bots/{id}/endpoints', { ...path(botId), body })),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: UpdateEndpoint }) =>
        unwrap(api.PATCH('/api/v1/endpoints/{id}', { ...path(id), body })),
      onSuccess: refresh,
    }),
    rotate: useMutation({
      mutationFn: (id: string) => unwrap(api.POST('/api/v1/endpoints/{id}/rotate', path(id))),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => unwrap(api.DELETE('/api/v1/endpoints/{id}', path(id))),
      onSuccess: refresh,
    }),
  };
}

/** Replay a delivery or send a test event, each refreshing the endpoint's log. */
export function useDeliveryActions(endpointId: string) {
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: deliveriesQuery(endpointId).queryKey });
  return {
    replay: useMutation({
      mutationFn: (deliveryId: string) =>
        unwrap(
          api.POST('/api/v1/endpoints/{id}/deliveries/{did}/replay', {
            params: { path: { id: endpointId, did: deliveryId } },
          }),
        ),
      onSuccess: refresh,
    }),
    test: useMutation({
      mutationFn: (body: TestEvent) =>
        unwrap(api.POST('/api/v1/endpoints/{id}/test', { ...path(endpointId), body })),
      onSuccess: refresh,
    }),
  };
}

export function useSubscriptionActions() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: subscriptionsQuery.queryKey });
  return {
    create: useMutation({
      mutationFn: (body: CreateSubscription) =>
        unwrap(api.POST('/api/v1/event-subscriptions', { body })),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: UpdateSubscription }) =>
        unwrap(api.PATCH('/api/v1/event-subscriptions/{id}', { ...path(id), body })),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => unwrap(api.DELETE('/api/v1/event-subscriptions/{id}', path(id))),
      onSuccess: refresh,
    }),
  };
}
