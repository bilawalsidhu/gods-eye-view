// DATA_SOURCES.md must attribute the bundled USNO fixture: the solunar card
// computes its times in the browser, but the test fixture is a snapshot of
// the US Naval Observatory's data, and a bundled dataset carries its own
// licence and credit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const sources = read('DATA_SOURCES.md');
const row = sources
  .split('\n')
  .find((line) => line.includes('Solunar reference times'));

test('DATA_SOURCES.md has a bundled row for the USNO fixture', () => {
  assert.ok(row, 'no Solunar reference times row');
  assert.match(row, /src\/solunar\/fixtures\/usnoOneDay\.json/);
  assert.match(row, /USNO|Naval Observatory/);
});

test('the USNO row states the licence, the commercial use and the credit', () => {
  assert.match(row, /public domain|U\.S\. Government work/i);
  assert.match(row, /✅/);
  assert.match(row, /courtesy/);
});

test('the USNO row says the fixture is test data, not a runtime feed', () => {
  assert.match(row, /test data only|test/i);
  assert.match(row, /never fetched at runtime/i);
});

test('CURRENT-STATE.md credits the USNO fixture and names the Swedish strings', () => {
  const current = read('docs/CURRENT-STATE.md');
  const start = current.indexOf('## Solunar —');
  assert.ok(start > -1, 'no Solunar section');
  const section = current.slice(start, current.indexOf('\n## ', start + 1));
  assert.match(section, /USNO/);
  assert.match(section, /DATA_SOURCES\.md/);
  assert.match(section, /Swedish/);
});
