// The managed OpenBots server (plan 21.5): the core server, extended with
// organizations. Needs OPENBOTS_DEPLOYMENT=managed.
import { runServer } from '@openbots/server/server';
import { emailFromEnv, managedExtensions } from './index.js';

if (process.env.OPENBOTS_DEPLOYMENT !== 'managed') {
  throw new Error('The managed server needs OPENBOTS_DEPLOYMENT=managed');
}

await runServer(managedExtensions({ email: emailFromEnv() }));
