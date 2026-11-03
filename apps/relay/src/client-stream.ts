import type { Logger } from 'pino';
import { WebSocket } from 'ws';
import { closeReason } from './host-link.js';
import type { HostRegistry, Link, StreamPeer } from './hosts.js';
import { isHostId } from './identity.js';

// One client stream on `/v1/connect/{hostId}` (docs/RELAY_PROTOCOL.md section
// 4). The relay opens a stream on one of the host's `streams` links, tells the
// client `{"type":"open","v":1}`, and from then on pipes binary frames both
// ways without looking inside them: each client frame becomes one prefixed
// frame to the host, each host payload one frame to the client. The client
// never sends text; one is a protocol error. A close at either end reaches the
// other, with the host's code and reason toward the client and the client's
// code toward the host, and a dropped link closes its clients 4410.

export interface ClientStreamDeps {
  registry: HostRegistry;
  logger: Logger;
}

export class ClientStream implements StreamPeer {
  private link: Link | undefined;
  private stream = 0;
  private ended = false;
  private alive = true;

  constructor(
    private readonly socket: WebSocket,
    hostId: string,
    remote: string,
    private readonly deps: ClientStreamDeps,
    private readonly onEnd: (stream: ClientStream) => void,
  ) {
    socket.on('error', () => socket.terminate());
    socket.on('pong', () => {
      this.alive = true;
    });
    socket.on('close', (code, reason) => this.clientClosed(code, reason.toString('utf8')));
    if (!isHostId(hostId)) {
      this.finish(4400, 'malformed host id');
      return;
    }
    const opened = deps.registry.openStream(hostId, this, remote);
    if (!opened.ok) {
      this.finish(opened.code, opened.reason);
      return;
    }
    this.link = opened.link;
    this.stream = opened.stream;
    socket.on('message', (data, isBinary) => this.receive(data as Buffer, isBinary));
    this.write(JSON.stringify({ type: 'open', v: 1 }));
  }

  /**
   * The keepalive tick: drops a client that missed the last ping. The
   * protocol does not ask for this, but a phone that loses its network
   * without a close would otherwise hold one of its host's streams forever.
   */
  heartbeat(): void {
    if (this.ended) return;
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
    this.link = undefined;
    this.finish(code, reason);
  }

  private receive(data: Buffer, isBinary: boolean) {
    if (this.ended || !this.link) return;
    if (!isBinary) {
      this.closeBoth(4400, 'clients send binary frames only');
      return;
    }
    this.link.sendData(this.stream, data);
  }

  /** The client's socket closed: the host hears it as `close` with the client's code. */
  private clientClosed(code: number, reason: string) {
    const link = this.link;
    this.link = undefined;
    this.ended = true;
    if (link && this.deps.registry.forgetStream(link, this.stream)) {
      link.sendClose(this.stream, code, reason);
    }
    this.onEnd(this);
  }

  /** The relay ends the stream itself: the host hears `close`, the client its close frame. */
  private closeBoth(code: number, reason: string) {
    const link = this.link;
    this.link = undefined;
    if (link && this.deps.registry.forgetStream(link, this.stream)) {
      link.sendClose(this.stream, code, reason);
    }
    this.finish(code, reason);
  }

  private finish(code: number, reason: string) {
    if (this.ended) return;
    this.ended = true;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(code, closeReason(reason));
    this.onEnd(this);
  }

  /** Sends one frame; a client this far behind loses its stream (1008), as a host link would. */
  private write(data: string | Buffer) {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(data);
    if (this.socket.bufferedAmount > this.deps.registry.limits.maxBufferedBytes) {
      this.deps.logger.warn('client stream send buffer full');
      this.closeBoth(1008, 'send buffer full');
    }
  }
}
