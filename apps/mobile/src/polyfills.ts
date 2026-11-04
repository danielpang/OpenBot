import 'expo';
import * as Crypto from 'expo-crypto';
import { fetch } from 'expo/fetch';
import { streamFetchPrimitives } from './api/fetch-primitives';

if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      ...globalThis.crypto,
      getRandomValues: Crypto.getRandomValues,
      randomUUID: Crypto.randomUUID,
    },
  });
}
if (!globalThis.crypto.randomUUID) {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: Crypto.randomUUID,
  });
}
const primitives = streamFetchPrimitives(globalThis.Request, globalThis.Response);
Object.assign(globalThis, primitives, { fetch });
