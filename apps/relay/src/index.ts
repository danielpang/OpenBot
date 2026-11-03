// The private relay (docs/RELAY_PROTOCOL.md sections 3 and 4), as a library:
// `createRelay` runs one in process, which is how other packages' integration
// tests reach it, and several share a registry to form a cluster
// (MOBILE_AND_VM_PLAN.md 5.8). The process entry is main.ts.

export {
  createRelay,
  remoteAddress,
  HOST_PATH,
  REPLAY_HEADER,
  REPLAY_SOURCE_HEADER,
  type Relay,
  type RelayOptions,
} from './relay.js';
export {
  MemoryRegistry,
  RedisRegistry,
  counterKey,
  type AcquireResult,
  type Lease,
  type Registry,
  type RedisRegistryOptions,
} from './registry.js';
export {
  DEFAULT_CLUSTER_TIMING,
  Ownership,
  type ClaimResult,
  type ClusterTiming,
  type Route,
} from './ownership.js';
export {
  ApnsGateway,
  APNS_PRODUCTION,
  APNS_SANDBOX,
  NO_PUSH,
  type ApnsOptions,
  type PushGateway,
  type PushOutcome,
  type PushRequest,
} from './apns.js';
export {
  DEFAULT_LIMITS,
  HostRegistry,
  type Capability,
  type Presence,
  type RelayLimits,
} from './hosts.js';
export { DEFAULT_TIMING, type HostLinkTiming } from './host-link.js';
export {
  HELLO_CONTEXT,
  HOST_ID_PATTERN,
  base32,
  fromBase64Url,
  helloMessage,
  hostIdFor,
  isHostId,
  toBase64Url,
  verifyHello,
} from './identity.js';
export { loadConfig, type RelayConfig } from './config.js';
