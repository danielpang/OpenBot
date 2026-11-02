import { runSoak } from './soak.js';

// `pnpm --filter @openbots/server soak`: the 1.0 soak test (plan 18.9), an hour
// by default. SOAK_MINUTES, SOAK_BOTS, SOAK_IN_FLIGHT and SOAK_SEED change the
// shape; DATABASE_URL and REDIS_URL point it at a real Postgres and Redis (the
// compose stack's, for example). Exits non-zero on any violation or leak.

const number = (name: string, fallback: number) => {
  const value = process.env[name];
  return value ? Number(value) : fallback;
};

const seed = number('SOAK_SEED', Date.now() % 2 ** 31);
const report = await runSoak({
  durationMs: number('SOAK_MINUTES', 60) * 60_000,
  bots: number('SOAK_BOTS', 10),
  inFlight: number('SOAK_IN_FLIGHT', 20),
  seed,
  log: (line) => console.log(line),
});

console.log(JSON.stringify({ seed, ...report }, null, 2));
if (report.violations.length || report.leaks.length) {
  console.error(
    `soak failed: ${report.violations.length} ordering violations, ${report.leaks.length} leaks (seed ${seed})`,
  );
  process.exit(1);
}
console.log(`soak passed: ${report.runs} runs, ${report.approvals} approvals (seed ${seed})`);
process.exit(0);
