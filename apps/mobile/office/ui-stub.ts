// Stands in for @openbots/ui in the office bundle, which only needs `cn`.
export function cn(...parts: unknown[]): string {
  return parts.filter((part) => typeof part === 'string' && part).join(' ');
}
