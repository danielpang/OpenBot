// The docker guard process, run as the `docker-guard` compose service
// (`openbots docker-guard` in the server image). It holds no secrets: just the
// sandbox image it allows and the socket proxy it forwards to. For development
// on the host, `pnpm --filter @openbots/computer docker-guard` runs it from
// source in front of the Docker socket, on 127.0.0.1 only.
//
//   OPENBOTS_DOCKER_UPSTREAM  the socket proxy (default tcp://docker-socket-proxy:2375)
//   OPENBOTS_SANDBOX_IMAGE    the only image computers may run
//   OPENBOTS_SANDBOX_NETWORK  the only network they may join (default openbots-sbx)
//   OPENBOTS_SANDBOX_BRIDGE   its bridge name (default the network's name)
//   OPENBOTS_DOCKER_GUARD_PORT  where it listens (default 2375)
//   OPENBOTS_DOCKER_GUARD_HOST  the address it listens on (default every interface)
import { createDockerGuard } from './docker-guard.js';
import { DEFAULT_SANDBOX_IMAGE, resolveSandboxNetwork } from './docker.js';

const upstream = process.env.OPENBOTS_DOCKER_UPSTREAM || 'tcp://docker-socket-proxy:2375';
const image = process.env.OPENBOTS_SANDBOX_IMAGE || DEFAULT_SANDBOX_IMAGE;
const port = Number(process.env.OPENBOTS_DOCKER_GUARD_PORT || 2375);
const host = process.env.OPENBOTS_DOCKER_GUARD_HOST || undefined;
// Throws, so the guard does not start, on a name the firewall cannot match.
const network = resolveSandboxNetwork(
  process.env.OPENBOTS_SANDBOX_NETWORK,
  process.env.OPENBOTS_SANDBOX_BRIDGE,
);

const log = (fields: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ time: Date.now(), ...fields })}\n`);

const server = createDockerGuard({
  upstream,
  policy: { image, network },
  onRefuse: (request, reason) => log({ level: 'warn', msg: 'refused', ...request, reason }),
});
server.listen(port, host, () =>
  log({ level: 'info', msg: 'listening', host, port, upstream, image, network: network.name }),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
