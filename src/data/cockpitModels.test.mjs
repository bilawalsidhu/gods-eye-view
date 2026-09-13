import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Cockpit 3D aircraft policy.
 *
 * Cockpit renders NEARBY traffic with the existing fleet models and leaves
 * everything beyond the band as the shipped contact pips. The behaviour itself
 * is only observable in a browser, but the policy is expressed as a handful of
 * decisions and constants in the two flight layers, and those are exactly what a
 * regression would silently revert. These assertions pin the decisions.
 *
 * both flight layers' shared tracking/model pipeline lives in flightsTracking.js
 * (Batch 5 item 2), so every pin reads the factory source and addresses state
 * through the `p.` pipeline instance.
 */

const LAYERS = [
  {
    name: 'flights',
    path: new URL('./flights.js', import.meta.url),
    pipeline: new URL('./flightsTracking.js', import.meta.url),
    px: 'p\\.',
  },
  {
    name: 'militaryFlights',
    path: new URL('./militaryFlights.js', import.meta.url),
    pipeline: new URL('./flightsTracking.js', import.meta.url),
    px: 'p\\.',
  },
];

/** Read a `<prefix>NAME = <number>;` declaration out of a module's source. */
function numericConstant(source, name, prefix = 'const ') {
  const match = new RegExp(`${prefix}${name}\\s*=\\s*(\\d+(?:\\.\\d+)?)`).exec(source);
  assert.ok(match, `${prefix}${name} is declared`);
  return Number(match[1]);
}

for (const layer of LAYERS) {
  const source = readFileSync(layer.path, 'utf8');
  const pipeline = layer.pipeline ? readFileSync(layer.pipeline, 'utf8') : source;
  const px = layer.px;

  test(`${layer.name}: every GLB creation bypasses the tile-contended frame-spread queue`, () => {
    // flights' fleet-model creation moved to the factory; count across both files.
    const calls = [...(`${source  }\n${  pipeline}`).matchAll(/Cesium\.Model\.fromGltfAsync\(\{([\s\S]*?)\}\)/g)];
    assert.ok(calls.length >= 3, `expected fleet, tracked, and preload model calls; found ${calls.length}`);
    for (const [index, call] of calls.entries()) {
      assert.match(call[1], /\basynchronous:\s*false\b/,
        `Model.fromGltfAsync call ${index + 1} must keep bounded GLB readiness independent of tile jobs`);
    }
  });

  test(`${layer.name}: Cockpit 3D obeys the shared Display toggle`, () => {
    const regime = /function _modelRegimeActive\(\) \{[\s\S]*?\n\}/.exec(pipeline)?.[0];
    assert.ok(regime, '_modelRegimeActive is defined');
    assert.match(regime, new RegExp(`if \\(!${px}_models3dEnabled\\) return false;`),
      'OFF must keep Cockpit AIR contacts in 2D');
    assert.doesNotMatch(regime, new RegExp(`!${px}_models3dEnabled\\s*&&\\s*!${px}_cockpitContactMode`),
      'Cockpit must not bypass the user-visible Display toggle');
  });

  test(`${layer.name}: the pilot's own airframe stays hidden in cockpit`, () => {
    // Extra suppressions are allowed (the TR-3B Easter egg shares this guard,
    // pinned in tr3bRegistry.test.mjs); the cockpit exclusion is what this test
    // owns. The tracked regime is DEFAULT-ON by camera distance (2026-08-19), so
    // it no longer routes through the toggle-gated `_modelRegimeActive` — the
    // suppression is now an explicit early return.
    const regime = /function _trackedModelRegimeActive\(\) \{[\s\S]*?\n\}/.exec(pipeline)?.[0];
    assert.ok(regime, '_trackedModelRegimeActive is defined');
    assert.match(regime, new RegExp(`if \\(!${px}_trackedIcao \\|\\| ${px}_cockpitContactMode \\|\\|[\\s\\S]*?return false;`),
      '_trackedModelRegimeActive excludes cockpit');
    const tracked = /function _updateTrackedModel\(\)[\s\S]*?\n {2}if \(!active\)/.exec(source)?.[0];
    assert.ok(tracked, '_updateTrackedModel is defined');
    assert.match(tracked, new RegExp(`${px}_trackedModelRegimeActive\\(\\)`),
      'the tracked-model driver uses the cockpit-aware predicate');
  });

  test(`${layer.name}: Cockpit uses standard Proximity and All radii with a lower cap`, () => {
    assert.equal(numericConstant(pipeline, 'MODEL_PROX_ADD_M', px), 150_000);
    assert.equal(numericConstant(pipeline, 'MODEL_PROX_KEEP_M', px), 185_000);
    assert.equal(numericConstant(pipeline, 'MODEL_ALL_ADD_M', px), 400_000);
    assert.equal(numericConstant(pipeline, 'MODEL_ALL_KEEP_M', px), 450_000);
    assert.equal(numericConstant(source, 'COCKPIT_MODEL_MAX'), 60);

    const add = /function _modelAddDistM\(\) \{[\s\S]*?\n\}/.exec(pipeline)?.[0];
    const keep = /function _modelKeepDistM\(\) \{[\s\S]*?\n\}/.exec(pipeline)?.[0];
    assert.match(add, new RegExp(`${px}_models3dMode === 'all' \\? ${px}MODEL_ALL_ADD_M : ${px}MODEL_PROX_ADD_M`));
    assert.match(keep, new RegExp(`${px}_models3dMode === 'all' \\? ${px}MODEL_ALL_KEEP_M : ${px}MODEL_PROX_KEEP_M`));
    assert.doesNotMatch(add, /COCKPIT_MODEL_ADD_M/);
    assert.doesNotMatch(keep, /COCKPIT_MODEL_KEEP_M/);

    const cap = /function _modelCap\(\) \{[\s\S]*?\n\}/.exec(source)?.[0];
    assert.match(cap, /Math\.min\(COCKPIT_MODEL_MAX/,
      'Cockpit keeps its 60-model performance ceiling');
  });

  test(`${layer.name}: near AIR state is independent from model admission`, () => {
    // These pins span the layer's own code and the shared pipeline; scan both.
    const impl = `${source  }\n${  pipeline}`;
    assert.match(impl, /nextCockpitNearContacts\(/,
      'Cockpit derives a separate near-contact hysteresis set');
    assert.match(impl, new RegExp(`isCockpitContact && !isCockpitNear[\\s\\S]*cockpitContactDotImage\\(\\)`),
      'only out-of-range Cockpit contacts become dots');
    // `_iconKind` is identity for every unconverted contact (see
    // tr3bRegistry.test.mjs) — it only swaps the glyph for a contact the
    // operator explicitly converted into a TR-3B.
    assert.match(impl, new RegExp(`bb\\.image = aircraftIcon\\(${px}_iconKind\\(icao24, meta\\?\\.klass\\)(, bb\\._gevIconLarge \\? TRACKED_ICON_PX : undefined)?\\)`),
      'near contacts and model fallbacks retain the class-derived aircraft silhouette');
    assert.match(impl, /bb\.rotation = 0;/,
      'far dots are reset to a rotation-free presentation');
    assert.match(impl, new RegExp(`\\(!${px}_cockpitContactMode \\|\\| isCockpitNear\\) && \\(doRotations \\|\\| revealed\\)`),
      'near 2D silhouettes continue to receive projected course');
    assert.match(impl, /if \(bb\.show\) bb\.show = false; \/\/ hand off ONLY once the model renders/,
      'the gap-proof billboard-to-model handoff remains intact');
  });

  test(`${layer.name}: Cockpit exit clears near state before restoring map presentation`, () => {
    const setMode = /function _setCockpitContactMode\([\s\S]*?\n\}/.exec(pipeline)?.[0];
    assert.match(setMode, new RegExp(`else ${px}_cockpitNearContacts = new Set\\(\\);`));
    assert.match(setMode, new RegExp(`for \\(const \\[icao24, bb\\] of ${px}_billboards\\) ${px}_applyFleetBillboardPresentation\\(icao24, bb\\);`));
  });
}
