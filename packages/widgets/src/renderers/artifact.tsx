import type { ArtifactKind } from '@openbots/shared';
import type { z } from 'zod';
import type { ArtifactPropsSchema } from '../kinds/artifact.js';
import type { WidgetRendererProps } from './types.js';

// An Artifact card (plan 12.1, A2): kind icon, title and version, with Open
// (the viewer in the app's right panel) and Download. The card's props are
// the version it was posted with; `state` carries what the app has heard
// since from `artifact.updated`, so the card shows the current title and
// version and Open and Download follow it.

type ArtifactProps = z.infer<typeof ArtifactPropsSchema>;

/** The live view of the Artifact, newer than the props when it has been edited since. */
export interface ArtifactCardState {
  title?: string;
  version?: number;
}

export const defaultArtifactDownloadUrl = (artifactId: string, version?: number) =>
  `/api/v1/artifacts/${encodeURIComponent(artifactId)}/download` +
  (version !== undefined ? `?version=${version}` : '');

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  document: 'Document',
  code: 'Code',
  data: 'Data',
  design: 'Design',
  file: 'File',
};

export function ArtifactCard({
  artifact,
  live,
  onOpen,
  downloadUrl = defaultArtifactDownloadUrl,
}: {
  artifact: ArtifactProps;
  live?: ArtifactCardState;
  onOpen?: (artifactId: string, version?: number) => void;
  downloadUrl?: (artifactId: string, version?: number) => string;
}) {
  const title = live?.title ?? artifact.title;
  const version = Math.max(artifact.version ?? 0, live?.version ?? 0) || undefined;
  return (
    <div
      className="flex max-w-sm items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm"
      data-artifact={artifact.artifact_id}
    >
      <div
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      >
        <ArtifactKindIcon kind={artifact.kind} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {ARTIFACT_KIND_LABELS[artifact.kind]}
          {version !== undefined && ` · v${version}`}
        </div>
      </div>
      {onOpen && (
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          onClick={() => onOpen(artifact.artifact_id, version)}
        >
          Open
        </button>
      )}
      <a
        href={downloadUrl(artifact.artifact_id, version)}
        download
        className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
      >
        Download
      </a>
    </div>
  );
}

export function ArtifactWidget({
  props,
  state,
  onOpenArtifact,
}: WidgetRendererProps<ArtifactProps, ArtifactCardState>) {
  return <ArtifactCard artifact={props} live={state} onOpen={onOpenArtifact} />;
}

const ICON_PATHS: Record<ArtifactKind, string> = {
  document: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  code: 'M9 8l-4 4 4 4M15 8l4 4-4 4',
  data: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  design: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
};

export function ArtifactKindIcon({ kind, className }: { kind: ArtifactKind; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      data-kind={kind}
    >
      <path d={ICON_PATHS[kind]} />
    </svg>
  );
}
