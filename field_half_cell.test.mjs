// Where the map paints a regional field, the
// card's sampler must give a value there too (the map's colour is the tiles'
// value everywhere).
import assert from 'node:assert/strict';
import test from 'node:test';
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

test('painted outer half-cell of a regional grid is sampleable', () => {
  // The bundled fixture's global grid geometry.
  const global = {
    width: 26,
    height: 26,
    lon0: 6,
    lat0: 50,
    step: 0.4000000000000057,
    wrap: false,
    steps: [0],
  };
  const manifest = readFieldManifest({
    run: '2026-11-20T00:00:00Z',
    scale: { pm25: 20, pm10: 10, o3: 50, no2: 50, so2: 20, co: 500, aqi: 10 },
    global,
  });
  const grids = {
    global: Object.fromEntries(
      FIELD_IDS.map((id) => [id, new Uint16Array(26 * 26).fill(400)]),
    ),
  };
  const [image] = paintField(manifest, grids, 'pm25', {
    bands: EEA_HOURLY_BANDS,
    limits: EEA_HOURLY_LIMITS['PM2.5'],
  });
  const { west, east, north, south } = image.rectangle;
  for (const [lon, lat] of [
    [5.9, 46],
    [16.1, 45],
    [10, 49.9],
  ]) {
    const x = Math.floor(((lon - west) / (east - west)) * image.width);
    const y = Math.floor(((north - lat) / (north - south)) * image.height);
    const alpha = image.rgba[(y * image.width + x) * 4 + 3];
    if (alpha > 0)
      assert.notEqual(
        sampleField(manifest, grids, 'pm25', lon, lat),
        null,
        `painted at ${lon},${lat} but not sampleable`,
      );
  }
});
