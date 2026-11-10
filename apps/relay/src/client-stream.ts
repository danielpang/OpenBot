import type { Logger } from 'pino';
import { WebSocket } from 'ws';
import type { Ticket } from './budget.js';
import type { FlowControl, Outlet, SendResult, Valve } from './flow.js';
import { closeReason } from './host-link.js';
import type { HostRegistry, Link, StreamPeer } from './hosts.js';
import { isHostId } from './identity.js';
import type { RelayMetrics, RejectionReason } from './metrics.js';

// One client stream on `/v1/connect/{hostId}` (docs/RELAY_PROTOCOL.md section
// 4). The relay opens a stream on one of the host's `streams` links, tells the
// client `{"type":"open","v":1}`, and from then on pipes binary frames both
// ways without looking inside them: each client frame becomes one prefixed
// frame to the host, each host payload one frame to the client. The client
// never sends text; one is a protocol error. A close at either end reaches the
// other, with the host's code and reason toward the client and the client's
// code toward the host, and a dropped link closes its clients 4410.
//
// Flow control (flow.ts): the client socket is a valve on its link's outlet,
// so a host link that falls behind pauses the phones that feed it, and the
// client socket is an outlet of its own, shed with 1013 when it stays behind
// past the delivery deadline. Bytes held for the client are reserved on its
// ticket (budget.ts); one the machine's budget refuses closes this stream
// with 1013, never the host's shared link. So does one past its host's share
// of that budget (every reservation for the host's link and streams counts).
//
// Nobody is authenticated here, so a stream must earn what it spends (3.4):
// one that carries no client payload within 5 seconds of opening is closed
// 4400, its first payload waits until the host's hour of opens has counted
// it (4429 past it), and its client to host bytes count per stream and per
// client address, past which this stream alone is closed 1008.
//
// The keepalive pings each client and drops one that missed its pong, but
// not while flow control has paused its socket: a paused socket reads no
// pongs, and the delivery deadline sheds one that stays stuck.

/**
 * The most a client may have read while its first payload is being counted.
 * The socket is paused meanwhile, so this is what one read had parsed already.
 */
const MAX_HELD_BYTES = 2 * 1024 * 1024;
export interface ClientStreamDeps {
  registry: HostRegistry;
  logger: Logger;
  flow: FlowControl;
  metrics: RelayMetrics;
}

/** The metric reason for a stream refused at open. */
function openRejection(code: number, reason: string): RejectionReason | undefined {
  if (code === 4404) return 'host_offline';
  if (code !== 4429) return undefined;
  if (reason === 'too many streams') return 'too_many_streams';
  if (reason === 'too many streams from this address') return 'address_streams';
  if (reason === 'too many stream opens from this address') return 'address_rate';
  return 'rate_limited';
}

export class ClientStream implements StreamPeer {
  private link: Link | undefined;
  private stream = 0;
  private ended = false;
  private alive = true;
  private pausesSeen = 0;
  /** The client's own close code, when it went before its stream opened. */
  private clientCode = 1006;
  private readonly outlet: Outlet;
  /** The client socket as a source, attached to its link's outlet once open. */
  private valve: Valve | undefined;
  /** `waiting` until the first payload, `counting` while the host's hour counts it. */
  private phase: 'waiting' | 'counting' | 'flowing' = 'waiting';
  private firstPayloadTimer: NodeJS.Timeout | undefined;
  /** Payloads that arrived while the first one was being counted. */
  private held: Buffer[] = [];
  private heldBytes = 0;
  private readonly bytes: { take(bytes: number): boolean };
  /** The hold on the socket while the first payload is counted. */
  private readonly counting = {};

  constructor(
    private readonly socket: WebSocket,
    private readonly hostId: string,
    readonly remote: string,
    private readonly deps: ClientStreamDeps,
    ticket: Ticket,
    private readonly onEnd: (stream: ClientStream) => void,
  ) {
    this.outlet = deps.flow.outlet(socket, {
      kind: 'client',
      ticket,
      onShed: () => {
        deps.metrics.shed('client');
        this.closeBoth(1013, 'too slow');
      },
    });
    this.bytes = deps.registry.streamWindow();
    socket.on('error', () => socket.terminate());
    socket.on('pong', () => {
      this.alive = true;
    });
    socket.on('close', (code, reason) => this.clientClosed(code, reason.toString('utf8')));
    if (!isHostId(hostId)) {
      this.finish(4400, 'malformed host id');
      return;
    }
    void this.open(hostId, remote);
  }

  /** Opens the stream on one of the host's links; the hour's opens are counted in the registry first. */
  private async open(hostId: string, remote: string) {
    let opened;
    try {
      opened = await this.deps.registry.openStream(hostId, this, remote);
    } catch (error) {
      this.deps.logger.error({ err: error, hostId }, 'stream open failed');
      this.finish(1011, 'internal error');
      return;
    }
    if (!opened.ok) {
      const rejection = openRejection(opened.code, opened.reason);
      if (rejection) this.deps.metrics.rejected(rejection);
      this.finish(opened.code, opened.reason);
      return;
    }
    if (this.ended) {
      // The client went while the registry answered: the host hears it at once.
      if (this.deps.registry.forgetStream(opened.link, opened.stream)) {
        opened.link.sendClose(opened.stream, this.clientCode, '');
      }
      return;
    }
    this.link = opened.link;
    this.stream = opened.stream;
    this.valve = this.deps.flow.valve(this.socket);
    opened.link.linkOutlet.attach(this.valve);
    this.socket.on('message', (data, isBinary) => this.receive(data as Buffer, isBinary));
    this.firstPayloadTimer = setTimeout(() => {
      this.deps.metrics.rejected('no_payload');
      this.closeBoth(4400, 'no data in time');
    }, this.deps.registry.limits.firstPayloadMs);
    this.firstPayloadTimer.unref();
    this.write(JSON.stringify({ type: 'open', v: 1 }));
  }

  /**
   * The keepalive tick: drops a client that missed the last ping. The
   * protocol does not ask for this, but a phone that loses its network
   * without a close would otherwise hold one of its host's streams forever.
   * A socket that flow control has paused reads no pongs, so it is given a
   * fresh period instead; the delivery deadline sheds one that stays stuck.
   */
  heartbeat(): void {
    if (this.ended) return;
    // Paused now, or paused at any point since the last tick: the pong may
    // still sit unread behind the pause, so the phone gets a full period.
    const pauses = this.valve?.pauses ?? 0;
    if (this.valve?.paused || pauses !== this.pausesSeen) {
      this.pausesSeen = pauses;
      this.alive = true;
      return;
    }
    if (!this.alive) {
      this.socket.terminate();
      return;
    }
    this.alive = false;
    this.socket.ping();
  }

  deliver(payload: Buffer): void {
    this.write(payload);
  }

  /** The host closed the stream, or its link dropped. */
  end(code: number, reason: string): void {
    this.releaseFlow(this.link);
    this.link = undefined;
    this.finish(code, reason);
  }

  private receive(data: Buffer, isBinary: boolean) {
    if (this.ended || !this.link) return;
    if (!isBinary) {
      this.closeBoth(4400, 'clients send binary frames only');
      return;
    }
    if (this.phase === 'flowing') {
      this.forward(data);
      return;
    }
    this.heldBytes += data.length;
    if (this.heldBytes > MAX_HELD_BYTES) {
      this.closeBoth(1008, 'too much data before the stream was counted');
      return;
    }
    this.held.push(Buffer.from(data));
    if (this.phase === 'counting') return;
    // The first payload: the stream now counts against the host's hour of opens.
    // Its socket reads nothing more until that answers.
    this.phase = 'counting';
    clearTimeout(this.firstPayloadTimer);
    this.valve?.hold(this.counting);
    this.deps.registry.countOpen(this.hostId).then(
      (counted) => this.counted(counted),
      (error: unknown) => {
        this.deps.logger.error({ err: error, hostId: this.hostId }, 'stream open count failed');
        this.closeBoth(1011, 'internal error');
      },
    );
  }

  /** The host's hour said yes or no to this stream; what it held back goes on, or the stream closes 4429. */
  private counted(counted: boolean) {
    if (this.ended || !this.link) return;
    if (!counted) {
      this.deps.metrics.rejected('rate_limited');
      this.closeBoth(4429, 'too many stream opens');
      return;
    }
    this.phase = 'flowing';
    this.valve?.release(this.counting);
    const held = this.held;
    this.held = [];
    this.heldBytes = 0;
    for (const payload of held) {
      if (this.ended || !this.link) return;
      this.forward(payload);
    }
  }

  /** One client payload to the host, after its byte limits. */
  private forward(data: Buffer) {
    if (!this.link) return;
    if (
      !this.bytes.take(data.length) ||
      !this.deps.registry.countAddressBytes(this.remote, data.length)
    ) {
      this.deps.logger.warn({ hostId: this.hostId }, 'client stream over its byte rate');
      this.deps.metrics.rejected('byte_rate');
      this.closeBoth(1008, 'byte rate exceeded');
      return;
    }
    const sent = this.link.sendData(this.stream, data, this.valve);
    if (sent.ok) this.deps.metrics.forwarded('to_host', data.length);
    else this.refused(sent);
  }

  /** The machine's budget refused bytes for this stream: it goes, the shared link stays. */
  private refused(sent: Exclude<SendResult, { ok: true }>) {
    if (sent.reason !== 'budget') return;
    this.deps.metrics.rejected(sent.refusal.reason === 'host' ? 'host_share' : 'bytes');
    this.closeBoth(sent.refusal.closeCode, 'relay busy');
  }

  /** Takes this stream out of flow control: its outlet, its valve and the link's hold on it. */
  private releaseFlow(link: Link | undefined) {
    clearTimeout(this.firstPayloadTimer);
    this.held = [];
    this.outlet.close();
    if (!this.valve) return;
    this.valve.close();
    link?.linkOutlet.detach(this.valve);
  }

  /** The client's socket closed: the host hears it as `close` with the client's code. */
  private clientClosed(code: number, reason: string) {
    const link = this.link;
    this.link = undefined;
    this.ended = true;
    this.clientCode = code;
    this.releaseFlow(link);
    if (link && this.deps.registry.forgetStream(link, this.stream)) {
      link.sendClose(this.stream, code, reason);
    }
    this.onEnd(this);
  }

  /** The relay ends the stream itself: the host hears `close`, the client its close frame. */
  private closeBoth(code: number, reason: string) {
    const link = this.link;
    this.link = undefined;
    this.releaseFlow(link);
    if (link && this.deps.registry.forgetStream(link, this.stream)) {
      link.sendClose(this.stream, code, reason);
    }
    this.finish(code, reason);
  }

  private finish(code: number, reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.releaseFlow(undefined);
    // A paused socket would never read the client's answer to the close.
    if (this.socket.isPaused) this.socket.resume();
    if (this.socket.readyState === WebSocket.OPEN) {
      this.deps.metrics.closed('client', code);
      this.socket.close(code, closeReason(reason));
    }
    this.onEnd(this);
  }

  /** Sends one frame; a client this far behind loses its stream (1008), as a host link would. */
  private write(data: string | Buffer) {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) return;
    const sent = this.outlet.send(data);
    if (!sent.ok) return this.refused(sent);
    if (this.socket.bufferedAmount > this.deps.registry.limits.maxBufferedBytes) {
      this.deps.logger.warn('client stream send buffer full');
      this.closeBoth(1008, 'send buffer full');
    }
  }
}
