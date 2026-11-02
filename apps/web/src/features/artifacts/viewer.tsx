import { ApiError } from '@openbots/api-client';
import { isTextMime, lineDiff, rebaseEdit } from '@openbots/artifacts';
import { Button, cn } from '@openbots/ui';
import {
  ARTIFACT_KIND_LABELS,
  ArtifactKindIcon,
  defaultArtifactDownloadUrl,
  formatBytes,
} from '@openbots/widgets/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { botsQuery } from '../bots/queries.js';
import { Markdown } from '../transcript/markdown.js';
import { useShowBotPanel } from '../transcript/panel.js';
import {
  artifactBlobQuery,
  artifactQuery,
  artifactTextQuery,
  artifactVersionsQuery,
  contentUrl,
  saveArtifact,
  type Artifact,
  type ArtifactVersion,
} from './api.js';
import { CodeEditor } from './code-editor.js';
import { parseTable, type Table } from './data.js';
import { useArtifactRefresh } from './live.js';

// The Artifact viewer in the right panel (plan 12.1, 18.4; A2): the selected
// version rendered for its kind, the version history with a switch, a line
// diff between any two versions of a text kind, Download, and inline editing
// of document, code and data, where Save writes a version attributed to the
// owner (`PUT /artifacts/{id}`) from the version the edit started on. When the
// Bot saved a newer version meanwhile, the editor offers to reapply the
// owner's changes onto it or to save theirs as the newest version (the Bot's
// stays in the history). Versions preview by type: raster images and SVG
// through `<img>`, PDFs in the browser's viewer, text of any kind (a `.log`
// published as a file too) as text, anything else as a download. The history
// says who made each version: the Bot, with its run's activity log (A1), or
// the owner.

const TEXT_KINDS: readonly Artifact['kind'][] = ['document', 'code', 'data'];

/** Text versions of a file or design larger than this are not loaded into the viewer. */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export function ArtifactViewer({ artifactId, version }: { artifactId: string; version?: number }) {
  const artifact = useQuery(artifactQuery(artifactId));
  const versions = useQuery(artifactVersionsQuery(artifactId));
  const [selected, setSelected] = useState(version);
  const [mode, setMode] = useState<'view' | 'edit' | 'compare'>('view');
  useArtifactRefresh({ artifactId });

  const failure = artifact.error ?? versions.error;
  if (failure) return <p className="p-4 text-sm text-destructive">{failure.message}</p>;
  if (!artifact.data || !versions.data) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }

  const current = artifact.data.currentVersion;
  const shown = versions.data.find((v) => v.version === (selected ?? current?.version)) ?? current;
  if (!shown) return <p className="p-4 text-sm text-muted-foreground">No versions yet.</p>;

  const text = TEXT_KINDS.includes(artifact.data.kind);
  const isCurrent = shown.version === current?.version;
  const select = (next: number) => {
    setSelected(next);
    setMode((m) => (m === 'edit' ? 'view' : m));
  };

  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <div className="flex items-start gap-2">
        <ArtifactKindIcon kind={artifact.data.kind} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium">{artifact.data.title}</h3>
          <p className="text-xs text-muted-foreground">
            {ARTIFACT_KIND_LABELS[artifact.data.kind]} · v{shown.version}
            {isCurrent ? ' (current)' : ` of ${current?.version}`}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {text && isCurrent && mode !== 'edit' && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setSelected(shown.version);
              setMode('edit');
            }}
          >
            Edit
          </Button>
        )}
        {text && versions.data.length > 1 && mode !== 'edit' && (
          <Button
            size="sm"
            variant={mode === 'compare' ? 'secondary' : 'outline'}
            aria-pressed={mode === 'compare'}
            onClick={() => setMode(mode === 'compare' ? 'view' : 'compare')}
          >
            Compare
          </Button>
        )}
        <Button size="sm" variant="outline" asChild>
          <a href={defaultArtifactDownloadUrl(artifactId, shown.version)} download>
            Download
          </a>
        </Button>
      </div>

      {mode === 'edit' ? (
        <ArtifactEditor
          artifact={artifact.data}
          version={shown}
          onDone={(saved) => {
            if (saved !== undefined) setSelected(saved);
            setMode('view');
          }}
        />
      ) : mode === 'compare' && text ? (
        <CompareVersions artifactId={artifactId} versions={versions.data} to={shown.version} />
      ) : (
        <VersionContent artifact={artifact.data} version={shown} />
      )}

      <VersionHistory
        artifact={artifact.data}
        versions={versions.data}
        selected={shown.version}
        onSelect={select}
      />
    </div>
  );
}

function VersionHistory({
  artifact,
  versions,
  selected,
  onSelect,
}: {
  artifact: Artifact;
  versions: ArtifactVersion[];
  selected: number;
  onSelect(version: number): void;
}) {
  const bots = useQuery(botsQuery);
  const botName = bots.data?.items.find((b) => b.id === artifact.botId)?.name ?? 'the Bot';
  const showPanel = useShowBotPanel(artifact.botId ?? '');
  return (
    <section className="flex flex-col gap-1 border-t pt-3">
      <h4 className="text-xs font-medium text-muted-foreground">History</h4>
      <ol className="flex flex-col">
        {versions.map((v) => (
          <li key={v.id} className="flex flex-col" data-version={v.version}>
            <button
              type="button"
              aria-current={v.version === selected ? 'true' : undefined}
              className={cn(
                'flex w-full gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent',
                v.version === selected && 'bg-accent',
              )}
              onClick={() => onSelect(v.version)}
            >
              <span className="font-medium">v{v.version}</span>
              {v.summary && <span className="text-muted-foreground">{v.summary}</span>}
              <span className="ml-auto text-muted-foreground">{formatWhen(v.createdAt)}</span>
            </button>
            <span className="px-2 pb-1 text-xs text-muted-foreground">
              {v.createdBy === 'user' ? (
                'Edited by you'
              ) : (
                <>
                  {`By ${botName}`}
                  {v.createdByRunId && artifact.botId && (
                    <>
                      {' · '}
                      <button
                        type="button"
                        className="font-medium text-foreground hover:underline"
                        onClick={() => showPanel({ kind: 'activity', runId: v.createdByRunId! })}
                      >
                        Run activity log
                      </button>
                    </>
                  )}
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** One version, rendered for its kind and mime type. */
function VersionContent({ artifact, version }: { artifact: Artifact; version: ArtifactVersion }) {
  const { mime } = version;
  if (mime.startsWith('image/')) {
    return (
      <img
        src={contentUrl(artifact.id, version.version)}
        alt={artifact.title}
        className="max-w-full rounded border object-contain"
      />
    );
  }
  if (mime === 'application/pdf') return <PdfPreview artifact={artifact} version={version} />;
  const tooBig = !TEXT_KINDS.includes(artifact.kind) && version.size > TEXT_PREVIEW_MAX_BYTES;
  if (!isTextMime(mime) || tooBig) {
    return (
      <p className="text-muted-foreground">
        No preview for this file ({formatBytes(version.size)}). Download it to open it.
      </p>
    );
  }
  return <TextContent artifact={artifact} version={version} />;
}

function TextContent({ artifact, version }: { artifact: Artifact; version: ArtifactVersion }) {
  const text = useQuery(artifactTextQuery(artifact.id, version.version));
  if (text.error) return <p className="text-destructive">{text.error.message}</p>;
  if (text.data === undefined) return <p className="text-muted-foreground">Loading…</p>;
  if (artifact.kind === 'document' && version.mime === 'text/markdown') {
    return <Markdown text={text.data} />;
  }
  if (artifact.kind === 'data') {
    const table = parseTable(text.data, version.mime);
    if (table) return <DataTable table={table} />;
  }
  if (artifact.kind === 'document') {
    return <p className="whitespace-pre-wrap">{text.data}</p>;
  }
  return (
    <CodeEditor
      key={version.version}
      value={text.data}
      fileName={artifact.title}
      mime={version.mime}
      label={`${artifact.title}, version ${version.version}`}
    />
  );
}

export function DataTable({ table }: { table: Table }) {
  return (
    <div className="overflow-auto rounded border">
      <table className="w-full text-xs">
        <thead className="bg-muted text-left">
          <tr>
            {table.columns.map((column, i) => (
              <th key={i} className="px-2 py-1 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r} className="border-t">
              {row.map((value, c) => (
                <td key={c} className="px-2 py-1 align-top">
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The browser's own PDF viewer, over a blob URL (the content route is sandboxed). */
function PdfPreview({ artifact, version }: { artifact: Artifact; version: ArtifactVersion }) {
  const blob = useQuery(artifactBlobQuery(artifact.id, version.version));
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob.data) return;
    const next = URL.createObjectURL(blob.data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob.data]);
  if (blob.error) return <p className="text-destructive">{blob.error.message}</p>;
  if (!url) return <p className="text-muted-foreground">Loading…</p>;
  return <iframe src={url} title={artifact.title} className="h-[70vh] w-full rounded border" />;
}

/** The version an edit is based on, its text, and what the editor opened with. */
interface EditBase {
  version: number;
  text: string;
  start: string;
}

const isConflict = (error: unknown) =>
  error instanceof ApiError && error.code === 'VERSION_CONFLICT';

function ArtifactEditor({
  artifact,
  version,
  onDone,
}: {
  artifact: Artifact;
  version: ArtifactVersion;
  onDone(saved?: number): void;
}) {
  const queryClient = useQueryClient();
  const text = useQuery(artifactTextQuery(artifact.id, version.version));
  // Moves to a newer version when the owner reapplies their changes onto it.
  const [rebased, setRebased] = useState<EditBase>();
  const [draft, setDraft] = useState<string>();
  /** Set after Reapply found the changes overlap the newer version. */
  const [overlap, setOverlap] = useState(false);
  const base: EditBase | undefined =
    rebased ??
    (text.data === undefined
      ? undefined
      : { version: version.version, text: text.data, start: text.data });

  /** The current version and its text, fetched afresh. */
  const latest = async () => {
    const fresh = await queryClient.fetchQuery({ ...artifactQuery(artifact.id), staleTime: 0 });
    const current = fresh.currentVersion!;
    const content = await queryClient.fetchQuery(artifactTextQuery(artifact.id, current.version));
    return { version: current.version, text: content };
  };

  const save = useMutation({
    mutationFn: ({ content, baseVersion }: { content: string; baseVersion: number }) =>
      saveArtifact(artifact.id, content, baseVersion),
    onSuccess: async (saved, { content }) => {
      queryClient.setQueryData(artifactQuery(artifact.id).queryKey, saved);
      if (saved.currentVersion) {
        const { queryKey } = artifactTextQuery(artifact.id, saved.currentVersion.version);
        queryClient.setQueryData(queryKey, content);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: artifactVersionsQuery(artifact.id).queryKey }),
        artifact.botId &&
          queryClient.invalidateQueries({ queryKey: ['bot-artifacts', artifact.botId] }),
      ]);
      onDone(saved.currentVersion?.version);
    },
  });
  // Reapply: the owner's changes since `base` replayed onto the newest version.
  const reapply = useMutation({
    mutationFn: latest,
    onSuccess: (newest) => {
      const merged = rebaseEdit(base!.text, draft ?? base!.start, newest.text);
      if (merged === null) return setOverlap(true);
      setRebased({ ...newest, start: merged });
      setDraft(undefined);
      setOverlap(false);
      save.reset();
      void queryClient.invalidateQueries({ queryKey: artifactVersionsQuery(artifact.id).queryKey });
    },
  });
  // Keep mine: the owner's text saved on top of the newest version, which stays in the history.
  const keepMine = useMutation({
    mutationFn: latest,
    onSuccess: (newest) =>
      save.mutate({ content: draft ?? base!.start, baseVersion: newest.version }),
  });

  if (!base) return <p className="text-muted-foreground">Loading…</p>;
  const content = draft ?? base.start;
  const conflict = isConflict(save.error);
  const busy = save.isPending || reapply.isPending || keepMine.isPending;
  return (
    <div className="flex flex-col gap-2">
      {rebased && (
        <p className="text-xs text-muted-foreground" data-rebased={rebased.version}>
          Your changes are now on v{rebased.version}. Check them, then save.
        </p>
      )}
      <div className="max-h-[60vh] overflow-auto rounded border">
        <CodeEditor
          key={`${base.version}:${base.start.length}`}
          value={base.start}
          fileName={artifact.title}
          mime={version.mime}
          label={`Edit ${artifact.title}`}
          onChange={setDraft}
        />
      </div>
      {conflict ? (
        <div className="flex flex-col gap-2 rounded border p-2 text-xs" role="alert">
          <p>
            {overlap
              ? 'Your changes overlap the newer version, so they cannot be reapplied. Save yours as newest instead.'
              : `A newer version was saved while you were editing v${base.version}. Reapply your changes, or save yours as newest.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {!overlap && (
              <Button size="sm" disabled={busy} onClick={() => reapply.mutate()}>
                Reapply my changes
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => keepMine.mutate()}>
              Save mine as newest
            </Button>
          </div>
        </div>
      ) : (
        save.error && <p className="text-xs text-destructive">{save.error.message}</p>
      )}
      {(reapply.error ?? keepMine.error) && (
        <p className="text-xs text-destructive">{(reapply.error ?? keepMine.error)!.message}</p>
      )}
      <div className="flex gap-2">
        {!conflict && (
          <Button
            size="sm"
            disabled={busy || content === base.text}
            onClick={() => save.mutate({ content, baseVersion: base.version })}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function CompareVersions({
  artifactId,
  versions,
  to: initialTo,
}: {
  artifactId: string;
  versions: ArtifactVersion[];
  to: number;
}) {
  const [to, setTo] = useState(initialTo);
  const [from, setFrom] = useState(
    () => versions.find((v) => v.version < initialTo)?.version ?? versions.at(-1)!.version,
  );
  const choose = (label: string, value: number, onChange: (v: number) => void) => (
    <label className="flex items-center gap-1">
      {label}
      <select
        aria-label={`Compare ${label.toLowerCase()}`}
        className="rounded border bg-background px-1 py-0.5"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {versions.map((v) => (
          <option key={v.id} value={v.version}>
            v{v.version}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3 text-xs">
        {choose('From', from, setFrom)}
        {choose('To', to, setTo)}
      </div>
      <VersionDiff artifactId={artifactId} from={from} to={to} />
    </div>
  );
}

export function VersionDiff({
  artifactId,
  from,
  to,
}: {
  artifactId: string;
  from: number;
  to: number;
}) {
  const before = useQuery(artifactTextQuery(artifactId, from));
  const after = useQuery(artifactTextQuery(artifactId, to));
  const failure = before.error ?? after.error;
  if (failure) return <p className="text-destructive">{failure.message}</p>;
  if (before.data === undefined || after.data === undefined) {
    return <p className="text-muted-foreground">Loading…</p>;
  }
  const lines = lineDiff(before.data, after.data);
  if (lines.every((line) => line.type === 'same')) {
    return <p className="text-muted-foreground">No differences.</p>;
  }
  return (
    <pre
      className="overflow-auto rounded border font-mono text-xs"
      aria-label={`Changes from v${from} to v${to}`}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          data-diff={line.type}
          className={cn(
            'whitespace-pre-wrap px-2',
            line.type === 'added' && 'bg-green-500/15',
            line.type === 'removed' && 'bg-red-500/15',
          )}
        >
          {line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  '}
          {line.text}
        </div>
      ))}
    </pre>
  );
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
