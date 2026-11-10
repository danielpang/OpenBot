import { Badge, Button, cn } from '@openbots/ui';
import type { ServerProfile } from '../ipc.js';
import { KindIcon } from './icons.js';
import { connectionLine, Notice } from './parts.js';
import type { StartFlow, StartState } from './start-flow.js';

// The saved connections to switch to, the current one marked.

export function SavedConnections({
  flow,
  state,
  className,
}: {
  flow: StartFlow;
  state: StartState;
  className?: string;
}) {
  const { saved, error } = state;
  if (!saved.visible) return null;
  return (
    <section id="saved" aria-labelledby="saved-title" className={className}>
      <h2 id="saved-title" className="mb-2 px-1 text-xs font-medium text-muted-foreground">
        Saved connections
      </h2>
      <ul id="profiles" className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
        {saved.profiles.map((profile) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            current={profile.id === saved.currentId}
            flow={flow}
          />
        ))}
      </ul>
      {error?.place === 'saved' && <Notice className="mt-3" title={error.message} />}
    </section>
  );
}

function ProfileRow({
  profile,
  current,
  flow,
}: {
  profile: ServerProfile;
  current: boolean;
  flow: StartFlow;
}) {
  return (
    <li
      className={cn('flex items-center gap-3 px-4 py-3', current && 'bg-muted/40')}
      aria-current={current || undefined}
      data-profile={profile.id}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background text-muted-foreground">
        <KindIcon kind={profile.kind} className="size-4" />
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{profile.name}</span>
          {current && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
              Current
            </Badge>
          )}
        </span>
        <span className="truncate text-xs text-muted-foreground">{connectionLine(profile)}</span>
      </span>
      {(profile.kind === 'remote' || profile.kind === 'paired') && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => void flow.saved.remove(profile.id)}
          aria-label={`Remove ${profile.name}`}
        >
          Remove
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void flow.saved.open(profile.id)}
        aria-label={`Open ${profile.name}`}
      >
        Open
      </Button>
    </li>
  );
}
