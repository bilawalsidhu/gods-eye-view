import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readLayerSource } from '../testSupport/readLayerSource.mjs';
import { AIRCRAFT_ENVIRONMENT_MAP_OPTIONS } from './aircraftModelLighting.js';

/**
 * Every aircraft model drawn in the scene skips the renderer's dynamic
 * environment map (a sky render and GPU readback per model).
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
];

test('the shared option turns the dynamic environment map off', () => {
  assert.deepEqual({ ...AIRCRAFT_ENVIRONMENT_MAP_OPTIONS }, { enabled: false });
  assert.ok(Object.isFrozen(AIRCRAFT_ENVIRONMENT_MAP_OPTIONS));
});

for (const { name, source } of SOURCES) {
  test(`${name}: every drawn aircraft model skips the dynamic environment map`, () => {
    // Its models are draw-port items; every item it builds (fleet, tracked
    // and the tracked preload) carries the shared option.
    assert.doesNotMatch(source, /fromGltfAsync|loadModel\(/);
    const items = [...source.matchAll(/\burl: (?:record\.url|preloadUrl),/g)];
    assert.ok(items.length >= 2, `expected model items in ${name}`);
    const flags = [
      ...source.matchAll(/\benvironmentMap:\s*AIRCRAFT_ENVIRONMENT_MAP_OPTIONS\.enabled\b/g),
    ];
    assert.equal(flags.length, items.length, `${name} model items must pass AIRCRAFT_ENVIRONMENT_MAP_OPTIONS`);
  });
}

test('localAdsb: its draw-port models skip the dynamic environment map', () => {
  const source = readFileSync(
    new URL('../layers/localAdsb/models.js', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /\benvironmentMap:\s*AIRCRAFT_ENVIRONMENT_MAP_OPTIONS\.enabled\b/,
  );
});
