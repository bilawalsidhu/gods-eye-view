import assert from 'node:assert/strict';
import test from 'node:test';
import { platformConfigured, redactDatabaseUrl } from './db.js';
import { platformStatus } from './health.js';

test('the platform is off unless a database url is set', async () => {
  assert.equal(platformConfigured({}), false);
  assert.equal(platformConfigured({ GEV_DATABASE_URL: '  ' }), false);
  assert.equal(platformConfigured({ GEV_DATABASE_URL: 'postgres://x' }), true);
  assert.deepEqual(await platformStatus({ env: {} }), {
    configured: false,
    ok: false,
  });
});

test('a connection string never appears with its password', () => {
  assert.equal(
    redactDatabaseUrl('postgres://gev:s3cret@postgres:5432/gev'),
    'postgres://gev:***@postgres:5432/gev',
  );
  assert.equal(redactDatabaseUrl('not a url'), '(unparseable database url)');
});

test('status reports versions and whether migrations are current', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('server_version'))
        return { rows: [{ server_version: '16.4' }] };
      if (sql.includes('pg_extension'))
        return { rows: [{ extversion: '3.5.0' }] };
      return { rows: [{ v: 7 }] };
    },
  };
  const status = await platformStatus({
    env: { GEV_DATABASE_URL: 'postgres://u:p@h/db' },
    pool,
  });
  assert.equal(status.ok, true);
  assert.equal(status.postgis, '3.5.0');
  assert.equal(status.migrationsApplied, 7);
  assert.equal(status.upToDate, true);
});

test('a failing database is a short reason, with no connection detail', async () => {
  const pool = {
    async query() {
      const error = new Error('password authentication failed for gev:s3cret');
      error.code = '28P01';
      throw error;
    },
  };
  const status = await platformStatus({
    env: { GEV_DATABASE_URL: 'postgres://gev:s3cret@h/db' },
    pool,
  });
  assert.deepEqual(status, { configured: true, ok: false, reason: '28P01' });
  assert.ok(!JSON.stringify(status).includes('s3cret'));
});
