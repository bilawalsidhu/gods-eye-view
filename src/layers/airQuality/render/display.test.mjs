// The air-quality stations on the engine contract, on the fake engine and
// on the Cesium engine (its ground batches over fake primitives): a 6 km
// disc per reading in its band colour at 0.35, no outline, picks, the view
// rectangle the readout reads, visibility through the layer and teardown.

import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import {
  GROUND_HARNESSES,
  createFakeGroundHarness,
  instanceColor,
} from '../../../testSupport/groundDisplayEngines.mjs';
import { rgbaFromCss } from '../../shared/color.js';
import { createAirQualityLayer } from '../index.js';
import { createAirQualityDisplay } from './display.js';

const reading = (id, value, lon, lat, color) => ({
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
  observedMs: Date.now() - 10 * 60_000,
  color,
  label: String(value),
  risk: 'Low health risk',
  note: null,
});
const readings = [
  reading('Toronto', 2, -79.38, 43.65, '#4cc9f0'),
  reading('Hamilton', 8, -79.87, 43.26, '#ff6b35'),
];
const RADIUS_M = 6_000;

function fixture(makeHarness) {
  const h = makeHarness();
  const entries = [];
  const layer = createAirQualityLayer({
    source: { getSnapshot: async () => readings },
    overlayHost: {
      setEntries: (...args) => entries.push(args),
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(null, { engine: h.engine });
  layer.enable();
  return { ...h, layer, entries };
}

const near = (actual, expected, label, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );

test('the display needs a globe engine', () => {
  assert.throws(() => createAirQualityDisplay(null), TypeError);
});

for (const makeHarness of GROUND_HARNESSES) {
  const { name } = makeHarness();

  test(`each reading is a 6 km ground disc in its band colour at 0.35, without an outline (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      assert.equal(await f.layer.update(), true);
      const set = f.set('air-quality');
      assert.equal(set.options.kind, 'disc');
      assert.equal(set.options.pickable, true);
      assert.equal(set.shown, true);
      assert.deepEqual(
        set.items.map(({ center, radiusM, pickId, outline }) => ({
          center,
          radiusM,
          pickId,
          outline,
        })),
        readings.map((row) => ({
          center: [row.lon, row.lat],
          radiusM: RADIUS_M,
          pickId: `air-quality:${row.id}`,
          outline: undefined,
        })),
      );
      set.items.forEach(({ fill }, index) => {
        const expected = rgbaFromCss(readings[index].color)
          .withAlpha(0.35)
          .rgba();
        fill.forEach((channel, at) =>
          near(channel, expected[at], `fill ${index}.${at}`),
        );
      });
      assert.equal(f.entries.at(-1)[0], 'air-quality', 'labels published');
      if (f.cesium) {
        const { fills, lines } = f.primitives('air-quality');
        assert.equal(fills.length, 1, 'one ground batch');
        assert.equal(lines.length, 0, 'no outline batch');
        assert.equal(
          fills[0].options.classificationType,
          Cesium.ClassificationType.BOTH,
        );
        fills[0].options.geometryInstances.forEach((instance, index) => {
          assert.ok(instance.geometry instanceof Cesium.EllipseGeometry);
          assert.equal(instance.geometry._semiMajorAxis, RADIUS_M);
          const expected = rgbaFromCss(readings[index].color)
            .withAlpha(0.35)
            .rgba();
          instanceColor(instance).forEach((channel, at) =>
            near(channel, expected[at], `colour ${index}.${at}`, 0.5 / 255),
          );
        });
      }
      f.layer.disable();
      assert.equal(f.set('air-quality').shown, false);
      if (f.cesium) assert.equal(f.collectionShown('air-quality'), false);
      f.layer.enable();
      assert.equal(f.set('air-quality').shown, true);
    } finally {
      f.layer.destroy();
    }
    assert.equal(f.sets(), 0);
    f.destroy();
  });

  test(`the readout lists the readings in the camera's view (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      f.engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(-79.38, 43.65, 30_000),
      });
      await f.layer.update();
      assert.deepEqual(
        f.layer.getRowControls().list.items.map((item) => item.text),
        ['Toronto · Low health risk'],
        'Hamilton is out of a 30 km high view over Toronto',
      );
    } finally {
      f.layer.destroy();
      f.destroy();
    }
  });
}

test('a pick of a station names its reading (the fake engine)', async () => {
  const f = fixture(createFakeGroundHarness);
  try {
    await f.layer.update();
    f.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(-79.87, 43.26, 50_000),
    });
    const { width, height } = f.engine.host.size();
    const picked = f.engine.picker.pick({ x: width / 2, y: height / 2 });
    assert.equal(picked.id, 'air-quality:eccc:Hamilton');
    assert.equal(picked.owner, 'air-quality');
  } finally {
    f.layer.destroy();
    f.destroy();
  }
});

test('the display ignores calls after destroy and destroys once', () => {
  const h = createFakeGroundHarness();
  const display = createAirQualityDisplay(h.engine);
  assert.equal(h.set('air-quality').shown, false, 'hidden until shown');
  display.destroy();
  display.destroy();
  assert.equal(h.sets(), 0);
  display.setVisible(true);
  display.replace(readings, RADIUS_M);
  assert.equal(display.viewRectangle(), undefined);
  h.destroy();
});
