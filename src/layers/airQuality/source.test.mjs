import assert from 'node:assert/strict';
import test from 'node:test';
import * as portable from './source.js';
import * as layerModule from './index.js';

test('the portable source composes the station providers; Canada has no AQHI source of its own', () => {
  assert.equal(typeof portable.createAirQualitySource, 'function');
  assert.equal(typeof portable.createAirQualitySnapshotSource, 'function');
  assert.deepEqual(
    portable.createDefaultAirQualityProviders().map((entry) => entry.id),
    ['saaqis', 'cpcb', 'openaq'],
  );
  // Canada's stations come from OpenAQ like every other country's.
  assert.equal('createEcccAirQualitySource' in portable, false);
  assert.equal('createEcccAirQualitySource' in layerModule, false);
});

test("the layer's model has no AQHI scale left", () => {
  for (const name of [
    'AIR_QUALITY_BANDS',
    'AIR_QUALITY_PROVIDERS',
    'airQualityBandById',
    'airQualityColor',
    'aqhiDisplayValue',
    'bandForValue',
    'bandRiskText',
    'normalizeAqhiObservations',
    'normalizeAqhiStations',
    'valueLabel',
  ])
    assert.equal(name in layerModule, false, name);
});
