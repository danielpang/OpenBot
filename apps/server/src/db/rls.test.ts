import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInfra } from '../infra/index.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { schema, type Db } from './client.js';
import {
  APP_ROLE,
  DIRECTORY_ROLE,
  asDirectory,
  deviceWorkspace,
  devicesExist,
  dueRoutineWorkspaces,
  forEachWorkspace,
  inWorkspace,
  pairingWorkspace,
  webhookWorkspaces,
  workspaceIds,
} from './scope.js';

// Row-level security between organizations (drizzle/0023, db/scope.ts):
// Postgres itself keeps each organization's rows to it, whatever a query
// forgets to filter. These run on PGlite (and on Postgres with DATABASE_URL),
// as the roles the app uses.

/** Rows of a raw query, from postgres.js or PGlite. */
const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result) ? (result as T[]) : ((result as { rows: T[] }).rows ?? []);

/** Raw SQL in one transaction as `role`, with `app.workspace_id` set when given. */
async function as<T>(
  db: Db,
  role: string,
  workspaceId: string | null,
  fn: (q: (query: ReturnType<typeof sql>) => Promise<T[]>) => Promise<unknown>,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('role', ${role}, true)`);
    if (workspaceId)
      await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return fn(async (query) => rowsOf<T>(await tx.execute(query)));
  });
}

/** The error a statement throws, or null; in a savepoint so the transaction goes on. */
async function failure(db: Db, run: (tx: Db) => Promise<unknown>): Promise<string | null> {
  try {
    await db.transaction(async (tx) => {
      await run(tx as unknown as Db);
    });
    return null;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
}

describe('row-level security between organizations', () => {
  let t: TestApp;
  let orgA: string;
  let orgB: string;
  let botA: string;
  let botB: string;
  let owner: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    await t.signUp('ada@example.com');
    owner = await t.userId('ada@example.com');
    orgA = await t.defaultOrganization();
    orgB = await t.createOrganization('Org B');
    await t.addMember(owner, orgB, 'owner');
    const bot = (workspaceId: string, handle: string) =>
      t.db
        .insert(schema.bots)
        .values({ workspaceId, ownerId: owner, name: handle, handle })
        .returning({ id: schema.bots.id })
        .then(([row]) => row!.id);
    botA = await bot(orgA, 'alpha');
    botB = await bot(orgB, 'bravo');
  });
  afterAll(() => t.close());

  it('lets the app role see, change and delete only the organization it is set to', async () => {
    await as<{ id: string }>(t.db, APP_ROLE, orgA, async (q) => {
      expect((await q(sql`select id from bots`)).map((r) => r.id)).toEqual([botA]);
      expect(await q(sql`select id from bots where id = ${botB}`)).toEqual([]);
      expect(await q(sql`update bots set name = 'taken' where id = ${botB} returning id`)).toEqual(
        [],
      );
      expect(await q(sql`delete from bots where id = ${botB} returning id`)).toEqual([]);
      // Its own, yes.
      expect(await q(sql`update bots set name = 'mine' where id = ${botA} returning id`)).toEqual([
        { id: botA },
      ]);
    });
    const [b] = await t.db
      .select()
      .from(schema.bots)
      .where(sql`id = ${botB}`);
    expect(b).toMatchObject({ name: 'bravo' });
  });

  it('refuses to write a row into another organization, or to move one there', async () => {
    const insert = await failure(t.db, (tx) =>
      as(tx, APP_ROLE, orgA, (q) =>
        q(
          sql`insert into bots (workspace_id, owner_id, name, handle) values (${orgB}, ${owner}, 'x', 'x')`,
        ),
      ),
    );
    expect(insert).toMatch(/row-level security/);
    const move = await failure(t.db, (tx) =>
      as(tx, APP_ROLE, orgA, (q) =>
        q(sql`update bots set workspace_id = ${orgB} where id = ${botA}`),
      ),
    );
    expect(move).toMatch(/row-level security/);
  });

  it('shows nothing and takes nothing with no organization set', async () => {
    await as<{ n: number }>(t.db, APP_ROLE, null, async (q) => {
      for (const table of ['bots', 'chats', 'workspace_members', 'audit_log', 'workspaces']) {
        const [row] = await q(sql.raw(`select count(*)::int as n from ${table}`));
        expect(row!.n, table).toBe(0);
      }
    });
    const insert = await failure(t.db, (tx) =>
      as(tx, APP_ROLE, null, (q) =>
        q(
          sql`insert into bots (workspace_id, owner_id, name, handle) values (${orgA}, ${owner}, 'x', 'y')`,
        ),
      ),
    );
    expect(insert).toMatch(/row-level security/);
  });

  it('forces RLS, with a policy, on every table with workspace_id', async () => {
    const tables = rowsOf<{ table: string; rls: boolean; forced: boolean; policies: number }>(
      await t.db.execute(sql`
        select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
          (select count(*)::int from pg_policy p where p.polrelid = c.oid
             and pg_get_expr(p.polqual, p.polrelid) like '%app.workspace_id%'
             and pg_get_expr(p.polwithcheck, p.polrelid) like '%app.workspace_id%') as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped
        where n.nspname = 'public' and c.relkind = 'r'
        order by 1`),
    );
    expect(tables.length).toBeGreaterThan(30);
    const missing = tables.filter((r) => !r.rls || !r.forced || r.policies < 1).map((r) => r.table);
    expect(missing).toEqual([]);
    // And each one leads an index with workspace_id.
    const unindexed = rowsOf<{ table: string }>(
      await t.db.execute(sql`
        select c.relname as table from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped
        where n.nspname = 'public' and c.relkind = 'r' and not exists (
          select from pg_index i join pg_attribute k on k.attrelid = i.indrelid and k.attnum = i.indkey[0]
          where i.indrelid = c.oid and k.attname = 'workspace_id')`),
    ).map((r) => r.table);
    expect(unindexed).toEqual([]);
  });

  it('runs the app as a role that owns nothing and bypasses nothing', async () => {
    const [role] = rowsOf<{ super: boolean; bypass: boolean; owns: number }>(
      await t.db.execute(sql`
        select rolsuper as super, rolbypassrls as bypass,
          (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and pg_get_userbyid(c.relowner) = ${APP_ROLE}) as owns
        from pg_roles where rolname = ${APP_ROLE}`),
    );
    expect(role).toEqual({ super: false, bypass: false, owns: 0 });
    const [directory] = rowsOf<{ bypass: boolean }>(
      await t.db.execute(
        sql`select rolbypassrls as bypass from pg_roles where rolname = ${DIRECTORY_ROLE}`,
      ),
    );
    expect(directory!.bypass).toBe(false);
  });

  it("keeps a query that forgets its organization filter in the request's organization", async () => {
    // The app's own handle, as a service would use it: no workspace_id filter at all.
    const everything = () => t.deps.db.select({ id: schema.bots.id }).from(schema.bots);
    expect((await inWorkspace(orgA, everything)).map((r) => r.id)).toEqual([botA]);
    expect((await inWorkspace(orgB, everything)).map((r) => r.id)).toEqual([botB]);
    expect(await everything()).toEqual([]);
    // A broken update or delete cannot reach across either.
    const touched = await inWorkspace(orgA, () =>
      t.deps.db.update(schema.bots).set({ name: 'oops' }).returning({ id: schema.bots.id }),
    );
    expect(touched.map((r) => r.id)).toEqual([botA]);
    expect(
      (
        await t.db
          .select()
          .from(schema.bots)
          .where(sql`name = 'oops'`)
      ).length,
    ).toBe(1);
  });

  it('gives the directory the membership tables of every organization, and no tenant data', async () => {
    const members = await asDirectory(() =>
      t.deps.db
        .select()
        .from(schema.workspaceMembers)
        .where(sql`user_id = ${owner}`),
    );
    expect(members.map((m) => m.workspaceId).sort()).toEqual([orgA, orgB].sort());
    const denied = await failure(t.db, (tx) =>
      as(tx, DIRECTORY_ROLE, null, (q) => q(sql`select id from bots`)),
    );
    expect(denied).toMatch(/permission denied/);
  });

  it('answers system lookups with ids only, through SECURITY DEFINER functions', async () => {
    expect((await workspaceIds(t.deps.db)).sort()).toEqual([orgA, orgB].sort());
    expect(await webhookWorkspaces(t.deps.db, botB, 'nope', true)).toEqual([]);
    expect(await dueRoutineWorkspaces(t.deps.db)).toEqual([]);
    const seen = await forEachWorkspace(t.deps.db, async () =>
      (await t.deps.db.select({ id: schema.bots.id }).from(schema.bots)).map((r) => r.id),
    );
    expect(seen.flat().sort()).toEqual([botA, botB].sort());
  });

  it("finds a device's or a pairing's organization through SECURITY DEFINER functions only", async () => {
    const key = Buffer.alloc(32, 1);
    const revokedKey = Buffer.alloc(32, 2);
    const hash = Buffer.alloc(32, 3);
    expect(await devicesExist(t.deps.db)).toBe(false);
    await t.db.insert(schema.devices).values([
      { workspaceId: orgB, ownerId: owner, name: 'Phone', platform: 'ios', publicKey: key },
      {
        workspaceId: orgA,
        ownerId: owner,
        name: 'Old phone',
        platform: 'ios',
        publicKey: revokedKey,
        revokedAt: new Date(),
      },
    ]);
    await t.db.insert(schema.devicePairings).values({
      workspaceId: orgA,
      ownerId: owner,
      codeHash: hash,
      name: 'Home',
      expiresAt: new Date(Date.now() + 60_000),
      createdBy: 'user',
    });
    // The app's own handle, in no organization: the rows are out of reach...
    expect(await t.deps.db.select().from(schema.devices)).toEqual([]);
    expect(await t.deps.db.select().from(schema.devicePairings)).toEqual([]);
    // ...and the functions answer an id, or no.
    expect(await deviceWorkspace(t.deps.db, key)).toBe(orgB);
    expect(await deviceWorkspace(t.deps.db, revokedKey)).toBeNull();
    expect(await deviceWorkspace(t.deps.db, Buffer.alloc(32, 9))).toBeNull();
    expect(await pairingWorkspace(t.deps.db, hash)).toBe(orgA);
    expect(await pairingWorkspace(t.deps.db, Buffer.alloc(32, 9))).toBeNull();
    expect(await devicesExist(t.deps.db)).toBe(true);
    // In organization A, B's device is out of reach too.
    const inA = await inWorkspace(orgA, () =>
      t.deps.db.select({ name: schema.devices.name }).from(schema.devices),
    );
    expect(inA).toEqual([{ name: 'Old phone' }]);

    const lookups = [
      'openbots_device_workspace',
      'openbots_devices_exist',
      'openbots_pairing_workspace',
    ];
    const functions = rowsOf<{ name: string; definer: boolean; owner: string }>(
      await t.db.execute(sql`
        select p.proname as name, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ${lookups}
        order by 1`),
    );
    expect(functions).toEqual(
      lookups.map((name) => ({ name, definer: true, owner: 'openbots_system' })),
    );
    await t.db.delete(schema.devices);
    await t.db.delete(schema.devicePairings);
  });

  it('lets the app role keep the install-wide relay identity with no organization set', async () => {
    await as<{ n: number }>(t.db, APP_ROLE, null, async (q) => {
      await q(sql`insert into instance_keys (signing_key, public_key) values ('\x01', '\x02')`);
      const [row] = await q(sql`select count(*)::int as n from instance_keys`);
      expect(row!.n).toBe(1);
      await q(sql`delete from instance_keys`);
    });
  });

  it('runs a job in the organization that queued it, and refuses one for another or for none', async () => {
    const infra = createInfra({});
    try {
      // Every queue is a scoped one (infra/index.ts).
      const queue = infra.queue<{ n: number }>('rls-test');
      const seen: string[][] = [];
      await queue.process(async () => {
        seen.push(
          (await t.deps.db.select({ id: schema.bots.id }).from(schema.bots)).map((r) => r.id),
        );
      });
      await inWorkspace(orgB, () => queue.enqueue('job', { n: 1 }));
      await expect(queue.enqueue('job', { n: 2 })).rejects.toThrow(/outside an organization/);
      await expect(
        inWorkspace(orgA, () => queue.enqueue('job', { n: 3, workspaceId: orgB } as never)),
      ).rejects.toThrow(/another organization/);
      await expect.poll(() => seen).toEqual([[botB]]);
    } finally {
      await infra.close();
    }
  });
});
