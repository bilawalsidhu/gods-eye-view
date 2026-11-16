// Apply db/migrations to the database named by GEV_DATABASE_URL.
//
//   npm run platform:migrate
//
// Safe to run repeatedly: applied files are skipped, and a changed file is an
// error. Reads .env like the dev server does.
import fs from 'node:fs';
import pg from 'pg';
import { applyMigrations } from '../server/platform/migrate.js';
import { redactDatabaseUrl } from '../server/platform/db.js';

function readDotEnv(file = '.env') {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const url = process.env.GEV_DATABASE_URL || readDotEnv().GEV_DATABASE_URL || '';
if (!url) {
  console.error(
    'GEV_DATABASE_URL is not set (see docs/platform/OPERATIONS.md)',
  );
  process.exit(2);
}
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const { applied, total } = await applyMigrations(client, {
    log: (line) => console.log(line),
  });
  console.log(
    applied.length
      ? `Applied ${applied.length} of ${total} migrations to ${redactDatabaseUrl(url)}`
      : `Already up to date (${total} migrations) at ${redactDatabaseUrl(url)}`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
