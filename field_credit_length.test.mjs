// A host's credit is shown as written, or the
// manifest is refused; it is never silently cut.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFieldManifest } from './src/layers/airQuality/field.js';

test('a credit longer than 500 characters is kept whole or refused', () => {
  const credit =
    'Contains modified Copernicus Atmosphere Monitoring Service information 2026. '.repeat(
      6,
    ) + 'Second provider: required wording ends HERE.';
  assert.ok(credit.length > 500);
  let manifest = null;
  try {
    manifest = readFieldManifest({
      run: '2026-11-20T00:00:00Z',
      credit,
      scale: { pm25: 1, pm10: 1, o3: 1, no2: 1, so2: 1, co: 1, aqi: 1 },
      global: { width: 2, height: 2, lon0: 0, lat0: 0, step: 1, steps: [0] },
    });
  } catch {
    return; // refused explicitly: acceptable
  }
  assert.equal(manifest.credit, credit);
});
