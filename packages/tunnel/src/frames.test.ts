import { describe, expect, it } from 'vitest';
import {
  FLAG_END,
  FLAG_TEXT,
  FrameError,
  FrameType,
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  MAX_PLAINTEXT_BYTES,
  decodeFrame,
  encodeFrame,
} from './frames.js';

describe('frames', () => {
  it('round trips every type with header, flags and body', () => {
    for (const type of Object.values(FrameType)) {
      const body = new Uint8Array([1, 2, 3, type]);
      const header = { a: 'b', n: 1 };
      const frame = decodeFrame(
        encodeFrame({ type, id: 0xfffffffe, flags: FLAG_END | FLAG_TEXT, header, body }),
      );
      expect(frame).toEqual({ type, id: 0xfffffffe, flags: FLAG_END | FLAG_TEXT, header, body });
    }
  });

  it('lays the prefix out big-endian', () => {
    const bytes = encodeFrame({
      type: FrameType.HttpReq,
      id: 0x01020304,
      flags: FLAG_END,
      header: {},
      body: new Uint8Array([9]),
    });
    expect([...bytes]).toEqual([0x01, 1, 2, 3, 4, 0x01, 0, 2, 0x7b, 0x7d, 9]);
    const none = encodeFrame({ type: FrameType.HttpBody, id: 3 });
    expect([...none]).toEqual([0x02, 0, 0, 0, 3, 0, 0, 0]);
    expect(decodeFrame(none).header).toBeNull();
    expect(decodeFrame(none).body).toHaveLength(0);
  });

  it('enforces the header and frame limits', () => {
    const big = { x: 'y'.repeat(MAX_HEADER_BYTES) };
    expect(() => encodeFrame({ type: FrameType.HttpReq, id: 1, header: big })).toThrow(
      /header is .* more than 16384/,
    );
    expect(() =>
      encodeFrame({ type: FrameType.HttpBody, id: 1, body: new Uint8Array(MAX_BODY_BYTES + 1) }),
    ).toThrow(/more than 61440/);
    expect(
      encodeFrame({ type: FrameType.HttpBody, id: 1, body: new Uint8Array(MAX_BODY_BYTES) }),
    ).toHaveLength(MAX_PLAINTEXT_BYTES);
    expect(() => decodeFrame(new Uint8Array(MAX_PLAINTEXT_BYTES + 1))).toThrow(FrameError);
  });

  it('refuses malformed input with precise errors', () => {
    const valid = encodeFrame({ type: FrameType.Ping, id: 0, header: { ts: 1 } });
    expect(() => decodeFrame(valid.subarray(0, 7))).toThrow(/shorter than its 8 byte prefix/);

    const unknownType = valid.slice();
    unknownType[0] = 0x7e;
    expect(() => decodeFrame(unknownType)).toThrow(/unknown frame type 0x7e/);

    const unknownFlag = valid.slice();
    unknownFlag[5] = 0x04;
    expect(() => decodeFrame(unknownFlag)).toThrow(/unknown frame flags/);

    const longHeader = valid.slice();
    longHeader[6] = 0x00;
    longHeader[7] = 0xff;
    expect(() => decodeFrame(longHeader)).toThrow(/runs past the end/);

    const tooLongHeader = new Uint8Array(8 + 16_385);
    tooLongHeader[0] = FrameType.Ping;
    tooLongHeader[6] = 0x40;
    tooLongHeader[7] = 0x01;
    expect(() => decodeFrame(tooLongHeader)).toThrow(/more than 16384/);

    const notJson = encodeFrame({
      type: FrameType.Ping,
      id: 0,
      body: new TextEncoder().encode('{nope'),
    });
    notJson[7] = 5;
    expect(() => decodeFrame(notJson)).toThrow(/not UTF-8 JSON/);

    const array = encodeFrame({
      type: FrameType.Ping,
      id: 0,
      body: new TextEncoder().encode('[1]'),
    });
    array[7] = 3;
    expect(() => decodeFrame(array)).toThrow(/not a JSON object/);

    const badUtf8 = encodeFrame({
      type: FrameType.Ping,
      id: 0,
      body: new Uint8Array([0x22, 0xff, 0x22]),
    });
    badUtf8[7] = 3;
    expect(() => decodeFrame(badUtf8)).toThrow(/not UTF-8 JSON/);

    expect(() => encodeFrame({ type: FrameType.Ping, id: -1 })).toThrow(/not a u32/);
    expect(() => encodeFrame({ type: FrameType.Ping, id: 2 ** 32 })).toThrow(/not a u32/);
    expect(() => encodeFrame({ type: 0x55 as FrameType, id: 1 })).toThrow(/unknown frame type/);
    expect(() => encodeFrame({ type: FrameType.Ping, id: 1, flags: 8 })).toThrow(
      /unknown frame flags/,
    );
  });

  it('marks its errors as protocol errors', () => {
    try {
      decodeFrame(new Uint8Array(2));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FrameError);
      expect((error as FrameError).code).toBe('protocol');
    }
  });
});
