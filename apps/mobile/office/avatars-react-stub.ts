// Uploaded avatars need the app's authenticated connection, which the office page does
// not have, so they are drawn as an empty circle there.
export function defaultFileUrl(): string {
  return '';
}
