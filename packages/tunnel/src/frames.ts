// The plaintext frame of RELAY_PROTOCOL.md section 5.2. Every Noise transport
// message after the handshake carries exactly one of these:
//
//   u8   type
//   u32  id      big-endian; 0 for the stream itself
//   u8   flags   bit 0 END, bit 1 TEXT
//   u16  hlen    big-endian; the JSON header's length, 0 for none
//   hlen JSON header, a UTF-8 object
//   ...  body
//
// This module only encodes and decodes the layout and its limits. What a
// header must contain for each type, and which frames are legal in which
// state, is the session's business (session.ts), so a FrameError here always
// means bytes that are not a frame at all.

export const FrameType = {
  HttpReq: 0x01,
  HttpBody: 0x02,
  HttpRes: 0x03,
  WsOpen: 0x10,
  WsOpened: 0x11,
  WsMsg: 0x12,
  WsClose: 0x13,
  Credit: 0x20,
  Ping: 0x30,
  Pong: 0x31,
  Error: 0x3f,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const FRAME_TYPES = new Set<number>(Object.values(FrameType));

/** The last chunk of a body (or, for `ws.msg`, of a message). */
export const FLAG_END = 0x01;
/** A text WebSocket message. */
export const FLAG_TEXT = 0x02;
const KNOWN_FLAGS = FLAG_END | FLAG_TEXT;

/** type, id, flags and hlen. */
export const FRAME_PREFIX_BYTES = 8;
export const MAX_HEADER_BYTES = 16_384;
/** The relay's limit on one stream payload (spec 3.2 and 4). */
export const MAX_TRANSPORT_MESSAGE_BYTES = 65_536;
/** One plaintext frame (spec 5.1). With its 16 byte tag it fits a relay payload with room to spare. */
export const MAX_PLAINTEXT_BYTES = 61_440;
/** The most body a frame with no header can carry. */
export const MAX_BODY_BYTES = MAX_PLAINTEXT_BYTES - FRAME_PREFIX_BYTES;
export const MAX_FRAME_ID = 0xffff_ffff;

export type FrameHeader = Record<string, unknown>;

export interface Frame {
  type: FrameType;
  id: number;
  flags: number;
  /** The decoded JSON header, or null when `hlen` is 0. */
  header: FrameHeader | null;
  body: Uint8Array;
}

export interface FrameInit {
  type: FrameType;
  id: number;
  flags?: number;
  header?: FrameHeader | null;
  body?: Uint8Array;
}

/** Bytes that are not a valid frame. The session answers it with a stream-level `protocol` error. */
export class FrameError extends Error {
  override name = 'FrameError';
  readonly code = 'protocol';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function encodeHeader(header: FrameHeader | null | undefined): Uint8Array {
  if (header === null || header === undefined) return new Uint8Array(0);
  return encoder.encode(JSON.stringify(header));
}

export function encodeFrame(init: FrameInit): Uint8Array {
  const { type, id, flags = 0, header, body = new Uint8Array(0) } = init;
  if (!FRAME_TYPES.has(type)) throw new FrameError(`unknown frame type 0x${type.toString(16)}`);
  if (!Number.isInteger(id) || id < 0 || id > MAX_FRAME_ID)
    throw new FrameError(`frame id ${id} is not a u32`);
  if (!Number.isInteger(flags) || (flags & ~KNOWN_FLAGS) !== 0)
    throw new FrameError(`unknown frame flags ${flags}`);
  const headerBytes = encodeHeader(header);
  if (headerBytes.length > MAX_HEADER_BYTES) {
    throw new FrameError(
      `frame header is ${headerBytes.length} bytes, more than ${MAX_HEADER_BYTES}`,
    );
  }
  const length = FRAME_PREFIX_BYTES + headerBytes.length + body.length;
  if (length > MAX_PLAINTEXT_BYTES) {
    throw new FrameError(`frame is ${length} bytes, more than ${MAX_PLAINTEXT_BYTES}`);
  }
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, id, false);
  view.setUint8(5, flags);
  view.setUint16(6, headerBytes.length, false);
  out.set(headerBytes, FRAME_PREFIX_BYTES);
  out.set(body, FRAME_PREFIX_BYTES + headerBytes.length);
  return out;
}

export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < FRAME_PREFIX_BYTES) {
    throw new FrameError(
      `frame is ${bytes.length} bytes, shorter than its ${FRAME_PREFIX_BYTES} byte prefix`,
    );
  }
  if (bytes.length > MAX_PLAINTEXT_BYTES) {
    throw new FrameError(`frame is ${bytes.length} bytes, more than ${MAX_PLAINTEXT_BYTES}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  const id = view.getUint32(1, false);
  const flags = view.getUint8(5);
  const hlen = view.getUint16(6, false);
  if (!FRAME_TYPES.has(type)) throw new FrameError(`unknown frame type 0x${type.toString(16)}`);
  if ((flags & ~KNOWN_FLAGS) !== 0)
    throw new FrameError(`unknown frame flags 0x${flags.toString(16)}`);
  if (hlen > MAX_HEADER_BYTES)
    throw new FrameError(`frame header length ${hlen} is more than ${MAX_HEADER_BYTES}`);
  if (FRAME_PREFIX_BYTES + hlen > bytes.length) {
    throw new FrameError(`frame header length ${hlen} runs past the end of the frame`);
  }
  let header: FrameHeader | null = null;
  if (hlen > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        decoder.decode(bytes.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + hlen)),
      );
    } catch {
      throw new FrameError('frame header is not UTF-8 JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new FrameError('frame header is not a JSON object');
    }
    header = parsed as FrameHeader;
  }
  return {
    type: type as FrameType,
    id,
    flags,
    header,
    body: bytes.subarray(FRAME_PREFIX_BYTES + hlen),
  };
}

/** The name of a frame type, for messages. */
export function frameTypeName(type: number): string {
  for (const [name, value] of Object.entries(FrameType)) if (value === type) return name;
  return `0x${type.toString(16)}`;
}
