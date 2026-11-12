import {
  ActivityIcon,
  CopyIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  MessageIcon,
  MoreIcon,
} from '@openbots/ui';
import { ACTION_ICON } from './reactions-view.js';

/**
 * A message's More menu: the actions that are not React. Each is offered only
 * when it applies; with none, there is no menu.
 */
export function MessageMore({
  onReply,
  onActivity,
  copyText,
}: {
  onReply?: () => void;
  onActivity?: () => void;
  copyText?: string;
}) {
  if (!onReply && !onActivity && !copyText) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="More actions" title="More" className={ACTION_ICON}>
          <MoreIcon />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {onReply && (
          <DropdownMenuItem onSelect={onReply}>
            <MessageIcon className="size-4 text-muted-foreground" />
            Reply in thread
          </DropdownMenuItem>
        )}
        {onActivity && (
          <DropdownMenuItem onSelect={onActivity}>
            <ActivityIcon className="size-4 text-muted-foreground" />
            Activity
          </DropdownMenuItem>
        )}
        {copyText && (
          <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(copyText)}>
            <CopyIcon className="size-4 text-muted-foreground" />
            Copy text
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A message's text parts, as the reader sees them, for Copy text. */
export function messageText(parts: readonly { type: string; text?: unknown }[]): string {
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => (p.text as string).trim())
    .filter(Boolean)
    .join('\n\n');
}
