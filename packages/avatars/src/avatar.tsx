import type { Avatar as AvatarValue } from '@openbots/shared';
import type { CSSProperties } from 'react';
import { generate, type AvatarParams } from './generate.js';
import { AVATAR_CSS, type AvatarState } from './states.js';

export interface AvatarProps {
  /** A Bot's stored avatar, or bare generator params. */
  params: AvatarValue | AvatarParams;
  state?: AvatarState;
  /** Edge length in px; 24 is the sidebar size. */
  size?: number;
  /** Force reduced motion; when unset the `prefers-reduced-motion` media query decides. */
  reducedMotion?: boolean;
  /** Accessible name, usually the Bot's name; without one the avatar is decorative. */
  label?: string;
  /** Where an uploaded avatar's image is served from. */
  fileUrl?: (fileId: string) => string;
  className?: string;
}

export const defaultFileUrl = (fileId: string) => `/api/v1/files/${encodeURIComponent(fileId)}`;

/**
 * A Bot's avatar with its state shown as motion (I2). Generated avatars are
 * inline SVG; uploaded ones sit in the same round frame with a state ring.
 */
export function Avatar({
  params,
  state = 'idle',
  size = 32,
  reducedMotion,
  label,
  fileUrl = defaultFileUrl,
  className,
}: AvatarProps) {
  const upload = params.kind === 'upload' ? params : null;
  const frame = {
    className: className ? `ob-avatar ${className}` : 'ob-avatar',
    style: { width: size, height: size } satisfies CSSProperties,
    'data-state': state,
    'data-kind': upload ? 'upload' : 'generated',
    'data-motion': reducedMotion ? 'reduced' : undefined,
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : true,
    title: label,
  };
  return (
    <>
      {/* React hoists and de-duplicates this, so a roster of avatars ships one copy. */}
      <style href="openbots-avatar" precedence="default">
        {AVATAR_CSS}
      </style>
      {upload ? (
        <span {...frame}>
          <img src={fileUrl(upload.file_id)} alt="" draggable={false} />
        </span>
      ) : (
        <span
          {...frame}
          dangerouslySetInnerHTML={{ __html: generate(params as AvatarParams).svg }}
        />
      )}
    </>
  );
}
