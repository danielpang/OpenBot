import { Input, SaveButton, useSaveState } from '@openbots/ui';
import { SettingsSection } from '../../app/settings-layout.js';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { auth, meQuery } from '../../app/api.js';

// The owner's name, which Bots use to address them. In the Mac app's local
// mode it is all there is of the owner in Settings (routes/_app/settings/general.tsx).

export function YourName({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(name);
  const save = useMutation({
    mutationFn: (next: string) => auth.updateUser({ name: next }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
  });
  const saved = useSaveState(save);
  const trimmed = value.trim();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed && trimmed !== name) save.mutate(trimmed);
  }

  return (
    <SettingsSection title="Your name" description="Bots use it to address you.">
      <form className="flex gap-2" onSubmit={submit}>
        <Input
          name="name"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={100}
          required
          aria-label="Your name"
        />
        <SaveButton type="submit" state={saved.state} disabled={!trimmed || trimmed === name}>
          Save
        </SaveButton>
      </form>
      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
    </SettingsSection>
  );
}
