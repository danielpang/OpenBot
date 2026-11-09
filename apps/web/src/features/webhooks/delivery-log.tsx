import { Button, cn, SendIcon } from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { formatWhen } from '../routines/routines-tab.js';
import { fileUrl } from '../transcript/api.js';
import { useShowBotPanel } from '../transcript/panel.js';
import { deliveriesQuery, useDeliveryActions, type Delivery, type Endpoint } from './api.js';

// An endpoint's delivery log (H5): newest first, each with its headers, body,
// verification result, whether the rule matched, and the run it started
// (opening the run's activity log). Replay sends the same headers and body
// through matching again as a new delivery; the test form sends a payload
// the owner writes, unverified. A delivery that failed the IP, token or
// signature check shows as refused, with the reason, its headers and the
// start of its body; it was never accepted, so it has no Replay.

const STATUS_WORDS: Record<Delivery['status'], string> = {
  received: 'Received',
  ignored: 'Ignored',
  queued: 'Started a run',
  failed: 'Failed',
  refused: 'Refused',
};

const ORIGIN_WORDS: Record<Delivery['origin'], string | null> = {
  ingress: null,
  replay: 'Replay',
  test: 'Test',
};

export function DeliveryLog({ botId, endpoint }: { botId: string; endpoint: Endpoint }) {
  const { data, error } = useQuery(deliveriesQuery(endpoint.id));
  const actions = useDeliveryActions(endpoint.id);
  const showPanel = useShowBotPanel(botId);
  const openRun = (runId: string) => showPanel({ kind: 'activity', runId });

  return (
    <div className="mt-2 flex flex-col gap-3">
      {error && <p className="text-xs text-destructive">{error.message}</p>}
      {actions.replay.error && (
        <p className="text-xs text-destructive">{actions.replay.error.message}</p>
      )}
      {data && !data.length && <p className="text-xs text-muted-foreground">No deliveries yet.</p>}
      {!!data?.length && (
        <ol className="flex flex-col gap-1 border-l pl-3 text-xs">
          {data.map((delivery) => (
            <DeliveryRow
              key={delivery.id}
              delivery={delivery}
              replaying={actions.replay.isPending}
              onReplay={() => actions.replay.mutate(delivery.id)}
              onOpenRun={openRun}
            />
          ))}
        </ol>
      )}
      <TestEventForm endpoint={endpoint} onOpenRun={openRun} />
    </div>
  );
}

export function DeliveryRow({
  delivery,
  replaying,
  onReplay,
  onOpenRun,
}: {
  delivery: Delivery;
  replaying?: boolean;
  onReplay(): void;
  onOpenRun?(runId: string): void;
}) {
  const origin = ORIGIN_WORDS[delivery.origin];
  return (
    <li className="flex flex-col" data-delivery={delivery.id} data-status={delivery.status}>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span
          className={cn(
            (delivery.status === 'failed' || delivery.status === 'refused') && 'text-destructive',
          )}
        >
          {STATUS_WORDS[delivery.status]}
        </span>
        <span className="text-muted-foreground">
          {[
            formatWhen(delivery.receivedAt),
            origin,
            delivery.verified ? 'Verified' : 'Not verified',
            delivery.matched || delivery.status === 'refused' ? null : 'Rule did not match',
            delivery.remoteIp,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {delivery.runId && onOpenRun && (
          <button
            type="button"
            className="font-medium hover:underline"
            onClick={() => onOpenRun(delivery.runId!)}
          >
            Activity log
          </button>
        )}
        {delivery.status !== 'refused' && (
          <button
            type="button"
            className="font-medium hover:underline disabled:opacity-50"
            disabled={replaying}
            onClick={onReplay}
          >
            Replay
          </button>
        )}
      </span>
      {delivery.error && <span className="text-muted-foreground">{delivery.error}</span>}
      <details>
        <summary className="cursor-pointer select-none text-muted-foreground">
          Headers and body
        </summary>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 font-mono">
          {Object.entries(delivery.headers).map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
        </dl>
        {delivery.body !== null && (
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border p-2">
            {prettyBody(delivery.body)}
          </pre>
        )}
        {delivery.bodyFileId && (
          <a
            className="font-medium hover:underline"
            href={fileUrl(delivery.bodyFileId)}
            target="_blank"
            rel="noreferrer"
          >
            Whole body
          </a>
        )}
      </details>
    </li>
  );
}

/** JSON bodies indented; anything else (and a body cut at 16 KB) as it came. */
export function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** `Name: value` lines into a header map; blank lines are skipped. */
export function parseHeaders(text: string):
  | { ok: true; headers: Record<string, string> }
  | {
      ok: false;
      error: string;
    } {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon).trim() : '';
    if (!name) return { ok: false, error: `“${line.trim()}” is not a Name: value header` };
    headers[name] = line.slice(colon + 1).trim();
  }
  return { ok: true, headers };
}

export function TestEventForm({
  endpoint,
  onOpenRun,
}: {
  endpoint: Endpoint;
  onOpenRun?(runId: string): void;
}) {
  const actions = useDeliveryActions(endpoint.id);
  const [payload, setPayload] = useState('{\n  "hello": "world"\n}');
  const [headers, setHeaders] = useState(
    endpoint.signature?.preset === 'github' ? 'X-GitHub-Event: pull_request' : '',
  );
  const [problem, setProblem] = useState<string | null>(null);
  const result = actions.test.data;

  function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return setProblem('The payload is not valid JSON.');
    }
    const checked = parseHeaders(headers);
    if (!checked.ok) return setProblem(checked.error);
    actions.test.mutate({
      payload: parsed,
      ...(Object.keys(checked.headers).length ? { headers: checked.headers } : {}),
    });
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit} aria-label="Test event">
      <span className="text-xs font-medium">Send a test event</span>
      <textarea
        aria-label="Test payload"
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        rows={4}
        className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
      />
      <textarea
        aria-label="Test headers"
        value={headers}
        onChange={(e) => setHeaders(e.target.value)}
        rows={2}
        placeholder="Header: value, one per line (optional)"
        className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
      />
      {(problem ?? actions.test.error) && (
        <p className="text-xs text-destructive">{problem ?? actions.test.error?.message}</p>
      )}
      {result && (
        <p className="text-xs" data-test-result={result.delivery.status}>
          {STATUS_WORDS[result.delivery.status]}
          {result.delivery.error ? `: ${result.delivery.error}` : '.'}{' '}
          {result.runId && onOpenRun && (
            <button
              type="button"
              className="font-medium hover:underline"
              onClick={() => onOpenRun(result.runId!)}
            >
              Activity log
            </button>
          )}
        </p>
      )}
      <Button
        type="submit"
        size="sm"
        variant="outline"
        className="self-start"
        disabled={actions.test.isPending}
      >
        <SendIcon />
        Send test event
      </Button>
    </form>
  );
}
