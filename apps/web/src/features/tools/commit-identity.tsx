import { Input, SaveButton, useSaveState } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { gitIdentityQuery, putGitIdentity, type GitIdentity } from '../repos/api.js';
import { ErrorText } from './fields.js';

// Who a coding session's commits are by (GH8): the Bot, with the owner as
// co-author, or the owner. The name and address are also git's identity on
// the computer, so commits made in its terminal carry them too.

type CommitAs = GitIdentity['commitAs'];

const CHOICES: { value: CommitAs; label: string }[] = [
  { value: 'bot', label: 'The Bot' },
  { value: 'owner', label: 'Me' },
];

/** The placeholder address local mode gives the owner; GitHub links it to no one. */
const isPlaceholder = (email: string) => /@openbots\.local$/i.test(email);

export function CommitIdentity() {
  const queryClient = useQueryClient();
  const identity = useQuery(gitIdentityQuery);
  const [commitAs, setCommitAs] = useState<CommitAs>('bot');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  useEffect(() => {
    if (!identity.data) return;
    setCommitAs(identity.data.commitAs);
    setName(identity.data.name ?? '');
    setEmail(identity.data.email ?? '');
  }, [identity.data]);
  const save = useMutation({
    mutationFn: () =>
      putGitIdentity({ commitAs, name: name.trim() || null, email: email.trim() || null }),
    onSuccess: (data) => queryClient.setQueryData(gitIdentityQuery.queryKey, data),
  });
  const saved = useSaveState(save);

  if (identity.error) return <ErrorText error={identity.error} />;
  if (!identity.data) return null;
  const account = identity.data.account;
  const fallbackEmail = isPlaceholder(account.email) ? '' : account.email;
  const shownName = name.trim() || account.name;
  const shownEmail = email.trim() || fallbackEmail;
  const changed =
    commitAs !== identity.data.commitAs ||
    (name.trim() || null) !== identity.data.name ||
    (email.trim() || null) !== identity.data.email;

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} aria-label="Commit identity">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-foreground">Commits are by</span>
          <span className="text-xs text-muted-foreground">
            {commitAs === 'bot'
              ? 'The Bot authors each commit and credits you as co-author.'
              : 'You author each commit, as if you made it yourself.'}
          </span>
        </div>
        <div
          role="radiogroup"
          aria-label="Commits are by"
          className="flex gap-1 rounded-md bg-muted p-0.5"
        >
          {CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={commitAs === choice.value}
              onClick={() => setCommitAs(choice.value)}
              className={
                commitAs === choice.value
                  ? 'rounded bg-background px-3 py-1 text-xs font-medium text-foreground shadow-sm'
                  : 'rounded px-3 py-1 text-xs font-medium text-muted-foreground'
              }
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          Your name
          <Input
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder={account.name}
            maxLength={100}
            className="h-8"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          Your email
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            placeholder={fallbackEmail || 'The email on your GitHub account'}
            maxLength={254}
            className="h-8"
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground" data-identity-preview>
        {shownEmail ? (
          <>
            {commitAs === 'bot' ? 'Co-author' : 'Author'}:{' '}
            <span className="font-mono text-foreground">
              {shownName} &lt;{shownEmail}&gt;
            </span>
            . Use the email on your GitHub account so commits link to you.
          </>
        ) : (
          'Add the email on your GitHub account so commits link to you.'
        )}
      </p>
      <div>
        <SaveButton type="submit" size="sm" state={saved.state} disabled={!changed}>
          Save
        </SaveButton>
      </div>
      <ErrorText error={save.error} />
    </form>
  );
}
