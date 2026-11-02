import { afterAll } from 'vitest';
import { deferTestDbDrops, dropClosedTestDbs } from '@openbots/server/db/test-db';

// Test databases closed during a file are dropped once it ends (as in apps/server).
deferTestDbDrops();
afterAll(dropClosedTestDbs);
