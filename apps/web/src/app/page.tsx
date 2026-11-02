import type { ReactNode } from 'react';

export function Page({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </div>
  );
}
