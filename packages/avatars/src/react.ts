// React entry: `@openbots/avatars/react`. Kept apart from the main entry so
// the server can import the generator and PNG renderer without React.

export { Avatar, defaultFileUrl, type AvatarProps } from './avatar.js';
export { AvatarEditor, type AvatarEditorProps } from './editor.js';
export {
  AvatarPicker,
  ShapePicker,
  type AvatarPickerProps,
  type ShapePickerProps,
} from './picker.js';
export { AVATAR_IMAGE_TYPES, uploadAvatarImage } from './upload.js';
