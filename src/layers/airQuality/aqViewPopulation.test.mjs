import { onAqiPeriods } from '../../testSupport/airQualityViewer.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './index.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const reading = (id, value, lat, lon) => ({
  id: `regional:${id}`,
  provider: 'regional',
  parameter: 'PM2.5',
  units: 'µg/m³',
  kind: 'observation',
  averagingMinutes: 60,
  value,

  stationId: id,
  name: id,
  zone: 'ont',
  lat,
  lon,
  observedMs: Date.now(),
});

test('Context summary counts the same visible stations as its rows', async () => {
  const viewer = {};
  bindFakeDraw(viewer, {
    camera: {
      on: () => () => {},
      viewRectangle: () => ({ west: -80, south: 43.5, east: -79, north: 44 }),
    },
  });
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
      getSnapshot: async () =>
        onAqiPeriods([
          reading('Toronto', 3, 43.65, -79.38),
          reading('Vancouver', 60, 49.28, -123.12),
        ]),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const population = layer.getContextPopulation();
  const summary = layer.getContextSummary({
    population: population.filter((row) => row.name === 'Toronto'),
  });
  assert.deepEqual(
    summary.items.map((i) => i.record.name),
    ['Toronto'],
    'rows are in view',
  );
  const bands = Object.fromEntries(summary.bands.map((b) => [b.id, b.count]));
  assert.equal(
    summary.caption,
    'Stations rated: 1 of 1',
    'caption counts visible stations',
  );
  assert.deepEqual(
    bands,
    Object.fromEntries(
      summary.bands.map((b) => [b.id, b.id === 'good' ? 1 : 0]),
    ),
    'bar counts visible stations',
  );
  assert.equal(summary.bands.length, 6);
  assert.equal(layer.describeReading(summary.items[0].record).band.id, 'good');
  const source = layer.getInspectorContextPoints();
  assert.equal(source.points, population);
  const station = population.find((row) => row.name === 'Toronto');
  assert.equal(source.recordForPoint(station, false), station);
  assert.deepEqual(source.recordForPoint(station), summary.items[0].record);
  const globe = layer.getContextSummary({ population: new Set(population) });
  assert.equal(globe.caption, 'Stations rated: 2 of 2');
  assert.deepEqual(
    globe.items.map((row) => row.record.name),
    ['Vancouver', 'Toronto'],
  );
  assert.equal(globe.bands.find((band) => band.id === 'good').count, 1);
  assert.equal(globe.bands.find((band) => band.id === 'unhealthy').count, 1);
  assert.deepEqual(layer.getContextSummary({ population: [] }).items, []);
  layer.destroy();
});
