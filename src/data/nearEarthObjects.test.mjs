// src/data/nearEarthObjects.test.mjs
// Focused tests for the NeoWs layer's pure helpers and the fetch lifecycle
// (keyless → KEY REQUIRED, live rows → entities + overlay cohort, malformed
// feed → error, stale flag passthrough).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEO_OVERLAY_COHORT_LIMIT,
  NEO_OVERLAY_COLLISION_CAPACITY,
  createNearEarthObjectsLayer,
  createNeoOverlayEntry,
  mapNeoAnalystRecord,
  neoLabel,
  selectNeoOverlayCohort,
} from './nearEarthObjects.js';

const ROW = {
  id: '2427881',
  name: '162173 Ryugu (1999 JU3)',
  sizeM: 450,
  missKm: 1_234_567,
  missLunar: 3.21,
  velocityKph: 45_000,
  approachMs: 1_757_600_000_000,
  hazardous: true,
  absMag: 19.2,
};

function rows(...variants) {
  return variants.map((v, i) => ({ ...ROW, id: `neo-${i}`, ...v }));
}

test('neoLabel: name, lunar distances, hazardous marker', () => {
  assert.equal(neoLabel(ROW), '162173 Ryugu (1999 JU3) · 3.2 LD ☢');
  assert.equal(neoLabel({ ...ROW, hazardous: false, missLunar: 0.5 }), '162173 Ryugu (1999 JU3) · 0.5 LD');
  const bare = neoLabel({});
  assert.ok(bare.startsWith('Asteroid'), `fallback name missing: ${bare}`);
  assert.ok(bare.includes('— LD'), `missing distance placeholder: ${bare}`);
});

test('createNeoOverlayEntry: id/title/accent/priority wired from the row', () => {
  const entry = createNeoOverlayEntry({ row: ROW, position: { x: 1, y: 2, z: 3 } });
  assert.equal(entry.id, '2427881');
  assert.equal(entry.title, '162173 Ryugu (1999 JU3) · 3.2 LD ☢');
  assert.equal(entry.accent, '#ffb347'); // hazardous reads amber
  assert.equal(entry.interactive, false);
  assert.equal(entry.priority, 0); // 3.21 LD is far — lowest ambient priority
  const near = createNeoOverlayEntry({ row: { ...ROW, missLunar: 0.3 }, position: {} });
  assert.equal(near.priority, 1700); // 2 - 0.3 lunar distances
  const far = createNeoOverlayEntry({
    row: { ...ROW, hazardous: false, missLunar: 12 },
    position: {},
  });
  assert.equal(far.accent, '#7ec8ff');
  assert.equal(far.priority, 0); // far + non-hazardous → lowest ambient priority
});

test('selectNeoOverlayCohort: closest (highest priority) wins, stable ids, capped', () => {
  const mk = (id, missLunar) => createNeoOverlayEntry({
    row: { ...ROW, id, missLunar },
    position: {},
  });
  const cohort = selectNeoOverlayCohort([mk('a', 9), mk('b', 0.5), mk('c', 1.2)]);
  assert.deepEqual(cohort.map((e) => e.id), ['b', 'c', 'a']);
  // Equal-clamp ties (beyond 2 LD everything reads priority 0) break by id.
  const clamped = selectNeoOverlayCohort([mk('z', 9), mk('a', 5)]);
  assert.deepEqual(clamped.map((e) => e.id), ['a', 'z']);
  // Ties break by stable id.
  const tied = selectNeoOverlayCohort([mk('z', 1), mk('a', 1)]);
  assert.deepEqual(tied.map((e) => e.id), ['a', 'z']);
  // Cap honored.
  const many = Array.from({ length: NEO_OVERLAY_COHORT_LIMIT + 10 }, (_, i) => mk(`id-${i}`, 1));
  assert.equal(selectNeoOverlayCohort(many).length, NEO_OVERLAY_COHORT_LIMIT);
  assert.deepEqual(selectNeoOverlayCohort([], 5), []);
});

test('mapNeoAnalystRecord: JSON-safe, nulls for missing numeric fields', () => {
  const record = mapNeoAnalystRecord(ROW);
  assert.equal(record.id, '2427881');
  assert.equal(record.name, '162173 Ryugu (1999 JU3)');
  assert.equal(record.sizeM, 450);
  assert.equal(record.missKm, 1_234_567);
  assert.equal(record.missLunar, 3.21);
  assert.equal(record.velocityKph, 45_000);
  assert.equal(record.approachMs, 1_757_600_000_000);
  assert.equal(record.hazardous, true);
  assert.equal(record.absMag, 19.2);
  assert.equal(record.lat, null); // ring placement is display-only, never query-scoped
  const bare = mapNeoAnalystRecord({}, 3);
  assert.equal(bare.id, 'NEO-0003');
  assert.equal(bare.name, null);
  assert.equal(bare.hazardous, false);
});

/** Layer lifecycle harness: fake viewer + fetch + overlay host. */
function harness({ status = 200, body = '{}' } = {}) {
  const calls = { entries: [], visible: [] };
  const overlayHost = {
    setEntries: (id, entries) => calls.entries.push({ id, entries }),
    setVisible: (id, v) => calls.visible.push({ id, v }),
    clearSource: (id) => calls.entries.push({ id, cleared: true }),
  };
  const viewer = { dataSources: { add() {}, remove() {}, get length() { return 0; } } };
  const layer = createNearEarthObjectsLayer({ overlayHost });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: status < 400, status, json: async () => body });
  return { layer, calls, viewer, restore() { globalThis.fetch = originalFetch; } };
}

test('layer lifecycle: live rows become entities + overlay cohort, analyst records exposed', async () => {
  const fetchedAt = Date.now();
  const rowsIn = rows({ missLunar: 0.4, hazardous: true }, { id: 'far', missLunar: 20, hazardous: false });
  const h = harness({ body: { fetchedAt, stale: false, rows: rowsIn } });
  try {
    h.layer.init(h.viewer);
    h.layer.enable(h.viewer);
    assert.equal(await h.layer.update(h.viewer), true);
    const stats = h.layer.getStats();
    assert.equal(stats.count, 2);
    assert.equal(stats.hazardous, 1);
    assert.equal(stats.error, null);
    assert.equal(stats.stale, false);
    // Overlay cohort published while enabled.
    const published = h.calls.entries.at(-1);
    assert.equal(published.id, 'near-earth-objects');
    assert.equal(published.entries.length, 2);
    // Cohort order: hazardous close approach first.
    assert.equal(published.entries[0].id, 'neo-0');
    // Analyst seam mirrors the loaded rows.
    const records = h.layer.getAnalystRecords();
    assert.equal(records.length, 2);
    assert.equal(records[0].hazardous, true);
    assert.equal(records[1].id, 'far');
  } finally {
    h.restore();
  }
});

test('layer lifecycle: keyless 503 no_key → KEY REQUIRED, not a silent empty layer', async () => {
  const h = harness({ status: 503, body: { error: 'no_key' } });
  try {
    h.layer.init(h.viewer);
    h.layer.enable(h.viewer);
    assert.equal(await h.layer.update(h.viewer), false);
    const stats = h.layer.getStats();
    assert.equal(stats.error, 'KEY REQUIRED');
    assert.equal(stats.loadingLabel, 'KEY REQUIRED');
    assert.equal(stats.count, 0);
  } finally {
    h.restore();
  }
});

test('layer lifecycle: malformed payload keeps the error honest; stale flag surfaces', async () => {
  const bad = harness({ body: { fetchedAt: 1, rows: 'not-an-array' } });
  try {
    bad.layer.init(bad.viewer);
    bad.layer.enable(bad.viewer);
    assert.equal(await bad.layer.update(bad.viewer), false);
    assert.equal(bad.layer.getStats().error, 'Malformed NeoWs response');
  } finally {
    bad.restore();
  }
  const stale = harness({ body: { fetchedAt: 1, stale: true, rows: rows() } });
  try {
    stale.layer.init(stale.viewer);
    stale.layer.enable(stale.viewer);
    await stale.layer.update(stale.viewer);
    const stats = stale.layer.getStats();
    assert.equal(stats.stale, true);
    assert.ok(stats.error.includes('STALE'), `expected stale chip, got ${stats.error}`);
  } finally {
    stale.restore();
  }
});

test('layer lifecycle: HTTP failure surfaces a bounded error, never raw upstream text', async () => {
  const h = harness({ status: 502, body: { error: 'NeoWs feed unavailable' } });
  try {
    h.layer.init(h.viewer);
    h.layer.enable(h.viewer);
    assert.equal(await h.layer.update(h.viewer), false);
    assert.equal(h.layer.getStats().error, 'NeoWs HTTP 502');
  } finally {
    h.restore();
  }
});

test('layer lifecycle: analyst records and overlay are empty while disabled', async () => {
  const h = harness({ body: { fetchedAt: Date.now(), rows: rows() } });
  try {
    h.layer.init(h.viewer);
    // enabled=false → getAnalystRecords returns [] even after a manual update.
    assert.deepEqual(h.layer.getAnalystRecords(), []);
  } finally {
    h.restore();
  }
});
