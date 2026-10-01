import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBurntAreasSnapshot } from './records.js';

const validArea = {
  id: 'ba-1',
  lon: 10.05,
  lat: 45.05,
  polygon: [
    [10, 45],
    [10.1, 45],
    [10.1, 45.1],
    [10, 45.1],
    [10, 45],
  ],
  areaHa: 42,
  fireDate: '2026-09-22 00:00:00',
};

test('T2: normalizeBurntAreasSnapshot passes through a well-formed row', () => {
  const rows = normalizeBurntAreasSnapshot({ areas: [validArea] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'ba-1');
  assert.equal(rows[0].polygon.length, 5);
  assert.equal(rows[0].areaHa, 42);
  assert.equal(rows[0].fireDate, '2026-09-22 00:00:00');
});

test('T2: normalizeBurntAreasSnapshot passes through null areaHa/fireDate unchanged (both schema-optional upstream)', () => {
  const rows = normalizeBurntAreasSnapshot({
    areas: [{ ...validArea, id: 'ba-3', areaHa: null, fireDate: null }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].areaHa, null);
  assert.equal(rows[0].fireDate, null);
});

test('T2: normalizeBurntAreasSnapshot drops rows with out-of-range coordinates', () => {
  const bad = { ...validArea, id: 'ba-2', lat: 200 };
  const rows = normalizeBurntAreasSnapshot({ areas: [validArea, bad] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'ba-1');
});

test('T2: normalizeBurntAreasSnapshot returns null for a malformed payload', () => {
  assert.equal(normalizeBurntAreasSnapshot({}), null);
  assert.equal(normalizeBurntAreasSnapshot(null), null);
});
