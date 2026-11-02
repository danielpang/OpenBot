// The fallback for a kind this build has no renderer for, or props that do
// not match the kind: a quiet line rather than an error, so a transcript with
// widgets from a newer server still renders.

export function UnknownWidget({ kind }: { kind: string }) {
  return (
    <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
      Unknown widget <code>{kind}</code>
    </div>
  );
}
