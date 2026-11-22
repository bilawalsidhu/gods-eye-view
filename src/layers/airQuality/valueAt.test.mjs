import assert from 'node:assert/strict';
import test from 'node:test';
import { AIR_QUALITY_VALUE_RADIUS_KM, createAirQualityLayer } from './index.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const reading = (id, value, lat, lon, overrides = {}) => ({
  id: `eccc:${id}`,
  provider: 'eccc',
  scale: 'AQHI',
  value,
  band: 'low',
  stationId: id,
  name: id,
  zone: 'ont',
  lat,
  lon,
  observedMs: 1_700_000_000_000,
  color: '#4cc9f0',
  label: String(value),
  risk: 'Low health risk',
  note: null,
  ...overrides,
});

// Quantities keep number and unit together with a no-break space.
const plain = (text) => text.replace(/\s/gu, ' ');

function layerWith(rows) {
  const viewer = {};
  bindFakeDraw(viewer);
  const layer = createAirQualityLayer({
    source: { getSnapshot: async () => rows },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  return layer;
}

test('getValueAt reads the nearest station within the radius', async () => {
  const layer = layerWith([
    reading('Toronto', 3, 43.65, -79.38),
    reading('Hamilton', 7, 43.25, -79.87, {
      band: 'high',
      label: '7',
    }),
  ]);
  assert.equal(layer.getValueAt(43.66, -79.4), null, 'off');
  layer.enable();
  assert.equal(layer.getValueAt(43.66, -79.4), null, 'nothing loaded');
  assert.equal(await layer.update(), true);
  const toronto = layer.getValueAt(43.66, -79.4);
  assert.equal(toronto.value, 'AQHI 3 · Low');
  assert.equal(plain(toronto.detail), 'Toronto · 2 km');
  assert.equal(toronto.at, 1_700_000_000_000);
  const hamilton = layer.getValueAt(43.26, -79.86);
  assert.equal(hamilton.value, 'AQHI 7 · High');
  assert.equal(AIR_QUALITY_VALUE_RADIUS_KM, 50);
  // Distance alone cannot tell whether the view is in Canada.
  assert.deepEqual(
    layer.getValueAt(30.27, -97.74),
    { value: null, reason: 'No station within 50 km' },
    'Austin',
  );
  assert.deepEqual(
    layer.getValueAt(60.72, -135.05),
    { value: null, reason: 'No station within 50 km' },
    'Whitehorse with only Ontario stations in this snapshot',
  );
  // Inside the network but no station within the radius.
  assert.deepEqual(layer.getValueAt(44.6, -79.4), {
    value: null,
    reason: 'No station within 50 km',
  });
  assert.equal(layer.getValueAt(Number.NaN, -79.4), null);
  layer.disable();
  assert.equal(layer.getValueAt(43.66, -79.4), null);
  layer.destroy();
});

test('getValueAt shows the value alone when a band is unknown', async () => {
  const layer = layerWith([
    reading('Ottawa', 11, 45.42, -75.69, { band: null, label: '10+' }),
  ]);
  layer.enable();
  await layer.update();
  assert.equal(layer.getValueAt(45.42, -75.69).value, 'AQHI 10+');
  layer.destroy();
});
