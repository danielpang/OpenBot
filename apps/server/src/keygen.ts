// `pnpm --filter @openbots/server keygen`: prints a fresh OPENBOTS_MASTER_KEY.
import { generateMasterKey } from './secrets.js';

console.log(generateMasterKey());
