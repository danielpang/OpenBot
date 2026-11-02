// The self-hosted server: the core with no extensions (plan 21.5). The managed
// service starts from ee/server, which passes its own to `runServer`.
import { runServer } from './server.js';
import { startWorkers } from './workers.js';

export { startWorkers };

await runServer();
