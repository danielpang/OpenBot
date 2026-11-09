import { ApiError, unwrap, type components } from '@openbots/api-client';
import {
  Button,
  CheckIcon,
  CopyIcon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  PlusIcon,
  TrashIcon,
} from '@openbots/ui';
import { QrCode } from '@openbots/widgets/react';
import { SettingsSection } from '../../app/settings-layout.js';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { api } from '../../app/api.js';
import { RealtimeStatusContext, useRealtime } from '../transcript/realtime.js';

// Settings > Devices (docs/MOBILE_AND_VM_PLAN.md 4.3, docs/RELAY_PROTOCOL.md 6):
// the owner's paired phones with Revoke, "Pair a phone" with the pairing link
// as a QR code, and the relay's status. `device.paired`, `device.revoked` and
// `device.updated` on the owner's socket refresh the list. `relay.status`
// carries the relay's status as it changes, and it is read again each time the
// socket (re)connects, since an event sent while it was down is lost; a slow
// poll covers anything else.
//
// The pairing dialog says "Paired" only for a device made after its own
// pairing (another tab's pairing is no reason), cancels its pairing when it
// closes unused, and counts down by the server's clock: `expiresAt` less the
// server time in the response's `Date` header, so a browser whose clock is
// off still shows the right time left.

export type Device = components['schemas']['Device'];
type Pairing = components['schemas']['Pairing'];

/** How long a pairing is good for (RELAY_PROTOCOL.md 6.1). */
export const PAIRING_TTL_MS = 5 * 60_000;

/** A pairing as the dialog keeps it: with how far the server's clock is ahead of this one. */
interface OpenPairing {
  pairing: Pairing;
  /** The server's time less this browser's, from the response's `Date` header; 0 without one. */
  skewMs: number;
}

/** The server's time less the local one, from a response's `Date` header (second precision). */
export function clockSkew(dateHeader: string | null, now = Date.now()): number {
  const server = dateHeader ? Date.parse(dateHeader) : NaN;
  return Number.isFinite(server) ? server - now : 0;
}

/** Whether a `device.paired` device was made by this pairing's time, not an older one's. */
export function pairedByThis(
  deviceCreatedAt: string,
  pairing: Pick<Pairing, 'expiresAt'>,
): boolean {
  const madeAt = new Date(pairing.expiresAt).getTime() - PAIRING_TTL_MS;
  return new Date(deviceCreatedAt).getTime() >= madeAt;
}

export const devicesQuery = queryOptions({
  queryKey: ['devices'],
  queryFn: () => unwrap(api.GET('/api/v1/devices')),
});

/** How often the relay's status is read while the tab is open, beside its event. */
export const RELAY_POLL_MS = 60_000;

export const relayQuery = queryOptions({
  queryKey: ['relay'],
  queryFn: () => unwrap(api.GET('/api/v1/relay')),
  refetchInterval: RELAY_POLL_MS,
});

export const PLATFORM_LABELS: Record<Device['platform'], string> = {
  ios: 'iPhone',
  android: 'Android',
  desktop: 'Desktop',
};

/** "5 minutes ago", "yesterday"; "just now" under a minute. */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (Math.abs(seconds) < 60) return 'just now';
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 86_400],
    ['month', 30 * 86_400],
    ['week', 7 * 86_400],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size)!;
  return format.format(Math.round(seconds / size), unit);
}

/** "4:59" for what is left until `expiresAt`, never below zero. */
export function countdown(expiresAt: string, now = Date.now()): string {
  const left = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

export function DevicesSettings() {
  const queryClient = useQueryClient();
  const { client } = useRealtime();
  const devices = useQuery(devicesQuery);
  const [pairing, setPairing] = useState(false);
  const [revoking, setRevoking] = useState<Device | null>(null);

  useEffect(() => {
    if (!client) return;
    const refresh = () => void queryClient.invalidateQueries({ queryKey: devicesQuery.queryKey });
    const offPaired = client.on('device.paired', refresh);
    const offRevoked = client.on('device.revoked', refresh);
    const offUpdated = client.on('device.updated', refresh);
    return () => {
      offPaired();
      offRevoked();
      offUpdated();
    };
  }, [client, queryClient]);

  const items = devices.data?.items;
  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="Devices"
        description="A paired device is the OpenBots app on your phone. Each one holds a key with your access, so revoke a phone you lose."
        action={
          <IconButton label="Pair a phone" onClick={() => setPairing(true)}>
            <PlusIcon />
          </IconButton>
        }
      >
        {devices.error && <p className="text-sm text-destructive">{devices.error.message}</p>}
        <ul className="divide-y rounded-lg border bg-card">
          {items?.map((device) => (
            <DeviceRow key={device.id} device={device} onRevoke={() => setRevoking(device)} />
          ))}
          {items && !items.length && (
            <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 text-sm text-muted-foreground">
              No devices paired yet.
              <Button size="sm" variant="outline" onClick={() => setPairing(true)}>
                Pair your first phone
              </Button>
            </li>
          )}
        </ul>
      </SettingsSection>
      <RelayStatus />
      {pairing && <PairDialog onClose={() => setPairing(false)} />}
      <RevokeDialog device={revoking} onClose={() => setRevoking(null)} />
    </div>
  );
}

function DeviceRow({ device, onRevoke }: { device: Device; onRevoke(): void }) {
  return (
    <li
      className="flex items-center justify-between gap-4 py-2 pr-2 pl-4 text-sm text-foreground"
      data-device={device.id}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">
          {device.name}{' '}
          <span className="font-normal text-muted-foreground">
            {PLATFORM_LABELS[device.platform]}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          Paired on {new Date(device.createdAt).toLocaleDateString()}. Last seen:{' '}
          {device.lastSeenAt ? relativeTime(device.lastSeenAt) : 'Never'}.{' '}
          {device.pushRegistered ? 'Push registered.' : 'Push not registered.'}
        </span>
      </div>
      <IconButton label="Revoke" onClick={onRevoke}>
        <TrashIcon />
      </IconButton>
    </li>
  );
}

function RevokeDialog({ device, onClose }: { device: Device | null; onClose(): void }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/v1/devices/{id}', { params: { path: { id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: devicesQuery.queryKey }),
  });

  return (
    <Dialog
      open={device !== null}
      onOpenChange={(open) => {
        if (open) return;
        revoke.reset();
        onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke this device?</DialogTitle>
          <DialogDescription>
            Its key stops working at once and it gets no more notifications.
          </DialogDescription>
        </DialogHeader>
        {revoke.error && <p className="text-sm text-destructive">{revoke.error.message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => device && revoke.mutate(device.id, { onSuccess: () => onClose() })}
          >
            Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function pairingError(error: Error): string {
  if (error instanceof ApiError && error.code === 'TOO_MANY_PAIRINGS') {
    return 'Too many pairing codes are open. Wait a few minutes for them to expire, then try again.';
  }
  return error.message;
}

/**
 * Makes one pairing when it opens and another on "New code"; the dialog is
 * mounted only while open, so closing it discards the code (`gcTime: 0`) and
 * cancels the pairing on the server unless a phone used it.
 */
function PairDialog({ onClose }: { onClose(): void }) {
  const [attempt, setAttempt] = useState(0);
  const pairing = useQuery({
    queryKey: ['device-pairing', attempt],
    queryFn: async (): Promise<OpenPairing> => {
      const result = await api.POST('/api/v1/devices/pairings', { body: {} });
      const data = await unwrap(Promise.resolve(result));
      return { pairing: data, skewMs: clockSkew(result.response.headers.get('date')) };
    },
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [paired, setPaired] = useState<string | null>(null);
  const { client } = useRealtime();
  const current = pairing.data?.pairing;

  useEffect(
    () =>
      client?.on('device.paired', (event) => {
        const { device } = event.payload;
        if (current && pairedByThis(device.createdAt, current)) setPaired(device.name);
      }),
    [client, current],
  );

  // A code nobody used stops working when the dialog closes, or when a new one replaces it.
  const pairedRef = useRef(paired);
  pairedRef.current = paired;
  useEffect(() => {
    if (!current) return;
    const id = current.id;
    return () => {
      if (pairedRef.current) return;
      void api
        .DELETE('/api/v1/devices/pairings/{id}', { params: { path: { id } } })
        .catch(() => {});
    };
  }, [current]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{paired ? `Paired ${paired}` : 'Pair a phone'}</DialogTitle>
          <DialogDescription>
            {paired
              ? 'The phone can reach your Bots now.'
              : 'Scan this code with the OpenBots app on your phone.'}
          </DialogDescription>
        </DialogHeader>
        {paired ? null : pairing.error ? (
          <p className="text-sm text-destructive">{pairingError(pairing.error)}</p>
        ) : pairing.data ? (
          <PairingCode
            pairing={pairing.data.pairing}
            skewMs={pairing.data.skewMs}
            onRenew={() => setAttempt((n) => n + 1)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Making a code…</p>
        )}
        {paired && (
          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PairingCode({
  pairing,
  skewMs,
  onRenew,
}: {
  pairing: Pairing;
  skewMs: number;
  onRenew(): void;
}) {
  // The server's clock, as near as its Date header tells.
  const serverNow = () => Date.now() + skewMs;
  const [now, setNow] = useState(serverNow);
  const [copied, setCopied] = useState(false);
  const expired = new Date(pairing.expiresAt).getTime() <= now;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + skewMs), 1000);
    return () => clearInterval(timer);
  }, [skewMs]);

  if (expired) {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        <p className="text-sm">This code expired.</p>
        <Button onClick={onRenew}>New code</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <QrCode
        value={pairing.link}
        alt="QR code for pairing a phone with this server"
        className="size-56"
      />
      <p className="text-sm font-medium tabular-nums" role="timer">
        Expires in {countdown(pairing.expiresAt, now)}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(pairing.link).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        Copy link
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        The code works once and expires in 5 minutes. Copy the link to send it to your phone by
        AirDrop or Messages.
      </p>
    </div>
  );
}

function RelayStatus() {
  const queryClient = useQueryClient();
  const relay = useQuery(relayQuery);
  const { client } = useRealtime();
  const { status } = useContext(RealtimeStatusContext);
  const data = relay.data;

  useEffect(
    () =>
      client?.on('relay.status', (event) => {
        queryClient.setQueryData(relayQuery.queryKey, {
          ...event.payload,
          error: event.payload.error ?? null,
        });
      }),
    [client, queryClient],
  );

  // A status change while the socket was down sent an event nobody heard, so
  // read it again each time the socket opens (not on mount: the query just ran).
  const lastStatus = useRef(status);
  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = status;
    if (status === 'open' && was !== 'open') {
      void queryClient.invalidateQueries({ queryKey: relayQuery.queryKey });
    }
  }, [status, queryClient]);

  return (
    <section className="flex flex-col gap-1.5" aria-labelledby="relay-title">
      <h2 id="relay-title" className="text-base font-semibold">
        Relay
      </h2>
      {relay.error && <p className="text-sm text-destructive">{relay.error.message}</p>}
      {data && (
        <>
          <p className="text-sm" data-relay={data.status}>
            {data.status === 'off'
              ? 'Relay: off'
              : data.status === 'connecting'
                ? 'Relay: connecting…'
                : data.since
                  ? `Relay: linked since ${new Date(data.since).toLocaleString()}`
                  : 'Relay: linked'}
          </p>
          {data.error && (
            <p className="text-sm text-destructive" data-relay-error>
              The server could not connect to the relay: {data.error}. Phones cannot reach it
              through the relay until it does. Check OPENBOTS_RELAY_URL on the server.
            </p>
          )}
          {data.relayUrl === null ? (
            <p className="text-sm text-muted-foreground">
              For a phone to reach this server without a public address, set OPENBOTS_RELAY_URL on
              the server.
            </p>
          ) : (
            data.status === 'off' && (
              <p className="text-sm text-muted-foreground">
                The relay connects once a phone is paired.
              </p>
            )
          )}
          <p className="text-xs text-muted-foreground">
            Host <span className="font-mono">{data.hostId}</span>
          </p>
        </>
      )}
    </section>
  );
}
