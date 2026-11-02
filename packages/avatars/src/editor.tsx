import type { Avatar as AvatarValue } from '@openbots/shared';
import { Button, cn } from '@openbots/ui';
import { useRef, useState, type ChangeEvent } from 'react';
import { Avatar, defaultFileUrl } from './avatar.js';
import { resolveParts, shuffle, type AvatarParams, type GeneratedAvatar } from './generate.js';
import { AVATAR_ACCESSORIES, AVATAR_EYES, AVATAR_PALETTES } from './parts.js';
import { ShapePicker } from './picker.js';
import { AVATAR_STATES } from './states.js';
import { AVATAR_IMAGE_TYPES, uploadAvatarImage } from './upload.js';

// The profile avatar editor (I1, plan 13): shuffle, the Bot shapes (Moon,
// Box, Egg) and a picker per other part, a preview of all six states, and an
// image upload. A shape picked here is pinned, so Shuffle keeps it.

const PICKERS = [
  { part: 'palette', label: 'Colours', options: AVATAR_PALETTES },
  { part: 'eyes', label: 'Eyes', options: AVATAR_EYES },
  { part: 'accessory', label: 'Accessory', options: AVATAR_ACCESSORIES },
] as const;

export interface AvatarEditorProps {
  value: AvatarValue;
  onChange: (value: AvatarValue) => void;
  /** Stores an image and returns its file id; defaults to `POST /api/v1/files`. */
  upload?: (file: File) => Promise<string>;
  /** The owner's other avatars, so Shuffle does not land on a look-alike. */
  taken?: readonly AvatarParams[];
  fileUrl?: (fileId: string) => string;
  className?: string;
}

export function AvatarEditor({
  value,
  onChange,
  upload = (file) => uploadAvatarImage(file),
  taken,
  fileUrl = defaultFileUrl,
  className,
}: AvatarEditorProps) {
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The generated avatar to return to after trying an upload.
  const [lastGenerated, setLastGenerated] = useState<GeneratedAvatar>(
    value.kind === 'generated' ? value : { kind: 'generated', seed: value.file_id },
  );
  const generated = value.kind === 'generated' ? value : null;
  const parts = generated ? resolveParts(generated) : null;

  const change = (next: AvatarValue) => {
    if (next.kind === 'generated') setLastGenerated(next);
    setStatus(null);
    onChange(next);
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!(AVATAR_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      setStatus('Choose a PNG, JPEG, WebP or GIF image.');
      return;
    }
    setBusy(true);
    setStatus('Uploading…');
    try {
      change({ kind: 'upload', file_id: await upload(file) });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex items-center gap-4">
        <Avatar params={value} size={88} label="Avatar preview" fileUrl={fileUrl} />
        <div className="flex flex-col items-start gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const from = generated ?? lastGenerated;
                change(shuffle(from.seed, taken, from.shape ? { shape: from.shape } : {}));
              }}
            >
              Shuffle
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              Upload image
            </Button>
            {!generated && (
              <Button type="button" variant="ghost" size="sm" onClick={() => change(lastGenerated)}>
                Use a generated avatar
              </Button>
            )}
          </div>
          <input
            ref={input}
            type="file"
            accept={AVATAR_IMAGE_TYPES.join(',')}
            className="hidden"
            onChange={onFile}
          />
          {status && (
            <p role="status" className="text-xs text-muted-foreground">
              {status}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3" aria-label="How each state looks">
        {AVATAR_STATES.map((state) => (
          <figure key={state} className="flex flex-col items-center gap-1">
            <Avatar params={value} state={state} size={40} fileUrl={fileUrl} />
            <figcaption className="text-xs capitalize text-muted-foreground">{state}</figcaption>
          </figure>
        ))}
      </div>

      {generated && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Shape</legend>
          <ShapePicker value={generated} onChange={change} className="self-start" />
        </fieldset>
      )}

      {generated &&
        parts &&
        PICKERS.map(({ part, label, options }) => (
          <fieldset key={part} className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</legend>
            <div className="flex flex-wrap gap-1">
              {options.map((option) => {
                const selected = parts[part] === option;
                return (
                  <button
                    key={option}
                    type="button"
                    title={option}
                    aria-label={`${label}: ${option}`}
                    aria-pressed={selected}
                    onClick={() => change({ ...generated, [part]: option })}
                    className={cn(
                      'rounded-md border p-1 transition-colors',
                      selected ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent',
                    )}
                  >
                    <Avatar params={{ ...generated, [part]: option }} size={32} reducedMotion />
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
    </div>
  );
}
