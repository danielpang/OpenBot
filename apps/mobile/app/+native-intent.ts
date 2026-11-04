import { nativeIntent } from '../src/hosts/deep-links';
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return nativeIntent(path);
}
