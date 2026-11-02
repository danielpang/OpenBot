import { packageName } from '@openbots/shared';

export const PACKAGE_NAME = packageName('avatars');

export { contrastRatio } from './contrast.js';
export {
  generate,
  newBotAvatar,
  partsKey,
  resolveParts,
  shuffle,
  type AvatarDrawing,
  type AvatarParams,
  type AvatarParts,
  type GeneratedAvatar,
} from './generate.js';
export {
  AVATAR_ACCESSORIES,
  AVATAR_EYES,
  AVATAR_PALETTES,
  AVATAR_SHAPES,
  BOT_SHAPES,
  PALETTES,
  type AvatarAccessory,
  type AvatarEyes,
  type AvatarPalette,
  type AvatarShape,
  type BotShape,
  type Palette,
} from './parts.js';
export { AVATAR_CSS, AVATAR_STATES, STATE_RING, type AvatarState } from './states.js';
