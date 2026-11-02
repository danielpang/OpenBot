import type { z } from 'zod';
import type { FilePropsSchema } from '../kinds/file.js';
import { defaultFileUrl, type WidgetRendererProps } from './types.js';

// A file card (plan 12.1, 12.2): name, type and size, with open and download.

type FileProps = z.infer<typeof FilePropsSchema>;

export function FileCard({
  file,
  fileUrl = defaultFileUrl,
}: {
  file: Pick<FileProps, 'file_id' | 'name' | 'mime' | 'size' | 'description'>;
  fileUrl?: (fileId: string) => string;
}) {
  const url = fileUrl(file.file_id);
  const meta = [
    fileTypeLabel(file.name, file.mime),
    file.size !== undefined && formatBytes(file.size),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="flex max-w-sm items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
      <div
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
      >
        {extension(file.name) || 'file'}
      </div>
      <div className="min-w-0 flex-1">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="block truncate font-medium hover:underline"
        >
          {file.name}
        </a>
        <div className="truncate text-xs text-muted-foreground">{file.description ?? meta}</div>
      </div>
      <a
        href={url}
        download={file.name}
        className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
      >
        Download
      </a>
    </div>
  );
}

export function FileWidget({ props, fileUrl }: WidgetRendererProps<FileProps>) {
  return <FileCard file={props} fileUrl={fileUrl} />;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && name.length - dot <= 5 ? name.slice(dot + 1) : '';
}

function fileTypeLabel(name: string, mime: string): string {
  return extension(name).toUpperCase() || mime;
}
