import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

// A native select drawn like Input: same border, height, focus ring and
// disabled look. The chevron comes from the global select rule in styles.css.
// `size="sm"` matches the 32 px rows that settings lists use.

export function Select({
  className,
  size = 'default',
  ...props
}: Omit<ComponentProps<'select'>, 'size'> & { size?: 'default' | 'sm' }) {
  return (
    <select
      className={cn(
        'flex w-full min-w-0 cursor-pointer rounded-md border border-input bg-transparent pl-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
        size === 'sm' ? 'h-8 text-xs' : 'h-9',
        className,
      )}
      {...props}
    />
  );
}
