import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectAlongGreatCircle,
  reckoningConfidence,
  reckonVessel,
  buildCoverageCells,
  coverageCellKey,
  classifyGap,
  reckoningEnabled,
  reckoningMaxHours,
  RECKONING_DEFAULTS,
} from './ais-reckoning.js';

const NOW = 1_700_000_000;

function underway(overrides = {}) {
  return {
    lat: 0,
    lon: 0,
    speed: 10, // knots
    course: 90, // due east
    nav_status: 0,
    last_position_epoch: NOW - 3600,
    ...overrides,
  };
}

test('great-circle projection moves the expected distance', () => {
  // 10 knots for 1 hour = 10 nm = 18,520 m due east from the equator.
  const out = projectAlongGreatCircle(0, 0, 90, 18520);
  assert.ok(Math.abs(out.lat) < 1e-6, 'due east from the equator holds latitude');
  const expectedLon = 18520 / (6371008.8 * (Math.PI / 180));
  assert.ok(Math.abs(out.lon - expectedLon) < 1e-3, `lon ${out.lon} ≈ ${expectedLon}`);
});

test('projection normalizes longitude across the antimeridian', () => {
  const out = projectAlongGreatCircle(0, 179.9, 90, 40000);
  assert.ok(out.lon <= 180 && out.lon >= -180, `lon ${out.lon} stays in range`);
  assert.ok(out.lon < 0, 'crossing 180E emerges in the western hemisphere');
});

test('confidence decays to zero at the horizon', () => {
  assert.equal(reckoningConfidence(0, 12), 1);
  assert.equal(reckoningConfidence(12 * 3600, 12), 0);
  assert.equal(reckoningConfidence(24 * 3600, 12), 0);
  const early = reckoningConfidence(3600, 12);
  const late = reckoningConfidence(9 * 3600, 12);
  assert.ok(early > late, 'older estimates are less trusted');
  assert.ok(early > 0.8 && late < 0.1, `early ${early} late ${late}`);
});

test('a vessel under way is projected along its course', () => {
  const result = reckonVessel(underway(), NOW, 12);
  assert.equal(result.moved, true);
  assert.equal(result.elapsedSec, 3600);
  assert.ok(result.lon > 0.16 && result.lon < 0.17, `lon ${result.lon}`);
  assert.ok(Math.abs(result.lat) < 1e-6);
});

test('a moored vessel holds its last position', () => {
  const result = reckonVessel(underway({ nav_status: 5, speed: 0 }), NOW, 12);
  assert.equal(result.moved, false);
  assert.equal(result.lat, 0);
  assert.equal(result.lon, 0);
  assert.ok(result.confidence > 0, 'still a valid estimate, just a stationary one');
});

test('a drifting vessel below the speed floor is not slid around', () => {
  const result = reckonVessel(underway({ speed: 0.2 }), NOW, 12);
  assert.equal(result.moved, false);
});

test('a vessel with no course cannot be projected forward', () => {
  const result = reckonVessel(underway({ course: null, heading: null }), NOW, 12);
  assert.equal(result.moved, false);
});

test('projections stop at the horizon', () => {
  assert.equal(reckonVessel(underway({ last_position_epoch: NOW - 13 * 3600 }), NOW, 12), null);
});

test('unusable rows yield no projection', () => {
  assert.equal(reckonVessel({ lat: 'x', lon: 0, last_position_epoch: NOW - 60 }, NOW), null);
  assert.equal(reckonVessel(null, NOW), null);
  assert.equal(reckonVessel(underway({ last_position_epoch: NOW + 60 }), NOW), null, 'future fix');
});

test('coverage cells only count recent traffic', () => {
  const rows = [
    { lat: 10, lon: 20, last_position_epoch: NOW - 60 },
    { lat: 50, lon: 60, last_position_epoch: NOW - 99999 },
  ];
  const cells = buildCoverageCells(rows, NOW);
  assert.equal(cells.has(coverageCellKey(10, 20)), true);
  assert.equal(cells.has(coverageCellKey(50, 60)), false, 'stale traffic proves nothing');
});

test('coverage cell keys bin negative coordinates correctly', () => {
  assert.equal(coverageCellKey(-32.9, 151.8, 2), '-17:75');
  assert.equal(coverageCellKey(0, 0, 2), '0:0');
  assert.equal(coverageCellKey('x', 0), null);
});

test('silence inside covered water is classified DARK', () => {
  const cells = buildCoverageCells(
    [{ lat: 10.5, lon: 20.5, last_position_epoch: NOW - 60 }],
    NOW,
  );
  assert.equal(classifyGap(underway({ lat: 10, lon: 20 }), cells), 'DARK');
});

test('silence where nothing else reports is a coverage GAP', () => {
  const cells = buildCoverageCells(
    [{ lat: 10, lon: 20, last_position_epoch: NOW - 60 }],
    NOW,
  );
  assert.equal(classifyGap(underway({ lat: -40, lon: -150 }), cells), 'GAP');
});

test('a stationary vessel is never called dark', () => {
  const cells = buildCoverageCells(
    [{ lat: 10.5, lon: 20.5, last_position_epoch: NOW - 60 }],
    NOW,
  );
  assert.equal(classifyGap(underway({ lat: 10, lon: 20, nav_status: 5 }), cells), '');
  assert.equal(classifyGap(underway({ lat: 10, lon: 20, speed: 0 }), cells), '');
});

test('reckoning honours its environment switches', () => {
  assert.equal(reckoningEnabled({}), true);
  assert.equal(reckoningEnabled({ GEV_RECKON: 'off' }), false);
  assert.equal(reckoningMaxHours({}), RECKONING_DEFAULTS.maxHours);
  assert.equal(reckoningMaxHours({ GEV_RECKON_MAX_HOURS: '6' }), 6);
  assert.equal(reckoningMaxHours({ GEV_RECKON_MAX_HOURS: 'x' }), RECKONING_DEFAULTS.maxHours);
});
