import { ARTIFACT_KIND_LABELS, ArtifactKindIcon } from '@openbots/widgets/react';
import { useQuery } from '@tanstack/react-query';
import { useBotPanel } from '../transcript/panel.js';
import { botArtifactsQuery } from './api.js';
import { useArtifactRefresh } from './live.js';
import { formatWhen } from './viewer.js';

// The Bot's Artifacts tab (A4): everything the Bot has produced, most
// recently updated first, with kind, title, versions and when it last
// changed. A row opens the viewer in the right panel.

export function ArtifactsTab({ botId }: { botId: string }) {
  const artifacts = useQuery(botArtifactsQuery(botId));
  const showPanel = useBotPanel(botId);
  useArtifactRefresh({ botId });

  if (artifacts.error) {
    return <p className="p-8 text-sm text-destructive">{artifacts.error.message}</p>;
  }
  if (!artifacts.data) return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-8">
      {!artifacts.data.length ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet. Files this Bot writes appear here.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {artifacts.data.map((artifact) => {
            const versions = artifact.currentVersion?.version ?? 0;
            return (
              <li key={artifact.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => showPanel({ kind: 'artifact', artifactId: artifact.id })}
                >
                  <ArtifactKindIcon
                    kind={artifact.kind}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{artifact.title}</span>
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">
                    {ARTIFACT_KIND_LABELS[artifact.kind]}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {versions === 1 ? '1 version' : `${versions} versions`}
                  </span>
                  <span className="w-36 shrink-0 text-right text-xs text-muted-foreground">
                    {formatWhen(artifact.updatedAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
