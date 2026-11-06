import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  LIBRARY_ENTRIES,
  LIBRARY_LEDGER,
  LIBRARY_MANIFESTS,
} from './catalog.js';
import { readLibraryLedger } from './selection.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('every manifest file is imported, named after its id', () => {
  const files = readdirSync(path.join(here, 'entries'))
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.deepEqual(
    files,
    LIBRARY_MANIFESTS.map(({ id }) => `${id}.json`).sort(),
  );
  for (const file of files) {
    const raw = JSON.parse(
      readFileSync(path.join(here, 'entries', file), 'utf8'),
    );
    assert.equal(`${raw.id}.json`, file);
  }
});

test('every switchable entry owns a permanent share token', () => {
  const ledger = readLibraryLedger(LIBRARY_LEDGER);
  assert.deepEqual(ledger.errors, []);
  for (const entry of LIBRARY_ENTRIES.filter(({ kind }) => kind !== 'pack'))
    assert.ok(ledger.tokenById.has(entry.id), `${entry.id} has no token`);
  // Packs are switched by their host, never by a share link.
  for (const entry of LIBRARY_ENTRIES.filter(({ kind }) => kind === 'pack'))
    assert.equal(ledger.tokenById.has(entry.id), false, entry.id);
});

test('nothing in the library is bundled: every source is a live https upstream', () => {
  for (const entry of LIBRARY_ENTRIES) {
    assert.match(entry.source.url, /^https:\/\//, entry.id);
    assert.ok(entry.licence.name && entry.licence.url, entry.id);
    assert.ok(entry.attribution.text, entry.id);
  }
});
