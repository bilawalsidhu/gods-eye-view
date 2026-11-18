import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readLayerSource } from '../testSupport/readLayerSource.mjs';
import {
  AIRCRAFT_ENVIRONMENT_MAP_OPTIONS,
  aircraftModelBlend,
} from './aircraftModelLighting.js';
import * as flightsPolicy from '../layers/flights/policy.js';
import * as militaryPolicy from '../layers/military/policy.js';

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
    // Its models are draw-port items; every item it builds (fleet and
    // tracked) carries the shared option.
    assert.doesNotMatch(source, /fromGltfAsync|loadModel\(/);
    const items = [...source.matchAll(/\burl: record\.url,/g)];
    assert.ok(items.length >= 1, `expected model items in ${name}`);
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

/**
 * The colour a model draws in, as the renderer blends its tint over the
 * shaded paint (`ModelItem.colorBlend`, Cesium's model colour stage): `mix`
 * moves the paint toward the tint by `amount`; `highlight` multiplies.
 */
function blended(paint, tint, blend) {
  if (blend.mode === 'mix')
    return paint.map((c, i) => c + (tint[i] - c) * blend.amount);
  if (blend.mode === 'highlight') return paint.map((c, i) => c * tint[i]);
  return tint.slice(0, 3);
}

/** Paints the fleet models carry: a red helicopter, a white airliner, a dark blue tail. */
const PAINTS = {
  red: [0.8, 0.05, 0.05],
  white: [0.9, 0.9, 0.9],
  blue: [0.05, 0.1, 0.5],
};

test('an untinted model draws its mesh in its own colours', () => {
  for (const tint of [null, [1, 1, 1, 1], flightsPolicy.MODEL_WHITE]) {
    const blend = aircraftModelBlend(false, tint);
    for (const paint of Object.values(PAINTS))
      assert.deepEqual(blended(paint, [1, 1, 1], blend), paint);
  }
});

test('the emergency tints keep every paint, never black or one flat colour', () => {
  const tints = {
    emergency: flightsPolicy.EMERGENCY_TINT,
    'military emergency': militaryPolicy.EMERGENCY_ICON_COLOR,
    // Any saturated tint: one with no red once drew a red helicopter black.
    cyan: [0, 1, 1, 1],
  };
  for (const [tintName, tint] of Object.entries(tints)) {
    const blend = aircraftModelBlend(false, tint);
    const drawn = {};
    for (const [paintName, paint] of Object.entries(PAINTS)) {
      const out = blended(paint, tint, blend);
      drawn[paintName] = out;
      // Multiplying by a tint with no red drew a red helicopter black.
      paint.forEach((c, i) =>
        assert.ok(
          out[i] >= c * 0.6,
          `${tintName} over ${paintName}: channel ${i} ${out[i].toFixed(2)} keeps most of ${c}`,
        ),
      );
    }
    // Paints that differ still differ: the tint is not one flat colour.
    const spread = (a, b) => Math.max(...a.map((c, i) => Math.abs(c - b[i])));
    assert.ok(spread(drawn.red, drawn.white) > 0.4, `${tintName}: red and white apart`);
    assert.ok(spread(drawn.blue, drawn.white) > 0.4, `${tintName}: blue and white apart`);
  }
});

test('the IR boost draws every model flat white whatever its tint', () => {
  for (const tint of [null, flightsPolicy.EMERGENCY_TINT])
    assert.deepEqual(aircraftModelBlend(true, tint), { mode: 'mix', amount: 1 });
});
