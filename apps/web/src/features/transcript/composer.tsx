import { Avatar } from '@openbots/avatars/react';
import { Button, cn, XIcon } from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import {
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Bot } from '../bots/queries.js';
import { matchSkills, skillsQuery, usableSkills, type Skill } from '../skills/api.js';
import { fileUrl, postMessage, uploadFile, type Message, type UploadedFile } from './api.js';
import { activeTrigger, detectLinks, replaceTrigger, type Trigger } from './composer-text.js';

// The composer (C1): text with Shift+Enter for a new line, images and files by
// paste, drop or the attach button (uploaded to `POST /files` as soon as they
// are added), links noted under the draft, `/` for the Skills picker (the
// Skills enabled for one of the chat's Bots, S2; the chosen Skill rides
// along as the message's `skill_ref` and its content is loaded for that turn by
// each Bot that has it enabled) and `@` for the mention
// picker: the chat's Bots, in a group `@everyone` (C5) and the Bots a
// mention would add to it (C4). Sending while
// the Bot is busy is an ordinary post; the server steers the run with it (C3).

type MentionBot = Pick<Bot, 'id' | 'handle' | 'name' | 'avatar'>;

/** A row of the `@` picker. */
export type MentionOption = { kind: 'bot'; bot: MentionBot; adds: boolean } | { kind: 'everyone' };

type SkillChoice = Pick<Skill, 'id' | 'name' | 'slug' | 'summary' | 'usedBy'>;

/** A row of either picker. */
export type PickerOption = MentionOption | { kind: 'skill'; skill: SkillChoice };

interface Attachment {
  key: string;
  name: string;
  file?: UploadedFile;
  error?: string;
}

export interface ComposerProps {
  chatId: string;
  /**
   * Bots `@` can insert; in a bot_dm only the Bot itself. `/` offers the
   * Skills enabled for any of them.
   */
  mentionable: MentionBot[];
  /** Offer `@everyone`, as a group does. */
  everyone?: boolean;
  /** Bots outside the chat that a mention adds to it (a group with room). */
  addable?: MentionBot[];
  /** Post into this thread (C7). */
  threadRootId?: string;
  placeholder?: string;
  /** Controls beside Send, e.g. Stop while the Bot is working. */
  extra?: ReactNode;
  onSent?(message: Message): void;
}

export function Composer({
  chatId,
  mentionable,
  everyone,
  addable,
  threadRootId,
  placeholder,
  extra,
  onSent,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [skill, setSkill] = useState<SkillChoice | null>(null);
  const skills = useQuery(skillsQuery).data?.items ?? [];
  const botIds = mentionable.map((b) => b.id);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickerId = useId();

  const found = activeTrigger(text, caret);
  const trigger = found && found.start !== dismissed ? found : null;
  const options: PickerOption[] =
    trigger?.char === '@'
      ? mentionOptions(trigger.query, { mentionable, everyone, addable })
      : trigger?.char === '/'
        ? matchSkills(skills, trigger.query, botIds).map((s) => ({
            kind: 'skill' as const,
            skill: s,
          }))
        : [];
  const links = detectLinks(text);
  const uploading = attachments.some((a) => !a.file && !a.error);
  const ready = attachments.filter((a) => a.file);
  const canSend =
    !sending && !uploading && (text.trim().length > 0 || ready.length > 0 || skill !== null);

  function addFiles(files: Iterable<File>) {
    for (const file of files) {
      const key = `${file.name}-${crypto.randomUUID()}`;
      setAttachments((list) => [...list, { key, name: file.name }]);
      uploadFile(file).then(
        (uploaded) =>
          setAttachments((list) => list.map((a) => (a.key === key ? { ...a, file: uploaded } : a))),
        (e: unknown) =>
          setAttachments((list) =>
            list.map((a) =>
              a.key === key ? { ...a, error: e instanceof Error ? e.message : 'Upload failed' } : a,
            ),
          ),
      );
    }
  }

  function pick(option: PickerOption, at: Trigger) {
    if (option.kind !== 'skill') return choose(mentionText(option), at);
    // The Skill becomes the message's reference; the typed `/query` goes.
    setSkill(option.skill);
    choose('', at);
  }

  function choose(insert: string, at: Trigger) {
    const next = insert ? replaceTrigger(text, at, caret, insert) : removeTrigger(text, at, caret);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const message = await postMessage(chatId, {
        ...(text.trim() ? { text } : {}),
        ...(ready.length ? { attachments: ready.map((a) => a.file!.id) } : {}),
        ...(threadRootId ? { threadRootId } : {}),
        ...(skill ? { skillId: skill.id } : {}),
      });
      setText('');
      setCaret(0);
      setAttachments([]);
      setSkill(null);
      onSent?.(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (trigger) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(trigger.start);
        return;
      }
      if (options.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setHighlight((h) => (h + step + options.length) % options.length);
        return;
      }
      if (options.length && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault();
        pick(options[Math.min(highlight, options.length - 1)]!, trigger);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function onPaste(event: ClipboardEvent) {
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    addFiles(files);
  }

  function onDrop(event: DragEvent) {
    setDragging(false);
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    addFiles([...event.dataTransfer.files]);
  }

  return (
    <div
      className={cn(
        'relative flex flex-col gap-2 rounded-xl border bg-background p-2 shadow-xs',
        dragging && 'ring-2 ring-ring/50',
      )}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {trigger && (
        <Picker
          id={pickerId}
          trigger={trigger}
          options={options}
          highlight={Math.min(highlight, Math.max(0, options.length - 1))}
          onChoose={(option) => pick(option, trigger)}
          noSkills={
            !skills.length ? 'library' : !usableSkills(skills, botIds).length ? 'usable' : null
          }
        />
      )}
      {skill && (
        <p className="flex items-center gap-1 self-start rounded-md border px-2 py-0.5 text-xs">
          <span>Skill</span>
          <span className="font-medium">/{skill.slug}</span>
          <button
            type="button"
            aria-label={`Remove Skill ${skill.name}`}
            className="rounded p-0.5 hover:bg-accent"
            onClick={() => setSkill(null)}
          >
            <XIcon className="size-3" />
          </button>
        </p>
      )}
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <li
              key={a.key}
              className={cn(
                'flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
                a.error && 'border-destructive text-destructive',
              )}
            >
              {a.file?.mime.startsWith('image/') && (
                <img src={fileUrl(a.file.id)} alt="" className="size-5 rounded object-cover" />
              )}
              <span className="max-w-48 truncate">{a.name}</span>
              <span className="text-muted-foreground">
                {a.error ?? (a.file ? '' : 'Uploading…')}
              </span>
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                className="rounded p-0.5 hover:bg-accent"
                onClick={() => setAttachments((list) => list.filter((x) => x.key !== a.key))}
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={textarea}
        value={text}
        rows={Math.min(8, Math.max(1, text.split('\n').length))}
        placeholder={placeholder ?? 'Message'}
        aria-label="Message"
        aria-controls={trigger ? pickerId : undefined}
        aria-expanded={Boolean(trigger)}
        className="max-h-60 resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted-foreground"
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          setHighlight(0);
          setDismissed(null);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {links.length > 0 && (
        <p className="truncate px-1.5 text-xs text-muted-foreground">
          {links.length === 1 ? 'Link' : 'Links'}: {links.map((l) => l.host).join(', ')}
        </p>
      )}
      {error && (
        <p role="alert" className="px-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => fileInput.current?.click()}
        >
          Attach
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <div className="flex items-center gap-1">
          {extra}
          <Button type="button" size="sm" disabled={!canSend} onClick={() => void send()}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The `@` picker's rows for what is typed after `@`: the chat's Bots, `@everyone`, then Bots it would add. */
export function mentionOptions(
  query: string,
  {
    mentionable,
    everyone,
    addable = [],
  }: { mentionable: MentionBot[]; everyone?: boolean; addable?: MentionBot[] },
): MentionOption[] {
  const q = query.toLowerCase();
  const matches = (b: MentionBot) => [b.handle, b.name.toLowerCase()].some((s) => s.startsWith(q));
  return [
    ...mentionable.filter(matches).map((bot) => ({ kind: 'bot' as const, bot, adds: false })),
    ...(everyone && 'everyone'.startsWith(q) ? [{ kind: 'everyone' as const }] : []),
    ...addable.filter(matches).map((bot) => ({ kind: 'bot' as const, bot, adds: true })),
  ];
}

export const mentionText = (option: MentionOption) =>
  option.kind === 'everyone' ? '@everyone' : `@${option.bot.handle}`;

/** Removes the trigger word and one following space; returns the text and the new caret. */
export function removeTrigger(text: string, trigger: Trigger, caret: number) {
  const after = text.slice(caret);
  return {
    text: text.slice(0, trigger.start) + (after.startsWith(' ') ? after.slice(1) : after),
    caret: trigger.start,
  };
}

const optionKey = (option: PickerOption) =>
  option.kind === 'bot' ? option.bot.id : option.kind === 'skill' ? option.skill.id : 'everyone';

function Picker({
  id,
  trigger,
  options,
  highlight,
  onChoose,
  noSkills,
}: {
  id: string;
  trigger: Trigger;
  options: PickerOption[];
  highlight: number;
  onChoose(option: PickerOption): void;
  /** The library is empty, or none of its Skills is usable here, rather than nothing matching. */
  noSkills: 'library' | 'usable' | null;
}) {
  const empty =
    trigger.char !== '/'
      ? 'No Bots match'
      : noSkills === 'library'
        ? 'No Skills yet'
        : noSkills === 'usable'
          ? "No Skills are enabled here. Enable one in a Bot's Settings."
          : 'No Skills match';
  return (
    <div
      id={id}
      role="listbox"
      aria-label={trigger.char === '/' ? 'Skills' : 'Mention a Bot'}
      className="absolute inset-x-2 bottom-full mb-1 rounded-lg border bg-popover p-1 text-sm shadow-md"
    >
      {options.length === 0 ? (
        <p className="px-2 py-1.5 text-muted-foreground">{empty}</p>
      ) : (
        options.map((option, i) => (
          <button
            key={optionKey(option)}
            type="button"
            role="option"
            aria-selected={i === highlight}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
              i === highlight && 'bg-accent',
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              onChoose(option);
            }}
          >
            {option.kind === 'skill' ? (
              <>
                <span className="font-medium">{option.skill.name}</span>
                <span className="truncate text-muted-foreground">{option.skill.summary}</span>
              </>
            ) : option.kind === 'everyone' ? (
              <>
                <span className="size-5" aria-hidden />
                <span>@everyone</span>
                <span className="text-muted-foreground">Every Bot in the group</span>
              </>
            ) : (
              <>
                <Avatar params={option.bot.avatar} size={20} fileUrl={fileUrl} />
                <span>{option.bot.name}</span>
                <span className="text-muted-foreground">@{option.bot.handle}</span>
                {option.adds && (
                  <span className="ml-auto text-xs text-muted-foreground">Adds to the group</span>
                )}
              </>
            )}
          </button>
        ))
      )}
    </div>
  );
}
