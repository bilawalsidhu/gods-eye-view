/**
 * @module platform/migrate
 *
 * Applies the numbered SQL files in `db/migrations/` to the platform database.
 *
 * Plain SQL, no ORM. Each file runs in its own transaction and is recorded in
 * `gev_migration` with a SHA-256 of its text. A recorded file whose text has
 * changed is an error: shipped migrations are never edited, a change is a new
 * file. Two processes starting together are serialised by an advisory lock.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db/migrations',
);

const FILE_NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
/** Arbitrary constant: the advisory-lock key that serialises migrators. */
const LOCK_KEY = 0x67657601;

/**
 * The migration files in order, with their checksums.
 * @param {string} [dir]
 * @returns {Promise<Array<{version: number, name: string, sql: string, sha256: string}>>}
 */
export async function loadMigrations(dir = MIGRATIONS_DIR) {
  const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.sql'));
  const migrations = [];
  const seen = new Set();
  for (const name of names.sort()) {
    const match = FILE_NAME.exec(name);
    if (!match)
      throw new Error(`Migration ${name} must be named NNNN_snake_case.sql`);
    const version = Number(match[1]);
    if (seen.has(version))
      throw new Error(`Two migrations claim version ${version}`);
    seen.add(version);
    const sql = await fsp.readFile(path.join(dir, name), 'utf8');
    migrations.push({
      version,
      name,
      sql,
      sha256: createHash('sha256').update(sql).digest('hex'),
    });
  }
  // Versions must be contiguous from 1: a gap means a file went missing.
  migrations.forEach((m, index) => {
    if (m.version !== index + 1)
      throw new Error(
        `Migration versions must run 1..N without gaps; ${m.name} is out of place`,
      );
  });
  return migrations;
}

/**
 * Apply every migration not yet recorded.
 *
 * @param {{query: Function}} client A connected pg client (one connection:
 *   the advisory lock and the transactions need to share a session).
 * @param {{dir?: string, log?: (line: string) => void}} [options]
 * @returns {Promise<{applied: string[], total: number}>}
 */
export async function applyMigrations(client, { dir, log = () => {} } = {}) {
  const migrations = await loadMigrations(dir);
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.gev_migration (
        version     integer PRIMARY KEY,
        name        text NOT NULL,
        sha256      text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query(
      'SELECT version, name, sha256 FROM public.gev_migration ORDER BY version',
    );
    const recorded = new Map(rows.map((row) => [row.version, row]));
    const applied = [];
    for (const migration of migrations) {
      const done = recorded.get(migration.version);
      if (done) {
        if (done.sha256 !== migration.sha256)
          throw new Error(
            `Migration ${migration.name} was changed after it was applied; add a new migration instead`,
          );
        continue;
      }
      log(`applying ${migration.name}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO public.gev_migration (version, name, sha256) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.sha256],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.name} failed: ${error.message}`);
      }
      applied.push(migration.name);
    }
    for (const row of rows)
      if (!migrations.some((m) => m.version === row.version))
        throw new Error(
          `The database has migration ${row.name} that this checkout does not`,
        );
    return { applied, total: migrations.length };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}
