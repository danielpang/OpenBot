import { afterAll } from 'vitest';
import { deferTestDbDrops, dropClosedTestDbs } from './db/test-db.js';

// Test databases closed during a file are dropped once it ends (db/test-db.ts).
deferTestDbDrops();
afterAll(dropClosedTestDbs);
