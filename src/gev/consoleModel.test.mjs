import test from 'node:test';
import assert from 'node:assert/strict';
import {
  interpolateTrack,
  viewBbox,
  bboxParam,
  ago,
  slugId,
  parseEntries,
  formatEntry,
  ruleFromForm,
  fenceFromClicks,
  sparklinePath,
  coverageColor,
  esc,
} from './console/model.js';
import { validateRule, validateFence, validateWatchlist } from '../sources/alertRules.js';

const T = 1_800_000_000_000;

test('interpolateTrack interpolates, holds briefly, and refuses gaps', () => {
  const fixes = [
    [T, 10, 20, 1000, 90, 200],
    [T + 60_000, 11, 21, 2000, 90, 220],
    [T + 60_000 + 20 * 60_000, 15, 25, 3000, 90, 220],
  ];
  const mid = interpolateTrack(fixes, T + 30_000);
  assert.deepEqual([mid.lat, mid.lon, mid.alt, mid.speed], [10.5, 20.5, 1500, 210]);
  assert.equal(interpolateTrack(fixes, T - 1), null);
  const inGap = interpolateTrack(fixes, T + 60_000 + 60_000);
  assert.equal(inGap.held, true, 'held at the last fix just after it');
  assert.equal(interpolateTrack(fixes, T + 60_000 + 5 * 60_000), null, 'no invented path across a gap');
  const anti = interpolateTrack([[T, 0, 179, null, null, null], [T + 1000, 0, -179, null, null, null]], T + 500);
  assert.ok(Math.abs(Math.abs(anti.lon) - 180) < 1e-9, 'interpolates across the antimeridian');
});

test('viewBbox clamps and refuses global or wrapped views', () => {
  assert.deepEqual(viewBbox({ west: -122, south: 37, east: -121, north: 38 }), { minLat: 37, minLon: -122, maxLat: 38, maxLon: -121 });
  assert.equal(viewBbox({ west: 170, south: 0, east: -170, north: 10 }), null);
  assert.equal(viewBbox({ west: -180, south: -90, east: 180, north: 90 }), null);
  assert.equal(bboxParam({ minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 }), '1.00000,2.00000,3.00000,4.00000');
});

test('small formatters', () => {
  assert.equal(ago(T - 90_000, T), '2 min ago');
  assert.equal(ago(T + 30_000, T), 'in 30 s');
  assert.equal(slugId('Bay Area!'), 'bay-area');
  assert.equal(slugId('Bay Area', ['bay-area']), 'bay-area-2');
  assert.equal(esc('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  assert.deepEqual(coverageColor(0), null);
  assert.equal(coverageColor(5)[0], 255);
});

test('watchlist entry text round-trips and validates', () => {
  const { entries, errors } = parseEntries('air ABC123\nair label:n911\nsea 366999999, space 25544\nbogus line');
  assert.equal(errors.length, 1);
  assert.deepEqual(entries.map(formatEntry), ['air abc123', 'air label:N911', 'sea 366999999', 'space 25544']);
  assert.doesNotThrow(() => validateWatchlist({ name: 'w', entries }));
});

test('rule form produces payloads the server validator accepts', () => {
  const ctx = { fences: [{ id: 'f' }], watchlists: [{ id: 'w' }], channels: [{ id: 'c' }] };
  const cases = [
    { kind: 'fence-enter', fenceId: 'f' },
    { kind: 'fence-dwell', fenceId: 'f', minutes: '15' },
    { kind: 'squawk', codes: '7700 7600' },
    { kind: 'dark', watchlistId: 'w', minutes: '30' },
    { kind: 'appear', watchlistId: 'w', minutes: '60' },
    { kind: 'speed', max: '300', domain: 'air' },
    { kind: 'altitude', min: '100' },
    { kind: 'loiter', radiusKm: '3', minutes: '15' },
    { kind: 'overhead', fenceId: 'f', watchlistId: 'w', minElevDeg: '30' },
  ];
  for (const c of cases) {
    const payload = ruleFromForm({ name: c.kind, severity: 'warning', channelId: 'c', ...c });
    assert.doesNotThrow(() => validateRule(payload, ctx), c.kind);
  }
});

test('fences from clicks', () => {
  assert.equal(fenceFromClicks('circle', [{ lat: 0, lon: 0 }], 'x'), null);
  const circle = fenceFromClicks('circle', [{ lat: 38, lon: -121 }, { lat: 38.01, lon: -121 }], 'c');
  assert.ok(Math.abs(circle.shape.radiusM - 1112) < 2);
  assert.doesNotThrow(() => validateFence(circle));
  const poly = fenceFromClicks('polygon', [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }], 'p');
  assert.doesNotThrow(() => validateFence(poly));
});

test('sparkline path breaks on missing buckets', () => {
  const d = sparklinePath([{ t: 0, uptime: 1 }, { t: 1, uptime: null }, { t: 2, uptime: 0 }], 100, 10);
  assert.equal(d, 'M0.0 0.0M100.0 10.0');
});
