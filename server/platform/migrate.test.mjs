import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyMigrations, loadMigrations, MIGRATIONS_DIR } from './migrate.js';

/** A pg client double that records SQL and a tiny gev_migration table. */
function fakeClient({ recorded = [], failOn = null } = {}) {
  const log = [];
  const rows = [...recorded];
  return {
    log,
    rows,
    async query(sql, params) {
      const text = String(sql).trim();
      log.push(text.split('\n')[0].slice(0, 60));
      if (text.startsWith('SELECT version, name, sha256'))
        return { rows: [...rows] };
      if (text.startsWith('INSERT INTO public.gev_migration'))
        rows.push({ version: params[0], name: params[1], sha256: params[2] });
      if (failOn && text.includes(failOn)) throw new Error('boom');
      return { rows: [] };
    },
  };
}

async function tempDir(files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-mig-'));
  for (const [name, sql] of Object.entries(files))
    await fsp.writeFile(path.join(dir, name), sql);
  return dir;
}

test('the shipped migrations load in order with checksums and no gaps', async () => {
  const migrations = await loadMigrations(MIGRATIONS_DIR);
  assert.ok(migrations.length >= 7);
  migrations.forEach((m, i) => assert.equal(m.version, i + 1));
  assert.ok(migrations.every((m) => /^[0-9a-f]{64}$/.test(m.sha256)));
  // Every file starts from a known search path, so objects land in `gev`.
  for (const m of migrations.slice(1))
    assert.match(m.sql, /SET search_path = gev, public;/, m.name);
});

test('a badly named, duplicated or gapped migration set is refused', async () => {
  await assert.rejects(
    loadMigrations(await tempDir({ '1_bad.sql': '' })),
    /NNNN_snake_case/,
  );
  await assert.rejects(
    loadMigrations(await tempDir({ '0001_a.sql': '', '0003_b.sql': '' })),
    /without gaps/,
  );
  await assert.rejects(
    loadMigrations(await tempDir({ '0001_a.sql': '', '0001_b.sql': '' })),
    /Two migrations claim version 1/,
  );
});

test('only unrecorded migrations run, each in its own transaction', async () => {
  const dir = await tempDir({
    '0001_a.sql': 'SELECT 1;',
    '0002_b.sql': 'SELECT 2;',
  });
  const client = fakeClient();
  const first = await applyMigrations(client, { dir });
  assert.deepEqual(first.applied, ['0001_a.sql', '0002_b.sql']);
  assert.equal(client.log.filter((l) => l === 'BEGIN').length, 2);
  assert.equal(client.log.filter((l) => l === 'COMMIT').length, 2);
  const second = await applyMigrations(client, { dir });
  assert.deepEqual(second.applied, [], 'a second run changes nothing');
});

test('a migration changed after it was applied is an error', async () => {
  const dir = await tempDir({ '0001_a.sql': 'SELECT 1;' });
  const client = fakeClient();
  await applyMigrations(client, { dir });
  await fsp.writeFile(path.join(dir, '0001_a.sql'), 'SELECT 99;');
  await assert.rejects(applyMigrations(client, { dir }), /changed after/);
});

test('a database ahead of the checkout is an error, not a silent skip', async () => {
  const dir = await tempDir({ '0001_a.sql': 'SELECT 1;' });
  const client = fakeClient({
    recorded: [{ version: 2, name: '0002_future.sql', sha256: 'x' }],
  });
  await assert.rejects(applyMigrations(client, { dir }), /does not/);
});

test('a failing migration rolls back, is not recorded, and releases the lock', async () => {
  const dir = await tempDir({ '0001_a.sql': 'BAD SQL;' });
  const client = fakeClient({ failOn: 'BAD SQL' });
  await assert.rejects(
    applyMigrations(client, { dir }),
    /0001_a.sql failed: boom/,
  );
  assert.ok(client.log.includes('ROLLBACK'));
  assert.equal(client.rows.length, 0);
  assert.ok(client.log.at(-1).startsWith('SELECT pg_advisory_unlock'));
});

// Needs a real PostGIS database; skipped unless one is provided.
//   GEV_TEST_DATABASE_URL=postgres://... node --test server/platform/
const live = process.env.GEV_TEST_DATABASE_URL;
test(
  'every migration applies to a real PostGIS database, twice',
  { skip: !live && 'set GEV_TEST_DATABASE_URL to run against PostGIS' },
  async () => {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: live });
    await client.connect();
    try {
      await client.query('DROP SCHEMA IF EXISTS gev CASCADE');
      await client.query('DROP TABLE IF EXISTS public.gev_migration');
      const first = await applyMigrations(client);
      assert.equal(first.applied.length, first.total);
      const again = await applyMigrations(client);
      assert.deepEqual(again.applied, []);
      const { rows } = await client.query(
        "SELECT key FROM gev.object_type WHERE key = 'person'",
      );
      assert.equal(rows.length, 1);
      // A person without a stated basis must fail the type's own schema.
      const schema = await client.query(
        "SELECT props_schema FROM gev.object_type WHERE key = 'person'",
      );
      assert.deepEqual(schema.rows[0].props_schema.required, ['basis']);
    } finally {
      await client.end();
    }
  },
);
