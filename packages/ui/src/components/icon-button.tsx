import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/utils.js';
import { Button } from './button.js';
import { SpinnerGlyph } from './icons.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.js';

// A row or card action drawn as a glyph: 32 px square, ghost, muted at rest.
// `label` is both the tooltip and the accessible name, so a screen reader and
// a test find it by the word it replaced. `busy` swaps the glyph for a
// spinner and disables the button while its request runs.

export function IconButton({
  label,
  tooltip,
  children,
  busy = false,
  className,
  disabled,
  variant = 'ghost',
  ...props
}: Omit<ComponentProps<typeof Button>, 'size' | 'aria-label'> & {
  label: string;
  /** Shown on hover when it should differ from the accessible name. */
  tooltip?: string;
  children: ReactNode;
  busy?: boolean;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant={variant}
            aria-label={label}
            aria-busy={busy || undefined}
            disabled={disabled || busy}
            className={cn(
              variant === 'ghost' && 'text-muted-foreground hover:text-foreground',
              className,
            )}
            {...props}
          >
            {busy ? <SpinnerGlyph className="animate-spin" /> : children}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{tooltip ?? label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
