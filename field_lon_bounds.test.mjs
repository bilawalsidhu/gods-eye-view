// A regional grid given in 0–360° longitudes or
// crossing the antimeridian must be drawn with renderer-valid bounds.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  FIELD_IDS,
  paintField,
  readFieldManifest,
  sampleField,
} from './src/layers/airQuality/field.js';
import {
  EEA_HOURLY_BANDS,
  EEA_HOURLY_LIMITS,
} from './src/layers/airQuality/interpretation.js';

for (const lon0 of [235, 179]) {
  test(`regional grid from ${lon0} E has valid drawing bounds`, () => {
    const global = {
      width: 3,
      height: 3,
      lon0,
      lat0: 1,
      step: 1,
      wrap: false,
      steps: [0],
    };
    const manifest = readFieldManifest({
      run: '2026-11-20T00:00:00Z',
      scale: { pm25: 1, pm10: 1, o3: 1, no2: 1, so2: 1, co: 1, aqi: 1 },
      global,
    });
    const grids = {
      global: Object.fromEntries(
        FIELD_IDS.map((id) => [
          id,
          Uint16Array.from({ length: 9 }, (_, i) => 10 + (i % 3) * 10),
        ]),
      ),
    };
    // The card reads the last column at its western-hemisphere longitude.
    assert.equal(sampleField(manifest, grids, 'pm25', lon0 + 2 - 360, 0), 30);
    const [image] = paintField(manifest, grids, 'pm25', {
      bands: EEA_HOURLY_BANDS,
      limits: EEA_HOURLY_LIMITS['PM2.5'],
    });
    const { west, south, east, north } = image.rectangle;
    for (const edge of [west, east])
      assert.ok(
        edge >= -180 && edge <= 180,
        `longitude edge ${edge} outside ±180`,
      );
    // The raised shell builds a Cesium RectangleGeometry from these bounds.
    assert.doesNotThrow(
      () =>
        new Cesium.RectangleGeometry({
          rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north),
          height: 0,
          granularity: Cesium.Math.toRadians(0.5),
        }),
    );
  });
}

test('a full-turn row requires an explicit wrapping grid', () => {
  const global = {
    width: 4,
    height: 2,
    step: 90,
    lon0: 0,
    lat0: 45,
    steps: [0],
  };
  const manifest = {
    run: '2026-11-20T00:00:00Z',
    scale: Object.fromEntries(FIELD_IDS.map((id) => [id, 1])),
    global,
  };
  assert.throws(
    () => readFieldManifest(manifest),
    /Malformed air-quality field/,
  );
  assert.throws(
    () =>
      readFieldManifest({ ...manifest, global: { ...global, wrap: false } }),
    /Malformed air-quality field/,
  );
  assert.equal(
    readFieldManifest({ ...manifest, global: { ...global, wrap: true } }).global
      .wrap,
    true,
  );
});
