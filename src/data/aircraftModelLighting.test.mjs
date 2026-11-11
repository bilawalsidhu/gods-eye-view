import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readLayerSource } from '../testSupport/readLayerSource.mjs';
import { AIRCRAFT_ENVIRONMENT_MAP_OPTIONS } from './aircraftModelLighting.js';

/**
 * Every aircraft model drawn in the scene skips Cesium's dynamic environment
 * map (a sky render and GPU readback per model). The preload calls only warm
 * the glTF cache and are never added to the scene, so they are left out:
 * drawn models are the calls that set a minimum pixel size.
 */
const SOURCES = [
  {
    name: 'flights',
    source: readLayerSource(new URL('./flights.js', import.meta.url)),
  },
  {
    name: 'militaryFlights',
    source: readLayerSource(new URL('./militaryFlights.js', import.meta.url)),
  },
  {
    name: 'localAdsb',
    source: readFileSync(
      new URL('../layers/localAdsb/models.js', import.meta.url),
      'utf8',
    ),
  },
];

test('the shared option turns the dynamic environment map off', () => {
  assert.deepEqual({ ...AIRCRAFT_ENVIRONMENT_MAP_OPTIONS }, { enabled: false });
  assert.ok(Object.isFrozen(AIRCRAFT_ENVIRONMENT_MAP_OPTIONS));
});

for (const { name, source } of SOURCES) {
  test(`${name}: every drawn aircraft model skips the dynamic environment map`, () => {
    const calls = [
      ...source.matchAll(/(?:fromGltfAsync|loadModel)\(\{([\s\S]*?)\}\)/g),
    ]
      .map((match) => match[1])
      .filter((options) => /\bminimumPixelSize:/.test(options));
    assert.ok(calls.length >= 1, `expected drawn model calls in ${name}`);
    for (const [index, options] of calls.entries())
      assert.match(
        options,
        /\benvironmentMapOptions:\s*AIRCRAFT_ENVIRONMENT_MAP_OPTIONS\b/,
        `${name} model call ${index + 1} must pass AIRCRAFT_ENVIRONMENT_MAP_OPTIONS`,
      );
  });
}
