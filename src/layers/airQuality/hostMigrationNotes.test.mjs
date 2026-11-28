import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createAirQualityLayer } from './index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

function harness(rows) {
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  bindFakeDraw(viewer, {
    camera: {
      on: () => () => {},
      viewRectangle: () => ({ west: 10, south: -40, east: 35, north: -20 }),
    },
    query: {
      pickEllipsoid: (x, y) =>
        fromDegrees(18.42 + (x - 400) * 0.001, -33.92 + (300 - y) * 0.001),
      isOccluded: () => false,
    },
  });
  const layer = createAirQualityLayer({
    source: {
      async getSnapshot() {
        return rows;
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  layer.enable();
  return layer;
}
const base = {
  id: 'h:1',
  provider: 'host',
  stationId: '1',
  name: 'Cape Town',
  zone: 'WC',
  lat: -33.92,
  lon: 18.42,
  observedMs: Date.now() - 600000,
  color: '#00ff00',
};

test('while rows of the previous host contract draw nothing, CURRENT-STATE does not call such hosts unaffected', async () => {
  // A host provider written to the previous contract: index-valued rows (scale, value, band).
  const legacy = harness([
    { ...base, scale: 'AQHI', value: 3, band: 'low', label: '3', risk: 'Low' },
  ]);
  await legacy.update();
  await new Promise((r) => setImmediate(r));
  if (legacy.getStats().count !== 0) return;
  assert.doesNotMatch(
    readFileSync(
      new URL('../../../docs/CURRENT-STATE.md', import.meta.url),
      'utf8',
    ).replace(/\s+/g, ' '),
    /hosts with their own providers are unaffected/,
    'CURRENT-STATE repeats the claim',
  );
});
