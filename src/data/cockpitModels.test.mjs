import { readLayerSource } from '../testSupport/readLayerSource.mjs';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Cockpit 3D aircraft policy.
 *
 * Cockpit renders NEARBY traffic with the existing fleet models and leaves
 * everything beyond the band as the shipped contact pips. The behaviour itself
 * is only observable in a browser, but the policy is expressed as a handful of
 * decisions and constants in the two flight layers, and those are exactly what a
 * regression would silently revert. These assertions pin the decisions.
 */

const LAYERS = [
  { name: 'flights', path: new URL('./flights.js', import.meta.url) },
  { name: 'militaryFlights', path: new URL('./militaryFlights.js', import.meta.url) },
];

/** Read a `const NAME = <number>;` declaration out of a module's source. */
function numericConstant(source, name) {
  const match = new RegExp(`const ${name}\\s*=\\s*(\\d+(?:\\.\\d+)?)`).exec(source);
  assert.ok(match, `${name} is declared`);
  return Number(match[1]);
}

for (const layer of LAYERS) {
  const source = readLayerSource(layer.path);

  test(`${layer.name}: every GLB creation bypasses the tile-contended frame-spread queue`, () => {
    const calls = [...source.matchAll(/Cesium\.Model\.fromGltfAsync\(\{([\s\S]*?)\}\)/g)];
    assert.ok(calls.length >= 3, `expected fleet, tracked, and preload model calls; found ${calls.length}`);
    for (const [index, call] of calls.entries()) {
      assert.match(call[1], /\basynchronous:\s*false\b/,
        `Model.fromGltfAsync call ${index + 1} must keep bounded GLB readiness independent of tile jobs`);
    }
  });

  test(`${layer.name}: Cockpit 3D obeys the shared Display toggle`, () => {
    const regime = /^([ \t]*)function _modelRegimeActive\b[\s\S]*?\n\1\}/m.exec(source)?.[0];
    assert.ok(regime, '_modelRegimeActive is defined');
    assert.match(regime, /if\s*\(\s*!(?:(?:flightState|state)\.)?_models3dEnabled,?\s*\)\s*return\s*false;/,
      'OFF must keep Cockpit AIR contacts in 2D');
    assert.doesNotMatch(regime, /!(?:(?:flightState|state)\.)?_models3dEnabled\s*&&\s*!(?:(?:flightState|state)\.)?_cockpitContactMode/,
      'Cockpit must not bypass the owner-visible Display toggle');
  });

  test(`${layer.name}: the pilot's own airframe stays hidden in cockpit`, () => {
    // Extra suppressions are allowed (the TR-3B Easter egg shares this guard,
    // pinned in tr3bRegistry.test.mjs); the cockpit exclusion is what this test
    // owns. The tracked regime is DEFAULT-ON by camera distance (2026-08-19), so
    // it no longer routes through the toggle-gated `_modelRegimeActive` — the
    // suppression is now an explicit early return.
    const regime = /^([ \t]*)function _trackedModelRegimeActive\b[\s\S]*?\n\1\}/m.exec(source)?.[0];
    assert.ok(regime, '_trackedModelRegimeActive is defined');
    assert.match(regime, /if\s*\(\s*!(?:(?:flightState|state)\.)?_trackedIcao\s*\|\|\s*(?:(?:flightState|state)\.)?_cockpitContactMode\s*\|\|[\s\S]*?return\s*false;/,
      '_trackedModelRegimeActive excludes cockpit');
    const tracked = /^([ \t]*)function _updateTrackedModel\b[\s\S]*?\n\1\}/m.exec(source)?.[0];
    assert.ok(tracked, '_updateTrackedModel is defined');
    assert.match(tracked, /(?:parts\.\w+\.)?_trackedModelRegimeActive\(\s*,?\s*\)/,
      'the tracked-model driver uses the cockpit-aware predicate');
  });

  test(`${layer.name}: Cockpit uses standard Proximity and All radii with a lower cap`, () => {
    assert.equal(numericConstant(source, 'MODEL_PROX_ADD_M'), 150_000);
    assert.equal(numericConstant(source, 'MODEL_PROX_KEEP_M'), 185_000);
    assert.equal(numericConstant(source, 'MODEL_ALL_ADD_M'), 400_000);
    assert.equal(numericConstant(source, 'MODEL_ALL_KEEP_M'), 450_000);
    assert.equal(numericConstant(source, 'COCKPIT_MODEL_MAX'), 60);

    const add = /^([ \t]*)function _modelAddDistM\b[\s\S]*?\n\1\}/m.exec(source)?.[0];
    const keep = /^([ \t]*)function _modelKeepDistM\b[\s\S]*?\n\1\}/m.exec(source)?.[0];
    assert.match(add, /(?:(?:flightState|state)\.)?_models3dMode\s*===\s*'all'\s*\?\s*(?:policy\.)?MODEL_ALL_ADD_M\s*:\s*(?:policy\.)?MODEL_PROX_ADD_M/);
    assert.match(keep, /(?:(?:flightState|state)\.)?_models3dMode\s*===\s*'all'\s*\?\s*(?:policy\.)?MODEL_ALL_KEEP_M\s*:\s*(?:policy\.)?MODEL_PROX_KEEP_M/);
    assert.doesNotMatch(add, /COCKPIT_MODEL_ADD_M/);
    assert.doesNotMatch(keep, /COCKPIT_MODEL_KEEP_M/);

    const cap = /^([ \t]*)function _modelCap\b[\s\S]*?\n\1\}/m.exec(source)?.[0];
    assert.match(cap, /Math\.min\(\s*(?:policy\.)?COCKPIT_MODEL_MAX/,
      'Cockpit keeps its 60-model performance ceiling');
  });

  test(`${layer.name}: near AIR state is independent from model admission`, () => {
    assert.match(source, /nextCockpitNearContacts\(/,
      'Cockpit derives a separate near-contact hysteresis set');
    assert.match(source, /!state\._cockpitNearContacts\.has\(icao24\);\s*if \(cockpitDot\) \{\s*const dot = iconAtlas\.slot\(cockpitContactDotImage\(\)/,
      'only out-of-range Cockpit contacts become dots');
    // `_iconKind` is identity for every unconverted contact (see
    // tr3bRegistry.test.mjs) — it only swaps the glyph for a contact the
    // operator explicitly converted into a TR-3B.
    assert.match(source, /aircraftIcon\(\s*(?:parts\.)?rendering\._iconKind\(icao24, info\?\.klass\),?\s*\)/,
      'near contacts and model fallbacks retain the class-derived aircraft silhouette');
    assert.match(source, /set\.setFlag\(row, ICON_ROTATES, false\);/,
      'far dots are reset to a rotation-free presentation');
    assert.match(source, /set\.setFlag\(row, ICON_ROTATES, true\);/,
      'near 2D silhouettes continue to receive projected course');
    assert.match(source, /icons\.setShown\(row, false\);\s*\/\/\s*hand\s*off\s*ONLY\s*once\s*the\s*model\s*renders/,
      'the gap-proof icon-to-model handoff remains intact');
  });

  test(`${layer.name}: Cockpit exit clears near state before restoring map presentation`, () => {
    const setMode = /^([ \t]*)function _setCockpitContactMode\b[\s\S]*?\n\1\}/m.exec(source)?.[0];
    assert.match(setMode, /else\s*(?:(?:flightState|state)\.)?_cockpitNearContacts\s*=\s*new\s*Set\(\s*,?\s*\);/);
    assert.match(setMode, /for \(let row = 0; row < \(icons\?\.count \?\? 0\); row\+\+\)\s*parts\.icons\._applyIconPresentation\(icons\.idAt\(row\)\);/);
  });
}

// The source reads above include the shared model module, so they pass from it
// alone. These pin that each layer actually builds its models from it, and that
// flights keeps its own hooks.
const RENDERING = {
  flights: new URL('../layers/flights/rendering.js', import.meta.url),
  militaryFlights: new URL('../layers/military/rendering.js', import.meta.url),
};

for (const [name, url] of Object.entries(RENDERING)) {
  test(`${name}: 3D models come from the shared aircraft model module`, () => {
    const source = readFileSync(url, 'utf8');
    assert.match(source, /createAircraftModels\(\{/);
    assert.match(source, /\.\.\.models\b/);
  });
}

test('flights: model eligibility nudges enrichment and the tick floors grounded icons', () => {
  const source = readFileSync(RENDERING.flights, 'utf8');
  assert.match(source, /onModelEligible:[\s\S]*?_requestTypeEnrichment\(icao24, true\)/);
  assert.match(source, /afterReplan:[\s\S]*?_floorGroundedIcons\(/);
});
