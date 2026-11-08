import { useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  CODING_SESSION_ENDED,
  CODING_ATTACHMENT_COUNT,
  CODING_ATTACHMENT_BYTES,
  CODING_ATTACHMENTS_BYTES,
} from '@openbots/shared';
import {
  Button,
  Textarea,
  PlusIcon,
  XIcon,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@openbots/ui';
import { AcceptEdits } from '../../bots/accept-edits.js';
import { ErrorText } from '../../models/error-text.js';
import { uploadFile, type UploadedFile } from '../../transcript/api.js';
import { sendCodingTurn, type CodingSession } from '../api.js';

type Attachment = { key: string; name: string; size: number; file?: UploadedFile; error?: string };

export function SessionComposer({
  session,
  onSent,
}: {
  session: CodingSession;
  onSent(session: CodingSession): void;
}) {
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const held = useRef<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [attachmentError, setAttachmentError] = useState<Error | null>(null);
  const submitting = useRef(false);
  const ended = CODING_SESSION_ENDED.includes(session.status);
  const update = (next: Attachment[]) => {
    held.current = next;
    setAttachments(next);
  };
  const send = useMutation({
    mutationFn: ({ text, ids }: { text: string; ids: string[] }) =>
      sendCodingTurn(session.id, text, ids),
    onSuccess: (next) => {
      setPrompt('');
      update([]);
      setAttachmentError(null);
      onSent(next);
    },
  });
  const uploading = attachments.some((file) => !file.file && !file.error);
  const canSend =
    ended &&
    !send.isPending &&
    !uploading &&
    !attachments.some((file) => file.error) &&
    (!!prompt.trim() || attachments.length > 0);

  function addFiles(files: Iterable<File>) {
    if (submitting.current) return;
    const incoming = [...files];
    if (!incoming.length) return;
    if (held.current.length + incoming.length > CODING_ATTACHMENT_COUNT) {
      setAttachmentError(new Error(`Attach at most ${CODING_ATTACHMENT_COUNT} files.`));
      return;
    }
    if (
      incoming.some((file) => file.size > CODING_ATTACHMENT_BYTES) ||
      [...held.current, ...incoming].reduce((sum, file) => sum + file.size, 0) >
        CODING_ATTACHMENTS_BYTES
    ) {
      setAttachmentError(new Error('Attachments must be at most 20 MB each and 50 MB in total.'));
      return;
    }
    setAttachmentError(null);
    for (const file of incoming) {
      const key = crypto.randomUUID();
      update([...held.current, { key, name: file.name, size: file.size }]);
      void uploadFile(file).then(
        (uploaded) =>
          update(
            held.current.map((item) => (item.key === key ? { ...item, file: uploaded } : item)),
          ),
        (error: unknown) =>
          update(
            held.current.map((item) =>
              item.key === key
                ? { ...item, error: error instanceof Error ? error.message : 'Upload failed' }
                : item,
            ),
          ),
      );
    }
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend || submitting.current) return;
    submitting.current = true;
    try {
      await send.mutateAsync({
        text: prompt.trim() || 'Please review the attached files.',
        ids: attachments.map((item) => item.file!.id),
      });
    } catch {
      /* The mutation keeps the draft and displays the error. */
    } finally {
      submitting.current = false;
    }
  }
  return (
    <form className="flex flex-col gap-2 border-t p-3" onSubmit={(event) => void submit(event)}>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        aria-label="Attach files"
        onChange={(event) => {
          addFiles(event.target.files ?? []);
          event.target.value = '';
        }}
      />
      <input
        ref={imageInput}
        type="file"
        multiple
        accept="image/*"
        hidden
        aria-label="Attach screenshots or images"
        onChange={(event) => {
          addFiles(event.target.files ?? []);
          event.target.value = '';
        }}
      />
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Attachments">
          {attachments.map((item) => (
            <li
              key={item.key}
              className="flex max-w-full items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs"
            >
              <span className="min-w-0 truncate">
                {item.name}
                {!item.file && !item.error ? ' · Uploading…' : ''}
              </span>
              {item.error && <span className="text-destructive">{item.error}</span>}
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                disabled={send.isPending}
                onClick={() => update(held.current.filter((file) => file.key !== item.key))}
              >
                <XIcon className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Add to coding message"
              disabled={send.isPending}
            >
              <PlusIcon className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={8}>
            <DropdownMenuItem onSelect={() => imageInput.current?.click()}>
              Attach screenshot or image
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
              Attach files
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <AcceptEdits botId={session.botId} menu />
          </DropdownMenuContent>
        </DropdownMenu>
        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          aria-label="Next prompt"
          placeholder="Message…"
          maxLength={4000}
          rows={2}
          disabled={!ended || send.isPending}
          className="min-h-0 resize-none"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              addFiles(event.clipboardData.files);
            }
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            addFiles(event.dataTransfer.files);
          }}
        />
        <Button type="submit" disabled={!canSend}>
          Send
        </Button>
      </div>
      {!ended && (
        <p className="text-xs text-muted-foreground">
          Working. Send your next message when this turn ends.
        </p>
      )}
      <ErrorText error={attachmentError || send.error} />
    </form>
  );
}
