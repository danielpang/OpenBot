import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  AGENT_PORT,
  BRIDGE_NAME_OPTION,
  GUARD_NAME,
  GUARD_PATH,
  ICC_OPTION,
  DEFAULT_SANDBOX_NETWORK,
  MANAGED_LABEL,
  SANDBOX_CAPS,
  SANDBOX_ENV_NAMES,
  SANDBOX_USER,
  stateVolumeName,
  type SandboxNetwork,
} from './docker.js';
import { readTokenArchive, tokenArchive } from './token-archive.js';
import { COMPUTER_HOME, STATE_DIR } from './types.js';

// The docker guard (threat model S-2): a filtering proxy between the server
// and the socket proxy. The socket proxy filters by URL only, so with
// CONTAINERS and POST on, any `containers/create` body would pass, including
// `Privileged`, host binds or host networking. The guard allows the exact
// requests the docker provider makes and checks every body against the
// isolation settings in `containerSpec`: the sandbox image, the sandbox
// network, the fixed cap set, no binds, no host namespaces. Anything else is a
// 403. The one file it lets the provider put into a container is the agent
// token archive (token-archive.ts), into the state volume. It forwards the body it validated, re-serialized, never the bytes it
// received, so a duplicate or differently cased key cannot mean one thing here
// and another to the daemon's JSON decoder.

const CONTAINER_NAME = /^openbots-computer-[A-Za-z0-9-]+$/;
const HOME_VOLUME = /^openbots-home-[A-Za-z0-9-]+$/;
const STATE_VOLUME = /^openbots-state-[A-Za-z0-9-]+$/;
const computerVolume = (name: string) => HOME_VOLUME.test(name) || STATE_VOLUME.test(name);
const ID = '[A-Za-z0-9][A-Za-z0-9_.-]*';
const VERSION_PREFIX = /^(\/v\d+\.\d+)?(\/.*)$/;
const MAX_BODY_BYTES = 256 * 1024;

export interface DockerGuardPolicy {
  /** OPENBOTS_SANDBOX_IMAGE: the only image that may be pulled, inspected or run. */
  image: string;
  /**
   * OPENBOTS_SANDBOX_NETWORK and its bridge: the only network computers may
   * join, inspect or create, and the only bridge name it may be created
   * with. The default network without.
   */
  network?: SandboxNetwork;
}

export interface DockerRequest {
  method: string;
  /** Path and query as received (`/v1.47/containers/create?name=...`). */
  url: string;
  body?: string;
}

export type GuardDecision =
  | {
      allow: true;
      /** Path and query to forward: canonical, with only the parameters checked here. */
      url: string;
      /** The validated body, re-serialized; absent when the request takes none. */
      body?: string | Buffer;
      /** The body's type when it is not JSON. */
      contentType?: string;
      /** A container the request acts on; allowed only if the provider created it. */
      container?: string;
    }
  | { allow: false; reason: string };

type Json = Record<string, unknown>;

/** Decides one request. Pure, so every rule is unit-tested without a daemon. */
export function checkDockerRequest(
  request: DockerRequest,
  policy: DockerGuardPolicy,
): GuardDecision {
  const sandbox = policy.network ?? DEFAULT_SANDBOX_NETWORK;
  const network = sandbox.name;
  const refuse = (reason: string): GuardDecision => ({ allow: false, reason });
  const [rawPath = '', rawQuery = ''] = splitOnce(request.url, '?');
  // Docker names never need escaping; refusing `%`, `..` and `//` means the
  // path checked here is the path the daemon routes.
  if (!rawPath.startsWith('/') || /%|\/\/|\/\.\.?(\/|$)|#/.test(rawPath)) {
    return refuse('the path is not in canonical form');
  }
  const [, version = '', path = ''] = VERSION_PREFIX.exec(rawPath) ?? [];
  const query = new URLSearchParams(rawQuery);
  const method = request.method.toUpperCase();
  const forward = (route: string, keep: Record<string, string | null> = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(keep)) if (value !== null) params.set(key, value);
    const search = params.size ? `?${params}` : '';
    return `${version}${route}${search}`;
  };
  const json = (check: (body: Json) => string | undefined) => {
    let body: unknown;
    try {
      body = JSON.parse(request.body ?? '');
    } catch {
      return refuse('the body is not JSON');
    }
    if (!isObject(body)) return refuse('the body is not a JSON object');
    const reason = check(body);
    return reason ? refuse(reason) : undefined;
  };
  let match: RegExpExecArray | null;

  if ((method === 'GET' || method === 'HEAD') && path === '/_ping') {
    return { allow: true, url: forward(path) };
  }
  if (method === 'GET' && path === '/version') return { allow: true, url: forward(path) };

  // Images: pull and inspect the sandbox image, nothing else.
  if (method === 'GET' && (match = /^\/images\/(.+)\/json$/.exec(path))) {
    if (imageRef(match[1]!) !== imageRef(policy.image)) return refuse(`only ${policy.image}`);
    return { allow: true, url: forward(path) };
  }
  if (method === 'POST' && path === '/images/create') {
    const fromImage = query.get('fromImage');
    const tag = query.get('tag');
    if (!fromImage || query.has('fromSrc') || query.has('repo')) {
      return refuse('only pulling the sandbox image');
    }
    const pulled = tag ? `${fromImage}${tag.startsWith('sha256:') ? '@' : ':'}${tag}` : fromImage;
    if (imageRef(pulled) !== imageRef(policy.image)) return refuse(`only ${policy.image}`);
    return { allow: true, url: forward(path, { fromImage, tag, platform: query.get('platform') }) };
  }

  // Networks: the sandbox network, created with its fixed options.
  if (method === 'GET' && (match = /^\/networks\/(.+)$/.exec(path))) {
    if (match[1] !== network) return refuse(`only the ${network} network`);
    return { allow: true, url: forward(path) };
  }
  if (method === 'POST' && path === '/networks/create') {
    const refused = json((body) => checkNetworkBody(body, sandbox));
    if (refused) return refused;
    return { allow: true, url: forward(path), body: canonical(request.body!) };
  }

  // Volumes: a computer's home and state volumes, on the local driver with no
  // options (`DriverOpts` with `o=bind` would mount a host path).
  if ((method === 'GET' || method === 'DELETE') && (match = /^\/volumes\/(.+)$/.exec(path))) {
    if (!computerVolume(match[1]!)) return refuse('only computer volumes');
    // Removed only by a reset (GH5), never forced: a volume a container still uses stays.
    return { allow: true, url: forward(path) };
  }
  if (method === 'POST' && path === '/volumes/create') {
    const refused = json(checkVolumeBody);
    if (refused) return refused;
    return { allow: true, url: forward(path), body: canonical(request.body!) };
  }

  // Containers: create a computer, then act only on containers the provider made.
  if (method === 'POST' && path === '/containers/create') {
    const name = query.get('name');
    if (!name || !CONTAINER_NAME.test(name)) return refuse('the container needs a computer name');
    const refused = json((body) => checkContainerBody(body, policy.image, network, name));
    if (refused) return refused;
    const { name: _name, ...body } = JSON.parse(request.body!) as Json;
    return { allow: true, url: forward(path, { name }), body: JSON.stringify(body) };
  }
  // The agent token, as a root-only file in the state volume (S-7).
  if (method === 'PUT' && (match = new RegExp(`^/containers/(${ID})/archive$`).exec(path))) {
    if (query.get('path') !== STATE_DIR) return refuse(`the token goes only into ${STATE_DIR}`);
    const token = readTokenArchive(Buffer.from(request.body ?? '', 'utf8'));
    if (token === undefined) return refuse('the archive is not the agent token');
    return {
      allow: true,
      url: forward(path, { path: STATE_DIR }),
      body: tokenArchive(token),
      contentType: 'application/x-tar',
      container: match[1]!,
    };
  }
  if ((match = new RegExp(`^/containers/(${ID})(/json|/start|/stop)?$`).exec(path))) {
    const [, container, action = ''] = match;
    const allowed =
      (method === 'GET' && action === '/json') ||
      (method === 'POST' && action === '/start') ||
      (method === 'POST' && action === '/stop') ||
      (method === 'DELETE' && action === '');
    if (allowed) {
      const keep: Record<string, string | null> =
        action === '/stop'
          ? { t: query.get('t') }
          : method === 'DELETE'
            ? { force: query.get('force'), v: query.get('v') }
            : {};
      return { allow: true, url: forward(path, keep), container };
    }
  }
  return refuse(`${method} ${path || rawPath} is not an operation the computer uses`);
}

function checkContainerBody(
  body: Json,
  image: string,
  network: string,
  name: string,
): string | undefined {
  const extra = unknownKey(body, [
    'name',
    'Image',
    'Hostname',
    'User',
    'WorkingDir',
    'Env',
    'Labels',
    'ExposedPorts',
    'HostConfig',
    'NetworkingConfig',
  ]);
  if (extra) return `${extra} is not allowed`;
  if (typeof body.Image !== 'string' || imageRef(body.Image) !== imageRef(image)) {
    return `only ${image} may be run`;
  }
  if (body.User !== SANDBOX_USER) return `the container must run as ${SANDBOX_USER}`;
  if (!optionalString(body.Hostname) || !optionalString(body.WorkingDir)) {
    return 'Hostname and WorkingDir must be strings';
  }
  const env = body.Env ?? [];
  const names: readonly string[] = SANDBOX_ENV_NAMES;
  if (
    !Array.isArray(env) ||
    !env.every((e) => typeof e === 'string' && names.includes(e.split('=')[0]!))
  ) {
    return 'the environment may hold only the sandbox variables';
  }
  if (!isStringMap(body.Labels) || !body.Labels[MANAGED_LABEL]) {
    return `the container must carry the ${MANAGED_LABEL} label`;
  }
  const ports = body.ExposedPorts ?? {};
  if (!isObject(ports) || unknownKey(ports, [`${AGENT_PORT}/tcp`])) {
    return `only port ${AGENT_PORT} may be exposed`;
  }

  const host = body.HostConfig;
  if (!isObject(host)) return 'HostConfig is required';
  const extraHost = unknownKey(host, [
    'NetworkMode',
    'PortBindings',
    'PublishAllPorts',
    'Privileged',
    'CapDrop',
    'CapAdd',
    'SecurityOpt',
    'ReadonlyRootfs',
    'Binds',
    'Mounts',
    'Tmpfs',
    'ShmSize',
    'Memory',
    'MemorySwap',
    'NanoCpus',
    'PidsLimit',
    'IpcMode',
    'RestartPolicy',
  ]);
  if (extraHost) return `HostConfig.${extraHost} is not allowed`;
  if (host.NetworkMode !== network) return `the container must be on ${network}`;
  if (host.Privileged === true) return 'Privileged is not allowed';
  if (!isEmpty(host.PortBindings) || host.PublishAllPorts === true) {
    return 'no ports may be published';
  }
  if (!isEmpty(host.Binds)) return 'Binds are not allowed';
  const caps: readonly unknown[] = SANDBOX_CAPS;
  if (
    !isEmpty(host.CapAdd) &&
    !(Array.isArray(host.CapAdd) && host.CapAdd.every((c) => caps.includes(c)))
  ) {
    return `only ${SANDBOX_CAPS.join(', ')} may be added back`;
  }
  if (!Array.isArray(host.CapDrop) || !host.CapDrop.includes('ALL')) {
    return 'every capability must be dropped';
  }
  const opts = host.SecurityOpt;
  if (
    !Array.isArray(opts) ||
    !opts.length ||
    !opts.every((o) => o === 'no-new-privileges' || o === 'no-new-privileges:true')
  ) {
    return 'SecurityOpt must be no-new-privileges and nothing else';
  }
  if (host.ReadonlyRootfs !== true) return 'the root filesystem must be read-only';
  // A home volume at the home, and the computer's own state volume at the
  // state directory; nothing else.
  const mounts = host.Mounts ?? [];
  const state = stateVolumeName(name.slice('openbots-computer-'.length));
  if (
    !Array.isArray(mounts) ||
    !mounts.every(
      (m) =>
        isObject(m) &&
        !unknownKey(m, ['Type', 'Source', 'Target', 'ReadOnly']) &&
        m.Type === 'volume' &&
        typeof m.Source === 'string' &&
        ((HOME_VOLUME.test(m.Source) && m.Target === COMPUTER_HOME) ||
          (m.Source === state && m.Target === STATE_DIR)),
    ) ||
    new Set(mounts.map((m: Json) => m.Target)).size !== mounts.length
  ) {
    return `the only mounts are a home volume at ${COMPUTER_HOME} and ${state} at ${STATE_DIR}`;
  }
  if (host.Tmpfs !== undefined && !isStringMap(host.Tmpfs))
    return 'Tmpfs must map paths to options';
  for (const key of ['Memory', 'PidsLimit'] as const) {
    if (!positive(host[key])) return `HostConfig.${key} must be set`;
  }
  for (const key of ['ShmSize', 'MemorySwap', 'NanoCpus'] as const) {
    if (host[key] !== undefined && !positive(host[key]))
      return `HostConfig.${key} must be positive`;
  }
  if (host.IpcMode !== undefined && host.IpcMode !== 'private' && host.IpcMode !== 'none') {
    return 'IpcMode must be private';
  }
  const restart = host.RestartPolicy;
  if (
    restart !== undefined &&
    !(
      isObject(restart) &&
      !unknownKey(restart, ['Name']) &&
      ['no', ''].includes(restart.Name as string)
    )
  ) {
    return 'RestartPolicy must be no';
  }

  const networking = body.NetworkingConfig;
  if (networking !== undefined) {
    const endpoints = isObject(networking) ? networking.EndpointsConfig : undefined;
    if (
      !isObject(networking) ||
      unknownKey(networking, ['EndpointsConfig']) ||
      !isObject(endpoints) ||
      unknownKey(endpoints, [network]) ||
      !Object.values(endpoints).every(
        (e) =>
          isObject(e) &&
          !unknownKey(e, ['Aliases']) &&
          (e.Aliases === undefined ||
            (Array.isArray(e.Aliases) && e.Aliases.every((a) => typeof a === 'string'))),
      )
    ) {
      return `the container may join ${network} only, with aliases and nothing else`;
    }
  }
  return undefined;
}

function checkNetworkBody(
  body: Json,
  { name: network, bridge }: SandboxNetwork,
): string | undefined {
  const extra = unknownKey(body, [
    'Name',
    'Driver',
    'Internal',
    'Attachable',
    'Labels',
    'Options',
    'CheckDuplicate',
  ]);
  if (extra) return `${extra} is not allowed`;
  if (body.Name !== network) return `only the ${network} network`;
  if (body.Driver !== undefined && body.Driver !== 'bridge') return 'the network must be a bridge';
  if (body.Attachable === true) return 'the network may not be attachable';
  if (body.Labels !== undefined && !isStringMap(body.Labels)) return 'Labels must be strings';
  const options = body.Options;
  if (
    !isStringMap(options) ||
    unknownKey(options, [ICC_OPTION, BRIDGE_NAME_OPTION]) ||
    options[ICC_OPTION] !== 'false' ||
    (options[BRIDGE_NAME_OPTION] !== undefined && options[BRIDGE_NAME_OPTION] !== bridge)
  ) {
    return `the network needs ${ICC_OPTION}=false`;
  }
  return undefined;
}

function checkVolumeBody(body: Json): string | undefined {
  const extra = unknownKey(body, ['Name', 'Labels', 'Driver', 'DriverOpts']);
  if (extra) return `${extra} is not allowed`;
  if (typeof body.Name !== 'string' || !computerVolume(body.Name)) {
    return 'only computer volumes';
  }
  if (body.Driver !== undefined && body.Driver !== 'local') return 'only the local driver';
  if (!isEmpty(body.DriverOpts)) return 'DriverOpts are not allowed';
  if (body.Labels !== undefined && !isStringMap(body.Labels)) return 'Labels must be strings';
  return undefined;
}

/** `repo` and `repo:latest` are the same image; a digest reference is compared as is. */
export function imageRef(name: string) {
  if (name.includes('@')) return name;
  const last = name.slice(name.lastIndexOf('/') + 1);
  return last.includes(':') ? name : `${name}:latest`;
}

export interface DockerGuardOptions {
  /** The Docker API to forward to: `tcp://host:port`, `http://host:port` or `unix:///path`. */
  upstream: string;
  policy: DockerGuardPolicy;
  /** Called for every refused request, e.g. to log it. */
  onRefuse?(request: { method: string; url: string }, reason: string): void;
}

/** The guard as an HTTP server; call `listen` on it. */
export function createDockerGuard({ upstream, policy, onRefuse }: DockerGuardOptions): Server {
  const target = upstreamOptions(upstream);
  const info = JSON.stringify({
    guard: GUARD_NAME,
    image: policy.image,
    network: (policy.network ?? DEFAULT_SANDBOX_NETWORK).name,
  });

  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) send(res, 502, `docker guard: ${(error as Error).message}`);
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    if (method === 'GET' && url.replace(VERSION_PREFIX, '$2') === GUARD_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(info);
      return;
    }
    const refuse = (status: number, reason: string) => {
      onRefuse?.({ method, url }, reason);
      send(res, status, `docker guard: ${reason}`);
    };
    const encoding = req.headers['content-encoding'];
    if (encoding && encoding !== 'identity') return refuse(403, 'encoded bodies are not accepted');
    const body = await readBody(req);
    if (body === null) return refuse(413, 'the body is too large');

    const decision = checkDockerRequest({ method, url, body }, policy);
    if (!decision.allow) return refuse(403, decision.reason);
    if (decision.container) {
      const found = await call(target, 'GET', `/containers/${decision.container}/json`);
      if (found.status === 404) return send(res, 404, `No such container: ${decision.container}`);
      if (found.status !== 200) return send(res, 502, 'docker guard: the container lookup failed');
      const labels = (JSON.parse(found.body) as { Config?: { Labels?: Json } }).Config?.Labels;
      if (!labels?.[MANAGED_LABEL]) return refuse(403, 'the container is not a computer');
    }

    const headers: Record<string, string | number> = { host: 'docker' };
    const registryAuth = req.headers['x-registry-auth'];
    if (typeof registryAuth === 'string') headers['x-registry-auth'] = registryAuth;
    if (decision.body !== undefined) {
      headers['content-type'] = decision.contentType ?? 'application/json';
      headers['content-length'] = Buffer.byteLength(decision.body);
    }
    await new Promise<void>((resolve, reject) => {
      const out = httpRequest({ ...target, method, path: decision.url, headers }, (answer) => {
        const { 'transfer-encoding': _te, connection: _c, ...rest } = answer.headers;
        res.writeHead(answer.statusCode ?? 502, rest);
        answer.pipe(res);
        answer.on('end', resolve).on('error', reject);
      });
      out.on('error', reject);
      out.end(decision.body);
    });
  }
}

function upstreamOptions(upstream: string): RequestOptions {
  if (upstream.startsWith('unix://')) return { socketPath: upstream.slice(7) };
  const url = new URL(upstream.replace(/^tcp:/, 'http:'));
  return { host: url.hostname, port: Number(url.port || 2375) };
}

function call(target: RequestOptions, method: string, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const out = httpRequest({ ...target, method, path, headers: { host: 'docker' } }, (answer) => {
      let body = '';
      answer.setEncoding('utf8');
      answer.on('data', (chunk: string) => (body += chunk));
      answer.on('end', () => resolve({ status: answer.statusCode ?? 502, body }));
      answer.on('error', reject);
    });
    out.on('error', reject);
    out.end();
  });
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Docker's error shape, so dockerode surfaces the reason as the error message.
function send(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ message }));
}

function canonical(body: string) {
  return JSON.stringify(JSON.parse(body));
}

function splitOnce(value: string, separator: string) {
  const at = value.indexOf(separator);
  return at === -1 ? [value, ''] : [value.slice(0, at), value.slice(at + 1)];
}

function unknownKey(value: Json, allowed: readonly string[]) {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((v) => typeof v === 'string');
}

function isEmpty(value: unknown) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return isObject(value) && Object.keys(value).length === 0;
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === 'string';
}

function positive(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
