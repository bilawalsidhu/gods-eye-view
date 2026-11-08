import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVolcanoes, normalizeAurora, createPublicFeedSource } from './source.js';
import { auroraRectangles, createPublicFeedLayer } from './index.js';

const volcano = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-155.6, 19.4] }, properties: { vnum: 332010, volcanoName: 'Kīlauea', alertLevel: 'WATCH', colorCode: 'ORANGE', region: 'Hawaii', alertDate: '2026-01-01' } }] };
const aurora = { 'Observation Time': '2026-01-01T00:00:00Z', 'Forecast Time': '2026-01-01T00:30:00Z', 'Data Format': '[Longitude, Latitude, Aurora]', coordinates: [[0, 90, 100], [180, -90, 5], [359, 0, 0]] };

test('USGS geometry, identity and status survive normalization', () => {
  assert.deepEqual(normalizeVolcanoes(volcano)[0], { id: '332010', lon: -155.6, lat: 19.4, name: 'Kīlauea', alert: 'WATCH', color: 'ORANGE', region: 'Hawaii', date: '2026-01-01' });
  assert.throws(() => normalizeVolcanoes({ ...volcano, features: [volcano.features[0], volcano.features[0]] }), /Malformed/);
  assert.throws(() => normalizeVolcanoes({ type: 'FeatureCollection', features: [{ ...volcano.features[0], geometry: { type: 'Point', coordinates: [181, 0] } }] }), /Malformed/);
  const withoutNumber = { ...volcano.features[0], properties: { ...volcano.features[0].properties, vnum: null, volcanoCd: 'nmi2' } };
  assert.equal(normalizeVolcanoes({ type: 'FeatureCollection', features: [withoutNumber] })[0].id, 'nmi2');
});

test('OVATION wraps longitude, clips poles and splits antimeridian', () => {
  const result = normalizeAurora(aurora);
  assert.equal(result.forecastTime, aurora['Forecast Time']);
  assert.equal(result.rows[1].lon, -180);
  assert.deepEqual(auroraRectangles(result.rows[1]), [
    { west: 179.5, east: 180, south: -90, north: -89.5, probability: 5 },
    { west: -180, east: -179.5, south: -90, north: -89.5, probability: 5 },
  ]);
  assert.equal(auroraRectangles(result.rows[0])[0].north, 90);
  assert.deepEqual(auroraRectangles(result.rows[2]), []);
  assert.throws(() => normalizeAurora({ ...aurora, coordinates: [[360, 0, 10]] }), /Malformed/);
  assert.throws(() => normalizeAurora({ ...aurora, coordinates: [[0, 0, 101]] }), /Malformed/);
  assert.throws(() => normalizeAurora({ ...aurora, coordinates: [[0, 0, 1], [0, 0, 2]] }), /Malformed/);
});

test('sources surface HTTP and malformed responses', async () => {
  const failed = createPublicFeedSource('aurora', { fetchImpl: async () => ({ ok: false, status: 502 }) });
  await assert.rejects(failed.getSnapshot(), /502/);
  const invalid = createPublicFeedSource('volcanoes', { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await assert.rejects(invalid.getSnapshot(), /Malformed/);
});

test('layer preserves rendered volcanoes on errors and hides on disable', async () => {
  let fail = false, ds;
  const viewer = { dataSources: { add: (value) => { ds = value; }, remove: () => {} }, scene: { groundPrimitives: { add() {}, remove() {} }, requestRender() {} } };
  const layer = createPublicFeedLayer('volcanoes', { source: { getSnapshot: async () => { if (fail) throw new Error('offline'); return normalizeVolcanoes(volcano); } } });
  layer.init(viewer); layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  assert.equal(ds.entities.values.length, 1);
  assert.equal(ds.entities.values[0].name, 'Kīlauea');
  fail = true;
  assert.equal(await layer.update(viewer), false);
  assert.equal(ds.entities.values.length, 1);
  assert.equal(layer.getStats().error, 'offline');
  layer.disable(viewer); assert.equal(ds.show, false);
  layer.destroy(viewer);
});

test('aurora renders forecast time and replaces and hides its grid', async () => {
  let ds, added = 0, removed = 0, fail = false;
  const entries = new Map(), visibility = new Map(), cleared = [];
  const overlayHost = {
    setEntries(id, value) { entries.set(id, value); },
    setVisible(id, value) { visibility.set(id, value); },
    clearSource(id) { cleared.push(id); entries.delete(id); },
  };
  const viewer = {
    dataSources: { add: (value) => { ds = value; }, remove() {} },
    scene: { groundPrimitives: { add() { added++; }, remove() { removed++; } }, requestRender() {} },
  };
  const layer = createPublicFeedLayer('aurora', { source: { getSnapshot: async () => { if (fail) throw new Error('offline'); return normalizeAurora(aurora); } }, overlayHost });
  layer.init(viewer); layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  assert.equal(added, 1);
  assert.equal(ds.entities.values.length, 0);
  assert.equal(entries.get('aurora-forecast')[0].title, 'NOAA OVATION forecast: 2026-01-01T00:30:00Z');
  assert.deepEqual(entries.get('aurora-forecast')[0].details, ['Brighter green = higher probability']);
  assert.equal(visibility.get('aurora-forecast'), true);
  assert.equal(layer.getStats().forecastTime, aurora['Forecast Time']);
  assert.equal(await layer.update(viewer), true);
  assert.equal(removed, 1);
  const previousEntries = entries.get('aurora-forecast');
  fail = true;
  assert.equal(await layer.update(viewer), false);
  assert.equal(entries.get('aurora-forecast'), previousEntries);
  assert.equal(layer.getStats().forecastTime, aurora['Forecast Time']);
  layer.disable(viewer); assert.equal(ds.show, false);
  assert.equal(visibility.get('aurora-forecast'), false);
  layer.enable(viewer);
  assert.equal(visibility.get('aurora-forecast'), true);
  layer.destroy(viewer); assert.equal(removed, 2);
  assert.equal(visibility.get('aurora-forecast'), false);
  assert.deepEqual(cleared, ['aurora-forecast']);
});
