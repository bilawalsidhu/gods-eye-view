// src/data/neoFeed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neoFeedWindow, normalizeNeoFeed } from './neoFeed.js';

/** One well-formed NeoWs NEO object with the fields the seam keeps. */
function neo({
  id = '12345',
  name = '433 Eros (1898 DQ)',
  hazardous = false,
  missKm = '1234567',
  missLunar = '3.21',
  velocityKph = '45000',
  approachMs = 1757600000000,
  sizeMin = 0.5,
  sizeMax = 1.5,
  absMag = 15,
} = {}) {
  const neoObject = {
    neo_reference_id: id,
    name,
    is_potentially_hazardous_asteroid: hazardous,
    absolute_magnitude_h: absMag,
    estimated_diameter: {
      kilometers: { estimated_diameter_min: sizeMin, estimated_diameter_max: sizeMax },
    },
    close_approach_data: [{
      epoch_date_close_approach: approachMs,
      miss_distance: { kilometers: missKm, lunar: missLunar },
      relative_velocity: { kilometers_per_hour: velocityKph },
    }],
  };
  // undefined destructure defaults never apply to explicit nulls inside the
  // nested close-approach payload — the values land exactly as passed.
  return neoObject;
}
test('neoFeedWindow: 7-day span, ISO day strings, upstream cap respected', () => {
  const now = Date.UTC(2026, 8, 11);
  const w = neoFeedWindow(now);
  assert.equal(w.start_date, '2026-09-11');
  assert.equal(w.end_date, '2026-09-18');
  const capped = neoFeedWindow(now, 30);
  assert.equal(capped.end_date, '2026-09-18'); // NeoWs hard cap: 7 days
});

test('normalizeNeoFeed: flat rows, sorted by approach time, size averaged', () => {
  const payload = {
    near_earth_objects: {
      '2026-09-11': [neo({ id: 'b', approachMs: 200 })],
      '2026-09-12': [neo({ id: 'a', approachMs: 100, hazardous: true })],
    },
  };
  const rows = normalizeNeoFeed(payload);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
  assert.equal(rows[0].hazardous, true);
  assert.equal(rows[0].sizeM, 1000); // (0.5 + 1.5)/2 km = 1 km = 1000 m
  assert.equal(rows[0].missKm, 1234567);
  assert.equal(rows[0].missLunar, 3.21);
  assert.equal(rows[0].velocityKph, 45000);
  assert.equal(rows[0].absMag, 15);
});

test('normalizeNeoFeed: rows missing required distance or time are skipped', () => {
  const payload = {
    near_earth_objects: {
      '2026-09-11': [
        neo({ id: 'ok' }),
        neo({ id: 'bad-miss', missKm: null }),
        neo({ id: 'bad-time', approachMs: null }),
        neo({ id: 'no-name', name: '' }),
      ],
    },
  };
  const rows = normalizeNeoFeed(payload);
  assert.deepEqual(rows.map((r) => r.id), ['ok']);
});

test('normalizeNeoFeed: malformed feed shapes return null', () => {
  assert.equal(normalizeNeoFeed(null), null);
  assert.equal(normalizeNeoFeed([]), null);
  assert.equal(normalizeNeoFeed({}), null);
  assert.equal(normalizeNeoFeed({ near_earth_objects: null }), null);
  assert.equal(normalizeNeoFeed({ near_earth_objects: { day: 'not-a-list' } }), null);
  assert.equal(normalizeNeoFeed({ near_earth_objects: { day: ['nope'] } }), null);
  // Duplicate ids mean a broken feed — reject atomically, keep last good data.
  assert.equal(normalizeNeoFeed({ near_earth_objects: { d: [neo({ id: 'x' }), neo({ id: 'x' })] } }), null);
});

test('normalizeNeoFeed: optional fields degrade to null, hazardous defaults false', () => {
  const bare = neo({ missLunar: null, velocityKph: null, sizeMin: null, sizeMax: null, absMag: null });
  const payload = { near_earth_objects: { d: [bare] } };
  const rows = normalizeNeoFeed(payload);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.missLunar, null);
  assert.equal(row.velocityKph, null);
  assert.equal(row.sizeM, null);
  assert.equal(row.absMag, null);
  assert.equal(row.hazardous, false);
  assert.ok(Number.isFinite(row.missKm));
  assert.ok(Number.isFinite(row.approachMs));
});
