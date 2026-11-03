import { ApiError, unwrap, type components } from '@openbots/api-client';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@openbots/ui';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toString as qrSvg } from 'qrcode';
import { useEffect, useState } from 'react';
import { api } from '../../app/api.js';
import { useRealtime } from '../transcript/realtime.js';

// Settings > Devices (docs/MOBILE_AND_VM_PLAN.md 4.3, docs/RELAY_PROTOCOL.md 6):
// the owner's paired phones with Revoke, "Pair a phone" with the pairing link
// as a QR code, and the relay's status. `device.paired` and `device.revoked`
// on the owner's socket refresh the list; the relay has no event, so its
// status is polled while the tab is open.

export type Device = components['schemas']['Device'];
type Pairing = components['schemas']['Pairing'];

export const devicesQuery = queryOptions({
  queryKey: ['devices'],
  queryFn: () => unwrap(api.GET('/api/v1/devices')),
});

export const relayQuery = queryOptions({
  queryKey: ['relay'],
  queryFn: () => unwrap(api.GET('/api/v1/relay')),
  refetchInterval: 10_000,
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
    return () => {
      offPaired();
      offRevoked();
    };
  }, [client, queryClient]);

  const items = devices.data?.items;
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-labelledby="devices-title">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="devices-title" className="font-medium">
              Devices
            </h2>
            <p className="text-sm text-muted-foreground">
              A paired device is the OpenBots app on your phone. Each one holds a key with your
              access, so revoke a phone you lose.
            </p>
          </div>
          <Button onClick={() => setPairing(true)}>Pair a phone</Button>
        </div>
        {devices.error && <p className="text-sm text-destructive">{devices.error.message}</p>}
        <ul className="divide-y rounded-md border">
          {items?.map((device) => (
            <DeviceRow key={device.id} device={device} onRevoke={() => setRevoking(device)} />
          ))}
          {items && !items.length && (
            <li className="px-3 py-2 text-sm text-muted-foreground">No devices paired yet.</li>
          )}
        </ul>
      </section>
      <RelayStatus />
      {pairing && <PairDialog onClose={() => setPairing(false)} />}
      <RevokeDialog device={revoking} onClose={() => setRevoking(null)} />
    </div>
  );
}

function DeviceRow({ device, onRevoke }: { device: Device; onRevoke(): void }) {
  return (
    <li
      className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
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
      <Button variant="ghost" size="sm" onClick={onRevoke}>
        Revoke
      </Button>
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
 * mounted only while open, so closing it discards the code (`gcTime: 0`).
 */
function PairDialog({ onClose }: { onClose(): void }) {
  const [attempt, setAttempt] = useState(0);
  const pairing = useQuery({
    queryKey: ['device-pairing', attempt],
    queryFn: () => unwrap(api.POST('/api/v1/devices/pairings', { body: {} })),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [paired, setPaired] = useState<string | null>(null);
  const { client } = useRealtime();

  useEffect(
    () => client?.on('device.paired', (event) => setPaired(event.payload.device.name)),
    [client],
  );

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
          <PairingCode pairing={pairing.data} onRenew={() => setAttempt((n) => n + 1)} />
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

function PairingCode({ pairing, onRenew }: { pairing: Pairing; onRenew(): void }) {
  const [now, setNow] = useState(() => Date.now());
  const [svg, setSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const expired = new Date(pairing.expiresAt).getTime() <= now;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let current = true;
    void qrSvg(pairing.link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(
      (text) => current && setSvg(text),
      () => current && setSvg(null),
    );
    return () => {
      current = false;
    };
  }, [pairing.link]);

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
      {svg && (
        <img
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          alt="QR code for pairing a phone with this server"
          className="size-56 rounded-md bg-white p-2"
        />
      )}
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
        {copied ? 'Copied' : 'Copy link'}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        The code works once and expires in 5 minutes. Copy the link to send it to your phone by
        AirDrop or Messages.
      </p>
    </div>
  );
}

function RelayStatus() {
  const relay = useQuery(relayQuery);
  const data = relay.data;

  return (
    <section className="flex flex-col gap-1.5" aria-labelledby="relay-title">
      <h2 id="relay-title" className="font-medium">
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
          {data.status === 'off' && (
            <p className="text-sm text-muted-foreground">
              For a phone to reach this server without a public address, set OPENBOTS_RELAY_URL on
              the server.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Host <span className="font-mono">{data.hostId}</span>
          </p>
        </>
      )}
    </section>
  );
}
