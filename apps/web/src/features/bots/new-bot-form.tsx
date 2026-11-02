import { AvatarPicker } from '@openbots/avatars/react';
import { Button, Input } from '@openbots/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { startingAvatar, useCreateBot } from './create.js';
import { botsQuery, takenAvatars, type Bot } from './queries.js';

/**
 * A new Bot's name and icon, all creating one asks for (B2): New and the
 * setup wizard's first Bot both use it. The Bot then asks in its chat what
 * to work on.
 */
export function NewBotForm({
  onCreated,
  defaultName = '',
  submitLabel = 'Create',
}: {
  onCreated(bot: Bot): void;
  defaultName?: string;
  submitLabel?: string;
}) {
  const queryClient = useQueryClient();
  const taken = takenAvatars(queryClient.getQueryData(botsQuery.queryKey)?.items ?? []);
  const [name, setName] = useState(defaultName);
  const [avatar, setAvatar] = useState(() => startingAvatar(taken));
  const create = useCreateBot();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) create.mutate({ name, avatar }, { onSuccess: onCreated });
  };

  return (
    <form className="flex flex-col gap-4" aria-label="New Bot" onSubmit={submit}>
      <AvatarPicker value={avatar} onChange={setAvatar} taken={taken} />
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name"
        aria-label="Bot name"
        maxLength={64}
        required
        autoFocus
      />
      {create.error && (
        <p role="alert" className="text-sm text-destructive">
          {create.error.message}
        </p>
      )}
      <Button type="submit" disabled={!name.trim() || create.isPending}>
        {submitLabel}
      </Button>
    </form>
  );
}
