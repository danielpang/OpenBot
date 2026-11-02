import { Button, Input } from '@openbots/ui';
import { PRODUCT_NAME } from '@openbots/shared';
import type { ComponentProps, FormEvent, ReactNode } from 'react';

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">{PRODUCT_NAME}</p>
          <h1 className="text-2xl font-semibold">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, ...props }: { label: string } & ComponentProps<typeof Input>) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      <Input {...props} />
    </label>
  );
}

export function AuthForm({
  onSubmit,
  submitLabel,
  pending,
  error,
  children,
}: {
  onSubmit(form: FormData): void;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  children: ReactNode;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(new FormData(event.currentTarget));
  }
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      {children}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
