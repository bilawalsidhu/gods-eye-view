// src/data/firmsHeatmap.test.mjs
// Focused tests for the pure analyst-record mapper (analyst query engine seam).
// Pure function — no viewer/DOM needed; imported directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAnalystRecord } from './firmsHeatmap.js';
import { fireDetectionKey } from './firmsLabels.js';
import { createQueries } from '../layers/firms/queries.js';
import { describeEntity, findRecord, nearbyForLayer, viewSummaryForLayer } from './entityContext.js';

const FULL_FIRE = {
  index: 7,
  lat: 30.51,
  lon: -98.21,
  frp: 1520.4,
  confidence: 0.9,
  satellite: 'N21',
  sensor: 'VIIRS',
  acqMs: 1_753_600_000_000,
};

test('firms analyst record: full record maps every contract field', () => {
  const r = mapAnalystRecord(FULL_FIRE);
  assert.deepEqual(r, {
    id: 'FIRE-00007',
    lat: 30.51,
    lon: -98.21,
    frp: 1520.4,
    confidence: 0.9,
    satellite: 'N21',
    sensor: 'VIIRS',
    acqTime: 1_753_600_000_000,
  });
});

test('firms analyst record: id matches the layer pick-id convention (5-digit pad)', () => {
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, index: 0 }).id, 'FIRE-00000');
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, index: 12345 }).id, 'FIRE-12345');
});

test('firms analyst record: blank satellite falls back to sensor, then null', () => {
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, satellite: '' }).satellite, 'VIIRS');
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, satellite: '', sensor: '' }).satellite, null);
});

test('firms analyst record: unparseable acq time (0 sentinel) becomes null', () => {
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, acqMs: 0 }).acqTime, null);
});

test('firms analyst record: empty record yields nulls, never NaN/undefined', () => {
  const r = mapAnalystRecord(undefined);
  assert.equal(r.id, 'FIRE-00000');
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('firms analyst record: output is JSON-safe (no Cesium types leak)', () => {
  const r = mapAnalystRecord({ ...FULL_FIRE, contextEntity: {}, position: { x: 1 } });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.equal('position' in r, false);
});

test('Nearby and in-view lists find a weak FIRMS detection below the analyst cutoff and preserve its identity', () => {
  const far = { ...FULL_FIRE, lat: 60, lon: 40, frp: 1000 };
  const near = { ...FULL_FIRE, index: 100001, lat: 0, lon: -179.99, frp: 1 };
  const layerState = { _enabled: true, _firesByFrp: [...Array(100000).fill(far), near] };
  const module = createQueries({ layerState, components: { model: { mapAnalystRecord } }, config: {} }).methods;
  const layer = { id: 'local-firms', name: 'Active fires', enabled: true, module };
  const manager = { getAll: () => [layer], layers: new Map([[layer.id, layer]]) };
  const list = nearbyForLayer(manager, layer, { lat: 0, lon: 179.99 }, { radiusKm: 5 });
  assert.equal(list.count, 1);
  const ask = (options) => nearbyForLayer(manager, layer, { lat: 0, lon: 179.99 }, { radiusKm: 5, ...options });
  assert.equal(ask({ query: 'FIRE-100001' }).count, 1);
  assert.equal(ask({ excludeKey: list.items[0].key }).count, 0);
  const card = describeEntity(manager, list.items[0].identity);
  assert.equal(card.identity.id, fireDetectionKey(near));
  assert.equal(list.items[0].title, 'FIRE-100001');
  assert.equal(module.getAnalystRecords(1)[0].id, 'FIRE-00007');

  const center = { lat: 0, lon: 179.99 };
  const viewport = { west: 179, east: -179, south: -1, north: 1 };
  for (const [rect, options] of [[viewport, {}], [null, { hemisphere: true }]]) {
    for (const query of ['', 'FIRE-100001']) {
      const group = viewSummaryForLayer(manager, layer, rect, center, { ...options, query });
      assert.equal(group?.count, 1);
      assert.equal(group.items[0].title, 'FIRE-100001');
      assert.equal(group.items[0].key, list.items[0].key);
    }
    assert.equal(viewSummaryForLayer(manager, layer, rect, center, { ...options, query: 'FIRE-00007' }), null);
  }
  const world = viewSummaryForLayer(manager, layer, { west: -180, east: 180, south: -90, north: 90 }, center, { perLayer: 1 });
  assert.equal(world.count, 100001);
  assert.equal(world.items[0].key, list.items[0].key);

  const refreshed = { ...near, index: 5, frp: 3 };
  const later = { ...near, acqMs: near.acqMs + 60000 };
  layerState._firesByFrp = [later, refreshed];
  assert.equal(findRecord(manager, card.identity).frp, 3);
  assert.equal(describeEntity(manager, card.identity).key, card.key);
  layerState._firesByFrp = [later];
  assert.equal(findRecord(manager, card.identity), null);
});

test('FIRMS Nearby, search and sprite cards keep one detection identity after feed reorder', () => {
  const first = FULL_FIRE;
  const other = { ...FULL_FIRE, index: 8, lat: 31, frp: 5 };
  const layerState = {
    _enabled: true,
    _firesByFrp: [first, other],
    _pickIndexById: new Map([['firms-7', first]]),
  };
  const module = createQueries({ layerState, components: { model: { mapAnalystRecord } }, config: {} }).methods;
  const layer = { id: 'local-firms', name: 'Active fires', enabled: true, module };
  const manager = { getAll: () => [layer], layers: new Map([[layer.id, layer]]) };
  const nearby = nearbyForLayer(manager, layer, first, { radiusKm: 10 }).items[0].identity;
  const search = { layerId: layer.id, id: 'FIRE-00007', record: module.getAnalystRecords(1)[0] };
  const sprite = { layerId: layer.id, id: 'firms-7' };
  const cards = [nearby, search, sprite].map((identity) => describeEntity(manager, identity));
  assert.deepEqual(cards.map((card) => card.identity.id), Array(3).fill(fireDetectionKey(first)));

  layerState._firesByFrp = [{ ...other, index: 7 }, { ...first, index: 8 }];
  for (const card of cards) {
    assert.equal(findRecord(manager, card.identity).lat, first.lat);
    assert.equal(describeEntity(manager, card.identity).key, card.key);
  }
  layerState._firesByFrp = layerState._firesByFrp.slice(0, 1);
  assert.equal(findRecord(manager, cards[1].identity), null);
});
