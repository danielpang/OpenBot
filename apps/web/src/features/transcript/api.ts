import { ApiError, unwrap, type components } from '@openbots/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../app/api.js';

// The REST calls behind the transcript, the composer and the activity log.

export type BotState = components['schemas']['BotState'];
export type Message = components['schemas']['Message'];
export type MessagePart = components['schemas']['MessagePart'];
export type UploadedFile = components['schemas']['File'];
export type Run = components['schemas']['Run'];
export type RunStep = components['schemas']['RunStep'];
export type Reaction = components['schemas']['Reaction'];

export const MESSAGE_PAGE = 50;

/** A page of messages, newest first: the top-level ones, or a thread's root and replies. */
export function fetchMessages(chatId: string, before?: number, thread?: string) {
  return unwrap(
    api.GET('/api/v1/chats/{id}/messages', {
      params: { path: { id: chatId }, query: { limit: MESSAGE_PAGE, before, thread } },
    }),
  );
}

/** Everything after `since`, oldest first (after a reconnect or a missed delta). */
export function fetchResync(chatId: string, since: number) {
  return unwrap(
    api.GET('/api/v1/chats/{id}/resync', {
      params: { path: { id: chatId }, query: { since } },
    }),
  );
}

export function postMessage(
  chatId: string,
  body: { text?: string; attachments?: string[]; threadRootId?: string },
) {
  return unwrap(
    api.POST('/api/v1/chats/{id}/messages', { params: { path: { id: chatId } }, body }),
  );
}

/** The owner's reaction (C8); resolves with it whether it is new or was already there. */
export function addReaction(messageId: string, emoji: string) {
  return unwrap(
    api.POST('/api/v1/messages/{id}/reactions', {
      params: { path: { id: messageId } },
      body: { emoji },
    }),
  );
}

export async function removeReaction(messageId: string, emoji: string) {
  await unwrap(
    api.DELETE('/api/v1/messages/{id}/reactions', {
      params: { path: { id: messageId }, query: { emoji } },
    }),
  );
}

/** Uploads one composer attachment (`POST /files`, multipart field `file`). */
export async function uploadFile(file: File): Promise<UploadedFile> {
  const form = new FormData();
  form.append('file', file, file.name);
  const response = await fetch('/api/v1/files', {
    method: 'POST',
    body: form,
    credentials: 'include',
  });
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) throw new ApiError(response.status, body as never);
  return body as UploadedFile;
}

/** Posts a widget action; resolves with the widget's next state. */
export async function widgetAction(
  messageId: string,
  partIndex: number,
  action: Record<string, unknown>,
) {
  const result = await unwrap(
    api.POST('/api/v1/messages/{id}/widgets/{part}/action', {
      params: { path: { id: messageId, part: partIndex } },
      body: { action },
    }),
  );
  return result.widget;
}

export const runQuery = (runId: string) =>
  queryOptions({
    queryKey: ['runs', runId],
    queryFn: () => unwrap(api.GET('/api/v1/runs/{id}', { params: { path: { id: runId } } })),
  });

export const runStepsQuery = (runId: string) =>
  queryOptions({
    queryKey: ['runs', runId, 'steps'],
    queryFn: async () =>
      (await unwrap(api.GET('/api/v1/runs/{id}/steps', { params: { path: { id: runId } } }))).items,
  });

export function cancelRun(runId: string) {
  return unwrap(api.POST('/api/v1/runs/{id}/cancel', { params: { path: { id: runId } } }));
}

export const fileUrl = (fileId: string) => `/api/v1/files/${encodeURIComponent(fileId)}`;
