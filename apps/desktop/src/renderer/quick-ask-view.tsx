import { cn, Kbd, Textarea } from '@openbots/ui';
import { useEffect, useRef } from 'react';
import { AlertCircleIcon, ChevronDownIcon, ReturnIcon } from './icons.js';
import type { QuickAskFlow } from './quick-ask-flow.js';
import { useStore } from './use-store.js';

// The quick-ask window's view: a small frameless panel (with vibrancy on
// macOS). The flow is in ./quick-ask-flow.ts.

export function QuickAsk({ flow }: { flow: QuickAskFlow }) {
  const state = useStore(flow.store);
  const text = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') flow.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [flow]);
  // Back to typing once a send finishes.
  useEffect(() => {
    if (!state.sending) text.current?.focus();
  }, [state.sending]);

  return (
    <form
      id="ask"
      className="flex h-screen flex-col gap-2 p-3 [-webkit-app-region:drag]"
      onSubmit={(event) => {
        event.preventDefault();
        void flow.send();
      }}
    >
      <div className="flex items-center gap-2">
        <div className="relative [-webkit-app-region:no-drag]">
          <select
            id="bot"
            aria-label="Bot"
            value={state.botId}
            onChange={(event) => flow.choose(event.target.value)}
            className="h-7 appearance-none rounded-md border border-input bg-background/60 py-0 pr-7 pl-2.5 text-[13px] font-medium shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {state.bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd aria-label="Return">
              <ReturnIcon />
            </Kbd>{' '}
            send
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd> close
          </span>
        </span>
      </div>
      <Textarea
        id="text"
        ref={text}
        autoFocus
        rows={4}
        value={state.text}
        disabled={state.sending}
        placeholder="Ask a Bot…"
        aria-label="Message"
        onChange={(event) => flow.setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void flow.send();
          }
        }}
        className={cn(
          'min-h-0 flex-1 resize-none bg-background/60 text-[15px] [-webkit-app-region:no-drag] [field-sizing:fixed]',
        )}
      />
      {state.error && (
        <p id="error" role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircleIcon className="size-3.5 shrink-0" />
          {state.error}
        </p>
      )}
    </form>
  );
}
