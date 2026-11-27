import { onAqiPeriods } from '../../testSupport/airQualityViewer.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './index.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

test('pending first read near a border station does not claim absence', async () => {
  const viewer = {};
  bindFakeDraw(viewer);
  let resolve;
  const layer = createAirQualityLayer({
    source: {
      definitions: [
        {
          id: 'regional',
          title: 'Regional',
          network: 'Regional',
          parameters: ['PM2.5'],
        },
      ],
      getSnapshot: () =>
        new Promise((r) => {
          resolve = r;
        }),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  layer.enable();
  const pending = layer.update();
  const dearborn = [42.322, -83.176];
  const found = layer.getValueAt(...dearborn);
  await new Promise(setImmediate);
  resolve(
    onAqiPeriods([
      {
        id: 'regional:Windsor',
        provider: 'regional',
        parameter: 'PM2.5',
        units: 'µg/m³',
        kind: 'observation',
        averagingMinutes: 60,
        value: 2,

        stationId: 'W',
        name: 'Windsor',
        zone: 'o',
        lat: 42.3,
        lon: -83.03,
        observedMs: Date.now(),
      },
    ]),
  );
  await pending;
  assert.equal(found, null);
  assert.equal(layer.getValueAt(...dearborn).value, 'US AQI 11 · Good');
  layer.destroy();
});
