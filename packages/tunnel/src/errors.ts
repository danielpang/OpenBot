// The errors the tunnel raises. A TunnelError carries one of the `error`
// frame codes of RELAY_PROTOCOL.md section 8, whether the peer sent it or this
// side refused something before it reached the wire. A TunnelClosedError
// carries the close code of the transport underneath.

export type TunnelErrorCode =
  'protocol' | 'too_many_requests' | 'too_large' | 'cancelled' | 'internal';

export const TUNNEL_ERROR_CODES: readonly TunnelErrorCode[] = [
  'protocol',
  'too_many_requests',
  'too_large',
  'cancelled',
  'internal',
];

export class TunnelError extends Error {
  override name = 'TunnelError';
  /** One of TUNNEL_ERROR_CODES, or a code a newer peer sent. */
  readonly code: TunnelErrorCode | (string & {});

  constructor(code: TunnelErrorCode | (string & {}), message: string) {
    super(message || code);
    this.code = code;
  }
}

/** The stream closed while a request or socket was still open. */
export class TunnelClosedError extends Error {
  override name = 'TunnelClosedError';
  readonly closeCode: number;
  readonly reason: string;

  constructor(closeCode: number, reason: string) {
    super(`the tunnel closed (${closeCode}${reason ? `, ${reason}` : ''})`);
    this.closeCode = closeCode;
    this.reason = reason;
  }
}

/** The Noise handshake failed or timed out; the transport has been closed. */
export class TunnelHandshakeError extends Error {
  override name = 'TunnelHandshakeError';
}

/** The Close codes of spec section 9 the tunnel itself uses. */
export const CLOSE_NORMAL = 1000;
export const CLOSE_PROTOCOL = 4400;
