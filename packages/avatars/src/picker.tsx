import { Button, cn } from '@openbots/ui';
import { Avatar } from './avatar.js';
import { resolveParts, shuffle, type AvatarParams, type GeneratedAvatar } from './generate.js';
import { BOT_SHAPES, SHAPES } from './parts.js';

// Picking a Bot's look (I1): its body shape from the three Bot shapes, Moon,
// Box and Egg, and Shuffle for everything else. The chosen shape is pinned
// in the avatar params, so Shuffle keeps it.

export interface ShapePickerProps {
  value: GeneratedAvatar;
  onChange: (value: GeneratedAvatar) => void;
  className?: string;
}

/** Segmented buttons, one per Bot shape, each drawn as its outline. */
export function ShapePicker({ value, onChange, className }: ShapePickerProps) {
  const current = resolveParts(value).shape;
  return (
    <div
      role="group"
      aria-label="Shape"
      className={cn('inline-flex rounded-md border p-0.5', className)}
    >
      {BOT_SHAPES.map(({ shape, label }) => {
        const selected = current === shape;
        return (
          <button
            key={shape}
            type="button"
            aria-pressed={selected}
            title={label}
            onClick={() => onChange({ ...value, shape })}
            className={cn(
              'flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors',
              selected
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent/60',
            )}
          >
            <svg viewBox="0 0 64 64" className="size-4" aria-hidden>
              <path d={SHAPES[shape]} fill="currentColor" />
            </svg>
            {label}
          </button>
        );
      })}
    </div>
  );
}

export interface AvatarPickerProps {
  value: GeneratedAvatar;
  onChange: (value: GeneratedAvatar) => void;
  /** The owner's other avatars, so Shuffle does not land on a look-alike. */
  taken?: readonly AvatarParams[];
  className?: string;
}

/** The new Bot's icon: a preview, its shape, and Shuffle for the rest. */
export function AvatarPicker({ value, onChange, taken, className }: AvatarPickerProps) {
  const pinned = value.shape ? { shape: value.shape } : {};
  return (
    <div className={cn('flex items-center gap-4', className)}>
      <Avatar params={value} size={64} label="Icon preview" />
      <div className="flex flex-col items-start gap-2">
        <ShapePicker value={value} onChange={onChange} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange(shuffle(value.seed, taken, pinned))}
        >
          Shuffle
        </Button>
      </div>
    </div>
  );
}
