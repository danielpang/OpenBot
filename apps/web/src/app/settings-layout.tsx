import { cn } from '@openbots/ui';
import { useId, type ComponentProps, type ReactNode } from 'react';

// The building blocks of a settings page: a titled section, a bordered panel
// of rows, and a row with its label on the left and its control on the right.

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 text-sm text-muted-foreground">
      <header className="flex flex-col gap-1">
        <h2 id={id} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        {description && <p>{description}</p>}
      </header>
      {children}
    </section>
  );
}

/** A small heading over a panel inside a section. */
export function SettingsSubheading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

export function SettingsPanel({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('divide-y rounded-lg border bg-card text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export function SettingsRow({
  title,
  description,
  control,
  children,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & {
  title: ReactNode;
  description?: ReactNode;
  /** Sits to the right of the title, or wraps under it when narrow. */
  control?: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-3 px-4 py-3', className)} {...props}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="font-medium text-foreground">{title}</div>
          {description && <div className="text-xs">{description}</div>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children}
    </div>
  );
}
