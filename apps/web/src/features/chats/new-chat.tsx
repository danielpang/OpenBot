import { Button, DialogDescription, DialogHeader, DialogTitle, Input } from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { meQuery } from '../../app/api.js';
import { botsQuery, rosterSections } from '../bots/queries.js';
import { groupLimit, useCreateGroup } from './api.js';
import { BotPicker, pickState } from './bot-picker.js';

// New chat (C4, PRD section 5): pick two to six Bots, optionally name the
// group, and start it. Writing normally then lets the Bots decide who answers
// (C5); there is nothing to assign (principle 8).

export function NewChat({ onBack, onDone }: { onBack(): void; onDone(): void }) {
  const bots = useQuery(botsQuery);
  const me = useQuery(meQuery);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const create = useCreateGroup();
  const navigate = useNavigate();
  const limit = groupLimit(me.data?.limits);
  const { pinned, bots: rest } = rosterSections(bots.data?.items ?? []);
  const { ready } = pickState(selected.length, limit);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    create.mutate(
      { botIds: selected, ...(title.trim() ? { title: title.trim() } : {}) },
      {
        onSuccess: (chat) => {
          onDone();
          void navigate({ to: '/groups/$chatId', params: { chatId: chat.id } });
        },
      },
    );
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>New chat</DialogTitle>
        <DialogDescription>Pick Bots to talk with. Use @ to address one.</DialogDescription>
      </DialogHeader>
      <BotPicker
        bots={[...pinned, ...rest]}
        selected={selected}
        limit={limit}
        onChange={setSelected}
      />
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Name (optional)"
        aria-label="Group name"
        maxLength={200}
      />
      {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" className="ml-auto" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" disabled={!ready || create.isPending}>
          Start chat
        </Button>
      </div>
    </form>
  );
}
