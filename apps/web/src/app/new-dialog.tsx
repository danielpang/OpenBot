import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { NewBotForm } from '../features/bots/new-bot-form.js';
import { botsQuery } from '../features/bots/queries.js';
import { GROUP_MIN } from '../features/chats/api.js';
import { NewChat } from '../features/chats/new-chat.js';

// New (Cmd/Ctrl+N in the Mac app, Alt+N in a browser, B2): a Bot from a name
// and an icon, or a group chat with two to six Bots (C4). A new Bot opens on
// its chat, where it has already asked what to work on.

export function NewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Remounted on every open, so each New starts from the first screen. */}
        {open && <NewFlow onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

type Mode = { kind: 'bot' } | { kind: 'chat' };

export function NewFlow({ onDone, initial = { kind: 'bot' } }: { onDone(): void; initial?: Mode }) {
  const [mode, setMode] = useState<Mode>(initial);
  const bots = useQuery(botsQuery);
  const navigate = useNavigate();

  if (mode.kind === 'chat') {
    return <NewChat onBack={() => setMode({ kind: 'bot' })} onDone={onDone} />;
  }

  const tooFew = (bots.data?.items.length ?? 0) < GROUP_MIN;
  return (
    <>
      <DialogHeader>
        <DialogTitle>New Bot</DialogTitle>
        <DialogDescription>Pick a name and an icon.</DialogDescription>
      </DialogHeader>
      <NewBotForm
        onCreated={(bot) => {
          onDone();
          void navigate({ to: '/bots/$botId', params: { botId: bot.id } });
        }}
      />
      <Button
        variant="outline"
        className="justify-start"
        disabled={tooFew}
        onClick={() => setMode({ kind: 'chat' })}
      >
        New chat
        {tooFew && <span className="ml-auto text-xs text-muted-foreground">needs two Bots</span>}
      </Button>
    </>
  );
}
