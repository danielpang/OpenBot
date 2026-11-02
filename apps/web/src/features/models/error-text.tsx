export function ErrorText({ error }: { error: Error | null }) {
  return error ? <p className="text-sm text-destructive">{error.message}</p> : null;
}
