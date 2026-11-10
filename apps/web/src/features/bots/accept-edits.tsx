import { acceptsEdits, withAcceptEdits, ACCEPT_EDITS_HELP } from '@openbots/shared';
import { unwrap } from '@openbots/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../app/api.js';
import { botsQuery, updateBot } from './queries.js';
import { ErrorText } from '../models/error-text.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Select,
} from '@openbots/ui';

export function AcceptEdits({
  botId,
  composer = false,
  menu = false,
}: {
  botId: string;
  composer?: boolean;
  menu?: boolean;
}) {
  const bots = useQuery(botsQuery);
  const cache = useQueryClient();
  const bot = bots.data?.items.find((b) => b.id === botId);
  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const fresh = await unwrap(api.GET('/api/v1/bots/{id}', { params: { path: { id: botId } } }));
      return updateBot(botId, { toolPolicy: withAcceptEdits(fresh.toolPolicy, enabled) });
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: botsQuery.queryKey }),
  });
  if (!bot) return null;
  const enabled = acceptsEdits(bot.toolPolicy);
  if (menu)
    return (
      <>
        <DropdownMenuLabel>File edit approvals</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={save.isPending}
          onSelect={(event) => {
            event.preventDefault();
            save.mutate(false);
          }}
        >
          <span className="flex-1">Ask before edits</span>
          {!enabled && <span aria-label="Selected">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={save.isPending}
          onSelect={(event) => {
            event.preventDefault();
            save.mutate(true);
          }}
        >
          <span className="flex-1">Accept edits</span>
          {enabled && <span aria-label="Selected">✓</span>}
        </DropdownMenuItem>
        <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">{ACCEPT_EDITS_HELP}</p>
        <ErrorText error={save.error} />
      </>
    );
  if (composer)
    return (
      <div data-edit-mode className="flex flex-col items-start gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={save.isPending}
              aria-label={`Edit mode: ${enabled ? 'Accept edits' : 'Ask before edits'}`}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-muted px-3 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {enabled ? 'Accept edits' : 'Ask before edits'}
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="m5 6 3-3 3 3M5 10l3 3 3-3" />
              </svg>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-72">
            <DropdownMenuLabel>File edit approvals</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => save.mutate(false)} disabled={save.isPending}>
              <span className="flex-1">Ask before edits</span>
              {!enabled && <span aria-label="Selected">✓</span>}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => save.mutate(true)} disabled={save.isPending}>
              <span className="flex-1">Accept edits</span>
              {enabled && <span aria-label="Selected">✓</span>}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{ACCEPT_EDITS_HELP}</p>
          </DropdownMenuContent>
        </DropdownMenu>
        <ErrorText error={save.error} />
      </div>
    );
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-2 [&::-webkit-details-marker]:hidden">
        Accept edits: {acceptsEdits(bot.toolPolicy) ? 'On' : 'Off'}
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="m5 6 3-3 3 3M5 10l3 3 3-3" />
        </svg>
      </summary>
      <label className="flex items-center gap-2 py-2">
        <span>File edit approvals</span>
        <Select
          className="w-auto"
          aria-label="Accept edits"
          disabled={save.isPending}
          value={acceptsEdits(bot.toolPolicy) ? 'on' : 'off'}
          onChange={(e) => save.mutate(e.target.value === 'on')}
        >
          <option value="off">Ask before edits</option>
          <option value="on">Accept edits</option>
        </Select>
      </label>
      <p>{ACCEPT_EDITS_HELP}</p>
      <ErrorText error={save.error} />
    </details>
  );
}
