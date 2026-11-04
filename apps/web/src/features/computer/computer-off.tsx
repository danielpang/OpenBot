import { Button } from '@openbots/ui';
import { ErrorText } from '../models/error-text.js';
import { useStartComputer } from './live.js';

// What the Computer panel and the file browser show while the computer is
// off: the file browser never starts it on its own (a stale tab would boot
// the sandbox), and the panel only when it first opens (./preview.tsx), so
// the owner gets a Start button instead.

export function ComputerOff({ text }: { text: string }) {
  const start = useStartComputer();
  return (
    <div className="flex flex-col gap-2" role="status" data-computer="off">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm text-muted-foreground">{text}</p>
        <Button size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? 'Starting…' : 'Start'}
        </Button>
      </div>
      <ErrorText error={start.error} />
    </div>
  );
}
