import { createFileRoute } from '@tanstack/react-router';
import { GroupView } from '../../../features/chats/group-view.js';
import { focusSeqSearch } from '../../../features/transcript/timeline.js';

export const Route = createFileRoute('/_app/groups/$chatId')({
  // `?seq=` opens the group at one message (a deep link's target), and
  // `&thread=` the thread a reply is in.
  validateSearch: focusSeqSearch,
  component: Group,
});

function Group() {
  const { chatId } = Route.useParams();
  const { seq, thread } = Route.useSearch();
  return <GroupView chatId={chatId} focusSeq={seq} focusThread={thread} />;
}
