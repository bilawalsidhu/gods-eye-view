import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftOperationLabel,
  aircraftRegistryLine,
  brazilianTail,
} from './aircraftRegistry.js';
import { setLocale } from '../i18n/index.js';
import { createFlightSource } from '../sources/live/standalone.js';

test.afterEach(() => setLocale('en'));

test('the registry line reads year, seats and operation in English', () => {
  setLocale('en');
  assert.equal(
    aircraftRegistryLine({ year: 1972, seats: 1, operation: 'private' }),
    'Built 1972 · 1 seat · Private',
  );
  assert.equal(
    aircraftRegistryLine({ year: 2024, seats: 13, operation: 'airline' }),
    'Built 2024 · 13 seats · Airline',
  );
  assert.equal(
    aircraftRegistryLine({ year: null, seats: 8, operation: 'air-taxi' }),
    '8 seats · Air taxi',
  );
  assert.equal(aircraftRegistryLine({ year: 1990, seats: null, operation: null }), 'Built 1990');
});

test('a registry record with nothing to show gives no line', () => {
  assert.equal(aircraftRegistryLine(null), '');
  assert.equal(aircraftRegistryLine(undefined), '');
  assert.equal(aircraftRegistryLine({}), '');
  assert.equal(aircraftRegistryLine({ seats: 0, operation: 'unknown' }), '');
  assert.equal(aircraftOperationLabel('unknown'), '');
});

test('the registry line follows the page language and its plurals', () => {
  setLocale('pt');
  assert.equal(
    aircraftRegistryLine({ year: 2020, seats: 8, operation: 'air-taxi' }),
    'Fabricado em 2020 · 8 assentos · Táxi aéreo',
  );
  assert.equal(aircraftOperationLabel('government'), 'Governamental');
  setLocale('ru');
  assert.equal(
    aircraftRegistryLine({ seats: 2, operation: 'private' }),
    '2 места · Частный',
  );
  assert.equal(aircraftRegistryLine({ seats: 5 }), '5 мест');
});

test('a Brazilian mark flown as callsign is a tail only from a Brazilian transponder', () => {
  assert.equal(brazilianTail('e4a6b9', 'PTTSI '), 'PTTSI');
  assert.equal(brazilianTail('E7FFFF', 'pr-abc'), 'PRABC');
  assert.equal(brazilianTail('e48ba8', 'TAM8147'), null, 'airline callsign');
  assert.equal(brazilianTail('a1b2c3', 'PTTSI'), null, 'not a Brazilian hex');
  assert.equal(brazilianTail('e80000', 'PTTSI'), null, 'just past the block');
  assert.equal(brazilianTail('e4a6b9', 'PATSI'), null, 'not a Brazilian prefix');
  assert.equal(brazilianTail('e4a6b9', null), null);
});

test('the flight source sends the tail with a type lookup and nowhere else', async () => {
  const urls = [];
  const source = createFlightSource({
    fetchImpl: async (url) => {
      urls.push(String(url));
      return Response.json({ found: false });
    },
  });
  await source.getEnrichment({ kind: 'type', id: 'e4a6b9', tail: 'PTTSI' });
  await source.getEnrichment({ kind: 'type', id: 'a1b2c3' });
  await source.getEnrichment({ kind: 'route', id: 'TAM8147', tail: 'PTTSI' });
  assert.deepEqual(urls, [
    '/api/adsbdb/type/e4a6b9?tail=PTTSI',
    '/api/adsbdb/type/a1b2c3',
    '/api/adsbdb/route/TAM8147',
  ]);
});
