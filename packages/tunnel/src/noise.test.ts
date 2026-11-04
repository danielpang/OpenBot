import { describe, expect, it } from 'vitest';
import { generateDeviceKey, x25519PublicKey, type KeyPair } from './keys.js';
import {
  CipherState,
  HandshakeState,
  NoiseError,
  NoiseNonceExhaustedError,
  TUNNEL_PROLOGUE,
} from './noise.js';

const hex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const pair = (privateHex: string): KeyPair => {
  const privateKey = hex(privateHex);
  return { privateKey, publicKey: x25519PublicKey(privateKey) };
};
const utf8 = (text: string) => new TextEncoder().encode(text);

// The Noise_IK_25519_ChaChaPoly_SHA256 vector from cacophony
// (https://github.com/centromere/cacophony, vectors/cacophony.txt).
const VECTOR = {
  init_prologue: '4a6f686e2047616c74',
  init_static: 'e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1',
  init_ephemeral: '893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a',
  init_remote_static: '31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62',
  resp_static: '4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893',
  resp_ephemeral: 'bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b',
  handshake_hash: '0b0f68fb0c27e03ce9b97565995ed4838cc0581b762ef72b062f6a546419fad7',
  messages: [
    {
      payload: '4c756477696720766f6e204d69736573',
      ciphertext:
        'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944718da798efbcd91528520204f904b9bd6c7413dccdc214d951e15253e39987f18146e8cd0873654207148333479d4d16c289f0294b29960a72f48e0b7bba2e89083169825e59642148d492020664ccf7',
    },
    {
      payload: '4d757272617920526f746862617264',
      ciphertext:
        '95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088435361e70b2ed446e6c9ec387d1d6b3b840f194e373979d241b203c4acafccf5',
    },
    {
      payload: '462e20412e20486179656b',
      ciphertext: '050e9f3c8fac16b68dbce8f8c4bfbf6617c897f9ada4aa29aa19c8',
    },
    {
      payload: '4361726c204d656e676572',
      ciphertext: '344233a6cabb7141d80f3da2fedc311d9646bbb0f505afe403a667',
    },
    {
      payload: '4a65616e2d426170746973746520536179',
      ciphertext: '62cdeeb172ad7ade7aa7d9e069da5790f12331bfa00177787a1d0810c67dc3b2b4',
    },
    {
      payload: '457567656e2042f6686d20766f6e2042617765726b',
      ciphertext: '029bead1b40992327044d409d9a1f3ad8f36c3c452775d557e18bbeb2e8dfcead32d514024',
    },
  ],
};

function handshakePair(options: { serverKey?: KeyPair; pinned?: Uint8Array } = {}) {
  const client = generateDeviceKey();
  const server = options.serverKey ?? generateDeviceKey();
  const initiator = new HandshakeState({
    initiator: true,
    staticKey: client,
    remoteStaticKey: options.pinned ?? server.publicKey,
  });
  const responder = new HandshakeState({ initiator: false, staticKey: server });
  return { client, server, initiator, responder };
}

describe('Noise_IK_25519_ChaChaPoly_SHA256', () => {
  it('reproduces the cacophony known-answer vector', () => {
    const initiator = new HandshakeState({
      initiator: true,
      prologue: hex(VECTOR.init_prologue),
      staticKey: pair(VECTOR.init_static),
      ephemeralKey: pair(VECTOR.init_ephemeral),
      remoteStaticKey: hex(VECTOR.init_remote_static),
    });
    const responder = new HandshakeState({
      initiator: false,
      prologue: hex(VECTOR.init_prologue),
      staticKey: pair(VECTOR.resp_static),
      ephemeralKey: pair(VECTOR.resp_ephemeral),
    });
    expect(toHex(pair(VECTOR.resp_static).publicKey)).toBe(VECTOR.init_remote_static);

    const [m1, m2, ...transport] = VECTOR.messages;
    const message1 = initiator.writeMessage(hex(m1!.payload));
    expect(toHex(message1)).toBe(m1!.ciphertext);
    expect(toHex(responder.readMessage(message1))).toBe(m1!.payload);
    expect(toHex(responder.remoteStaticKey!)).toBe(toHex(pair(VECTOR.init_static).publicKey));

    const message2 = responder.writeMessage(hex(m2!.payload));
    expect(toHex(message2)).toBe(m2!.ciphertext);
    expect(toHex(initiator.readMessage(message2))).toBe(m2!.payload);

    expect(toHex(initiator.handshakeHash)).toBe(VECTOR.handshake_hash);
    expect(toHex(responder.handshakeHash)).toBe(VECTOR.handshake_hash);

    const i = initiator.split();
    const r = responder.split();
    transport.forEach((message, index) => {
      const [sender, receiver] = index % 2 === 0 ? [i, r] : [r, i];
      const ciphertext = sender.send.encrypt(hex(message.payload));
      expect(toHex(ciphertext)).toBe(message.ciphertext);
      expect(toHex(receiver.receive.decrypt(ciphertext))).toBe(message.payload);
    });
  });

  it('completes the handshake with the tunnel prologue and carries messages both ways', () => {
    const { client, initiator, responder } = handshakePair();
    const payload1 = responder.readMessage(initiator.writeMessage(utf8('{"v":1}')));
    expect(new TextDecoder().decode(payload1)).toBe('{"v":1}');
    expect(responder.remoteStaticKey).toEqual(client.publicKey);
    const payload2 = initiator.readMessage(
      responder.writeMessage(utf8('{"v":1,"device":"known"}')),
    );
    expect(new TextDecoder().decode(payload2)).toBe('{"v":1,"device":"known"}');
    expect(initiator.isComplete && responder.isComplete).toBe(true);
    expect(initiator.handshakeHash).toEqual(responder.handshakeHash);

    const c = initiator.split();
    const s = responder.split();
    for (let n = 0; n < 5; n++) {
      expect(s.receive.decrypt(c.send.encrypt(utf8(`up ${n}`)))).toEqual(utf8(`up ${n}`));
      expect(c.receive.decrypt(s.send.encrypt(utf8(`down ${n}`)))).toEqual(utf8(`down ${n}`));
    }
    expect(c.send.nonce).toBe(5);
    expect(c.receive.nonce).toBe(5);
    expect(s.send.nonce).toBe(5);
    expect(s.receive.nonce).toBe(5);
  });

  it('binds the prologue: a different one fails the handshake', () => {
    const client = generateDeviceKey();
    const server = generateDeviceKey();
    const initiator = new HandshakeState({
      initiator: true,
      staticKey: client,
      remoteStaticKey: server.publicKey,
    });
    const responder = new HandshakeState({
      initiator: false,
      staticKey: server,
      prologue: utf8('something-else'),
    });
    expect(TUNNEL_PROLOGUE).toEqual(utf8('openbots-tunnel-v1'));
    expect(() => responder.readMessage(initiator.writeMessage(utf8('{}')))).toThrow(NoiseError);
  });

  it('fails the handshake when the pinned server key is wrong', () => {
    const { initiator, responder } = handshakePair({ pinned: generateDeviceKey().publicKey });
    expect(() => responder.readMessage(initiator.writeMessage(utf8('{"v":1}')))).toThrow(
      NoiseError,
    );
  });

  it('fails a tampered handshake message and a tampered transport message', () => {
    const { initiator, responder } = handshakePair();
    const message1 = initiator.writeMessage(utf8('{"v":1}'));
    const tampered = message1.slice();
    tampered[tampered.length - 1]! ^= 0x01;
    expect(() => responder.readMessage(tampered)).toThrow(NoiseError);

    const second = handshakePair();
    second.responder.readMessage(second.initiator.writeMessage(utf8('a')));
    second.initiator.readMessage(second.responder.writeMessage(utf8('b')));
    const c = second.initiator.split();
    const s = second.responder.split();
    const ciphertext = c.send.encrypt(utf8('hello'));
    const bad = ciphertext.slice();
    bad[0]! ^= 0x80;
    expect(() => s.receive.decrypt(bad)).toThrow(NoiseError);
    // A failed decryption leaves the counter alone, so the genuine message still opens.
    expect(s.receive.nonce).toBe(0);
    expect(s.receive.decrypt(ciphertext)).toEqual(utf8('hello'));
    // Replaying it does not: the counter has moved on.
    expect(() => s.receive.decrypt(ciphertext)).toThrow(NoiseError);
  });

  it('refuses to run out of turn', () => {
    const { initiator, responder } = handshakePair();
    expect(() => responder.writeMessage(utf8(''))).toThrow(/out of turn/);
    expect(() => initiator.readMessage(new Uint8Array(64))).toThrow(/out of turn/);
    expect(() => initiator.split()).toThrow(/before the handshake/);
    expect(() => new HandshakeState({ initiator: true, staticKey: generateDeviceKey() })).toThrow(
      /responder static key/,
    );
  });

  it('stops at the message limit', () => {
    const key = new Uint8Array(32).fill(7);
    const sender = new CipherState(key, { maxMessages: 3 });
    const receiver = new CipherState(key, { maxMessages: 3 });
    for (let n = 0; n < 3; n++) receiver.decrypt(sender.encrypt(utf8('x')));
    expect(sender.exhausted).toBe(true);
    expect(() => sender.encrypt(utf8('x'))).toThrow(NoiseNonceExhaustedError);
    expect(() => receiver.decrypt(new Uint8Array(17))).toThrow(NoiseNonceExhaustedError);
  });

  it('puts the counter in the nonce as 64 bit little-endian after 32 zero bits', () => {
    const key = new Uint8Array(32).fill(1);
    const a = new CipherState(key, { maxMessages: 2 ** 40 });
    const b = new CipherState(key, { maxMessages: 2 ** 40 });
    a.setNonce(2 ** 32 + 5);
    b.setNonce(2 ** 32 + 5);
    expect(b.decrypt(a.encrypt(utf8('far')))).toEqual(utf8('far'));
    b.setNonce(5);
    a.setNonce(2 ** 32 + 6);
    expect(() => b.decrypt(a.encrypt(utf8('far')))).toThrow(NoiseError);
  });
});
