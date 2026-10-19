// src/data/fireballs.test.mjs
// Focused tests for the pure record parser, analyst-record mapper, and the
// real layer lifecycle. Pure functions need no viewer/DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  FIREBALL_OVERLAY_COHORT_LIMIT,
  FIREBALL_OVERLAY_COLLISION_CAPACITY,
  createFireballOverlayEntry,
  createFireballsLayer,
  energyColor,
  formatImpactEnergy,
  mapAnalystRecord,
  normalizeFireballSnapshot,
  selectFireballOverlayCohort,
} from './fireballs.js';

const FIELDS = ['date', 'energy', 'impact-e', 'lat', 'lat-dir', 'lon', 'lon-dir', 'alt', 'vel'];
const ROW = ['2026-09-11 01:12:11', '24.6', '0.67', '54.4', 'N', '100.1', 'W', '38.0', '19.3'];

test('normalizeFireballSnapshot: a well-formed row parses to typed, signed fields', () => {
  const rows = normalizeFireballSnapshot({ fields: FIELDS, data: [ROW] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    stableId: '2026-09-11 01:12:11-54.4N-100.1W',
    timeMs: Date.UTC(2026, 8, 11, 1, 12, 11),
    lat: 54.4,
    lon: -100.1,
    energyE10J: 24.6,
    impactEnergyKt: 0.67,
    altitudeKm: 38.0,
    velocityKmS: 19.3,
  });
});

test('normalizeFireballSnapshot: south/west directions negate the magnitude', () => {
  const row = ['2026-09-15 11:26:13', '2.2', '0.079', '37.6', 'S', '161.6', 'E', '37.0', null];
  const rows = normalizeFireballSnapshot({ fields: FIELDS, data: [row] });
  assert.equal(rows[0].lat, -37.6);
  assert.equal(rows[0].lon, 161.6);
});

test('normalizeFireballSnapshot: null/missing optional numeric fields become null, not NaN', () => {
  const row = ['2026-09-10 05:22:22', '11.1', '0.33', '19.3', 'S', '28.1', 'W', null, null];
  const rows = normalizeFireballSnapshot({ fields: FIELDS, data: [row] });
  assert.equal(rows[0].altitudeKm, null);
  assert.equal(rows[0].velocityKmS, null);
});

test('normalizeFireballSnapshot: rejects the whole snapshot on malformed input', () => {
  assert.equal(normalizeFireballSnapshot(null), null);
  assert.equal(normalizeFireballSnapshot({ fields: FIELDS, data: 'nope' }), null);
  assert.equal(normalizeFireballSnapshot({ fields: ['date'], data: [ROW] }), null); // missing required columns
  assert.equal(normalizeFireballSnapshot({ fields: FIELDS, data: ['not-an-array'] }), null);
  const badDate = ['not-a-date', '1', '1', '1', 'N', '1', 'E', '1', '1'];
  assert.equal(normalizeFireballSnapshot({ fields: FIELDS, data: [badDate] }), null);
  const badLat = ['2026-01-01 00:00:00', '1', '1', '91', 'N', '1', 'E', '1', '1'];
  assert.equal(normalizeFireballSnapshot({ fields: FIELDS, data: [badLat] }), null);
  const badDir = ['2026-01-01 00:00:00', '1', '1', '1', 'X', '1', 'E', '1', '1'];
  assert.equal(normalizeFireballSnapshot({ fields: FIELDS, data: [badDir] }), null);
});

test('normalizeFireballSnapshot: duplicate identity within a snapshot rejects the whole payload', () => {
  const rows = normalizeFireballSnapshot({ fields: FIELDS, data: [ROW, ROW] });
  assert.equal(rows, null);
});

test('energyColor and formatImpactEnergy scale with impact energy', () => {
  assert.equal(energyColor(0.01), Cesium.Color.YELLOW);
  assert.equal(energyColor(0.3), Cesium.Color.ORANGE);
  assert.equal(energyColor(5), Cesium.Color.RED);
  assert.equal(formatImpactEnergy(0.67), '0.67 kt');
  assert.equal(formatImpactEnergy(5.2), '5.2 kt');
  assert.equal(formatImpactEnergy(0.003), '3 t');
  assert.equal(formatImpactEnergy(0), null);
  assert.equal(formatImpactEnergy(null), null);
});

test('fireball analyst record: full record maps every contract field and is JSON-safe', () => {
  const raw = {
    id: 'x-1', impactKt: 0.67, energyE10J: 24.6, altKm: 38, velKmS: 19.3,
    lat: 54.4, lon: -100.1, timeMs: 1_757_552_000_000,
  };
  const r = mapAnalystRecord(raw, 3);
  assert.deepEqual(r, {
    id: 'x-1', impactEnergyKt: 0.67, radiatedEnergyE10J: 24.6,
    altitudeKm: 38, velocityKmS: 19.3, lat: 54.4, lon: -100.1, timeMs: 1_757_552_000_000,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('fireball analyst record: missing id falls back to index-based id; NaN becomes null', () => {
  assert.equal(mapAnalystRecord({ id: null }, 3).id, 'FIREBALL-0003');
  assert.equal(mapAnalystRecord(undefined).id, 'FIREBALL-0000');
  const r = mapAnalystRecord({ id: 'x', impactKt: NaN }, 0);
  assert.equal(r.impactEnergyKt, null);
});

test('fireball overlay entry formats energy and bounds cohort priority', () => {
  const position = Cesium.Cartesian3.fromDegrees(-100.1, 54.4);
  const entry = createFireballOverlayEntry({
    id: 'x-1', position, impactKt: 0.67, accent: '#ff8800',
  });
  assert.equal(entry.title, '☄ 0.67 kt');
  assert.equal(entry.position, position);
  assert.equal(entry.variant, 'label');
  assert.equal(entry.paintLane, 'ambient-label');
  assert.equal(entry.collisionGroup, 'ambient-label');
  assert.equal(entry.horizonCull, true);

  const entries = Array.from({ length: FIREBALL_OVERLAY_COHORT_LIMIT + 20 }, (_, index) => ({
    id: `fb-${String(index).padStart(3, '0')}`,
    priority: index,
  }));
  const cohort = selectFireballOverlayCohort(entries);
  assert.equal(cohort.length, FIREBALL_OVERLAY_COHORT_LIMIT);
  assert.equal(cohort[0].id, `fb-${FIREBALL_OVERLAY_COHORT_LIMIT + 19}`);
});

function makeViewer(dataSources) {
  return {
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };
}

test('real fireball lifecycle publishes host labels and clears on disable/destroy', async () => {
  const originalFetch = globalThis.fetch;
  const hostCalls = [];
  const dataSources = [];
  const overlayHost = {
    setEntries: (...args) => hostCalls.push(['entries', ...args]),
    setVisible: (...args) => hostCalls.push(['visible', ...args]),
    clearSource: (...args) => hostCalls.push(['clear', ...args]),
  };
  const viewer = makeViewer(dataSources);
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      fields: FIELDS,
      data: [
        ROW,
        ['2026-09-15 11:26:13', '2.2', '0.003', '37.6', 'S', '161.6', 'W', '37.0', null],
      ],
    }),
  });
  const layer = createFireballsLayer({ overlayHost });
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer);

    const entities = dataSources[0].entities.values;
    assert.equal(entities.length, 2);
    const publication = hostCalls.find(([type]) => type === 'entries');
    assert.ok(publication, 'real update path must publish the overlay source');
    assert.deepEqual(publication[2].map(({ title }) => title).sort(), ['☄ 0.67 kt', '☄ 3 t']);
    assert.deepEqual(publication[3], {
      cohortLimit: FIREBALL_OVERLAY_COHORT_LIMIT,
      collisionCapacity: FIREBALL_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });

    layer.disable(viewer);
    assert.equal(dataSources[0].show, false);
    assert.deepEqual(hostCalls.slice(-2), [
      ['clear', 'fireballs'],
      ['visible', 'fireballs', false],
    ]);
    layer.destroy(viewer);
    assert.equal(dataSources.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fireball refresh reports failure and clears it only after a successful response', async () => {
  const originalFetch = globalThis.fetch;
  const dataSources = [];
  const viewer = makeViewer(dataSources);
  const layer = createFireballsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    assert.equal(await layer.update(viewer), false);
    assert.equal(layer.getStats().error, 'Fireball proxy HTTP 503');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ fields: FIELDS, data: [] }),
    });
    assert.equal(await layer.update(viewer), true);
    assert.equal(layer.getStats().error, null);
    assert.ok(Number.isFinite(layer.getStats().lastUpdate));
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('malformed fireball refresh preserves prior entities, overlays, count and timestamp', async () => {
  const originalFetch = globalThis.fetch;
  const dataSources = [];
  const publications = [];
  const viewer = makeViewer(dataSources);
  const layer = createFireballsLayer({
    overlayHost: { setEntries(...args) { publications.push(args); }, setVisible() {}, clearSource() {} },
  });
  const respond = (payload) => { globalThis.fetch = async () => ({ ok: true, json: async () => payload }); };
  try {
    layer.init(viewer);
    layer.enable(viewer);
    respond({ fields: FIELDS, data: [ROW] });
    assert.equal(await layer.update(viewer), true);
    const entity = dataSources[0].entities.values[0];
    const stats = layer.getStats();

    for (const bad of [
      { fields: FIELDS, data: 'nope' },
      { fields: ['date'], data: [ROW] },
      null,
    ]) {
      respond(bad);
      assert.equal(await layer.update(viewer), false);
      assert.equal(dataSources[0].entities.values.length, 1);
      assert.equal(dataSources[0].entities.values[0], entity);
      assert.equal(layer.getStats().count, stats.count);
      assert.equal(layer.getStats().lastUpdate, stats.lastUpdate);
      assert.equal(layer.getStats().error, 'Malformed fireball response');
      assert.equal(publications.length, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});
