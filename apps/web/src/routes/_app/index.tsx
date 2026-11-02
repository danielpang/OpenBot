import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/')({
  component: Home,
});

function Home() {
  return (
    <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
      Your Bots will live here.
    </div>
  );
}
