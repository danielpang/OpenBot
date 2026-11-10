import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

// An on or off setting drawn as a switch. It is a real checkbox underneath
// (with the switch role), so labels, forms and `checked` work as usual.

export function Switch({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="checkbox"
      role="switch"
      className={cn(
        'relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-input outline-none transition-colors checked:bg-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50',
        'before:absolute before:top-0.5 before:left-0.5 before:size-4 before:rounded-full before:bg-background before:shadow-sm before:transition-transform checked:before:translate-x-4',
        className,
      )}
      {...props}
    />
  );
}
