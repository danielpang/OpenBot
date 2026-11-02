import { createFileRoute } from '@tanstack/react-router';
import { Transcript } from '../../../../features/transcript/Transcript.js';
import { transcriptSearch } from '../../../../features/transcript/timeline.js';

export const Route = createFileRoute('/_app/bots/$botId/')({
  // `?seq=` opens the chat at one message (a notification's target), and
  // `&thread=` the thread a reply is in. With `?chat=`, the message is in one
  // of the Bot's chats with another Bot, which opens under the transcript.
  validateSearch: transcriptSearch,
  component: Chat,
});

function Chat() {
  const { botId } = Route.useParams();
  const { seq, thread, chat } = Route.useSearch();
  return <Transcript botId={botId} focusSeq={seq} focusThread={thread} focusChat={chat} />;
}
