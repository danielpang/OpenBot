import { unwrap, type components } from '@openbots/api-client';
import { Button } from '@openbots/ui';
import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../../app/api.js';
import { formatSize } from '../computer/files.js';
import { ErrorText } from '../models/error-text.js';
import { fileUrl } from '../transcript/api.js';

// The account's chat attachments (plan 12.1), on the Computer page beside the
// computer's files: what the owner attached in chats, newest first, with the
// chat each came from and a download. Artifact versions, webhook bodies and
// avatar images are not attachments, and the server leaves them out.

export type Attachment = components['schemas']['Attachment'];

export const attachmentsQuery = infiniteQueryOptions({
  queryKey: ['attachments'],
  queryFn: ({ pageParam }) =>
    unwrap(
      api.GET('/api/v1/files', {
        params: { query: { ...(pageParam ? { cursor: pageParam } : {}), limit: 50 } },
      }),
    ),
  initialPageParam: '',
  getNextPageParam: (page) => page.nextCursor ?? undefined,
});

function ChatLink({ chat }: { chat: Attachment['chat'] }) {
  if (!chat) return <span className="text-muted-foreground">Not sent</span>;
  if (chat.type === 'bot_dm' && chat.botId) {
    return (
      <Link to="/bots/$botId" params={{ botId: chat.botId }} className="hover:underline">
        {chat.name}
      </Link>
    );
  }
  if (chat.type === 'group') {
    return (
      <Link to="/groups/$chatId" params={{ chatId: chat.id }} className="hover:underline">
        {chat.name}
      </Link>
    );
  }
  return <span>{chat.name}</span>;
}

export function Attachments() {
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery(attachmentsQuery);
  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="flex flex-col gap-3" aria-label="Attachments">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">Attachments</h2>
        <p className="text-sm text-muted-foreground">Files you attached in your chats.</p>
      </div>
      <ErrorText error={error} />
      {data && !items.length && (
        <p className="text-sm text-muted-foreground">
          Nothing yet. Files you attach to a message show up here.
        </p>
      )}
      {!!items.length && (
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-normal">Name</th>
              <th className="py-1 pr-3 font-normal">Size</th>
              <th className="py-1 pr-3 font-normal">Added</th>
              <th className="py-1 font-normal">Chat</th>
            </tr>
          </thead>
          <tbody>
            {items.map((file) => (
              <tr key={file.id} className="border-t align-top">
                <td className="max-w-0 truncate py-1 pr-3">
                  <a
                    href={fileUrl(file.id)}
                    download={file.name}
                    className="hover:underline"
                    title={`Download ${file.name}`}
                  >
                    {file.name}
                  </a>
                </td>
                <td className="whitespace-nowrap py-1 pr-3 text-muted-foreground">
                  {formatSize(file.size)}
                </td>
                <td className="whitespace-nowrap py-1 pr-3 text-muted-foreground">
                  {new Date(file.createdAt).toLocaleDateString()}
                </td>
                <td className="py-1">
                  <ChatLink chat={file.chat} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </section>
  );
}
