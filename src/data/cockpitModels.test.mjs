import { readLayerSource } from '../testSupport/readLayerSource.mjs';
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
 */

const LAYERS = [
  { name: 'flights', path: new URL('./flights.js', import.meta.url) },
  {
    name: 'militaryFlights',
    path: new URL('./militaryFlights.js', import.meta.url),
  },
];

/** Read a `const NAME = <number>;` declaration out of a module's source. */
function numericConstant(source, name) {
  const match = new RegExp(`const ${name}\\s*=\\s*(\\d+(?:\\.\\d+)?)`).exec(
    source,
  );
  assert.ok(match, `${name} is declared`);
  return Number(match[1]);
}

for (const layer of LAYERS) {
  const source = readLayerSource(layer.path);

  test(`${layer.name}: every GLB creation bypasses the tile-contended frame-spread queue`, () => {
    const calls = [
      ...source.matchAll(/Cesium\.Model\.fromGltfAsync\(\{([\s\S]*?)\}\)/g),
    ];
    assert.ok(
      calls.length >= 3,
      `expected fleet, tracked, and preload model calls; found ${calls.length}`,
    );
    for (const [index, call] of calls.entries()) {
      assert.match(
        call[1],
        /\basynchronous:\s*false\b/,
        `Model.fromGltfAsync call ${index + 1} must keep bounded GLB readiness independent of tile jobs`,
      );
    }
  });

  test(`${layer.name}: Cockpit 3D obeys the shared Display toggle`, () => {
    const regime = /^([ \t]*)function _modelRegimeActive\b[\s\S]*?\n\1\}/m.exec(
      source,
    )?.[0];
    assert.ok(regime, '_modelRegimeActive is defined');
    assert.match(
      regime,
      /if\s*\(\s*!(?:flightState\.)?_models3dEnabled,?\s*\)\s*return\s*false;/,
      'OFF must keep Cockpit AIR contacts in 2D',
    );
    assert.doesNotMatch(
      regime,
      /!(?:flightState\.)?_models3dEnabled\s*&&\s*!(?:flightState\.)?_cockpitContactMode/,
      'Cockpit must not bypass the owner-visible Display toggle',
    );
  });

  test(`${layer.name}: the pilot's own airframe stays hidden in cockpit`, () => {
    // Extra suppressions are allowed (the TR-3B Easter egg shares this guard,
    // pinned in tr3bRegistry.test.mjs); the cockpit exclusion is what this test
    // owns. The tracked regime is DEFAULT-ON by camera distance (2026-08-19), so
    // it no longer routes through the toggle-gated `_modelRegimeActive` — the
    // suppression is now an explicit early return.
    const regime =
      /^([ \t]*)function _trackedModelRegimeActive\b[\s\S]*?\n\1\}/m.exec(
        source,
      )?.[0];
    assert.ok(regime, '_trackedModelRegimeActive is defined');
    assert.match(
      regime,
      /if\s*\(\s*!(?:flightState\.)?_trackedIcao\s*\|\|\s*(?:flightState\.)?_cockpitContactMode\s*\|\|[\s\S]*?return\s*false;/,
      '_trackedModelRegimeActive excludes cockpit',
    );
    const tracked =
      /^([ \t]*)function _updateTrackedModel\b[\s\S]*?\n\1\}/m.exec(
        source,
      )?.[0];
    assert.ok(tracked, '_updateTrackedModel is defined');
    assert.match(
      tracked,
      /(?:parts\.\w+\.)?_trackedModelRegimeActive\(\s*,?\s*\)/,
      'the tracked-model driver uses the cockpit-aware predicate',
    );
  });

  test(`${layer.name}: Cockpit uses standard Proximity and All radii with a lower cap`, () => {
    assert.equal(numericConstant(source, 'MODEL_PROX_ADD_M'), 150_000);
    assert.equal(numericConstant(source, 'MODEL_PROX_KEEP_M'), 185_000);
    assert.equal(numericConstant(source, 'MODEL_ALL_ADD_M'), 400_000);
    assert.equal(numericConstant(source, 'MODEL_ALL_KEEP_M'), 450_000);
    assert.equal(numericConstant(source, 'COCKPIT_MODEL_MAX'), 60);

    const add = /^([ \t]*)function _modelAddDistM\b[\s\S]*?\n\1\}/m.exec(
      source,
    )?.[0];
    const keep = /^([ \t]*)function _modelKeepDistM\b[\s\S]*?\n\1\}/m.exec(
      source,
    )?.[0];
    assert.match(
      add,
      /(?:flightState\.)?_models3dMode\s*===\s*'all'\s*\?\s*MODEL_ALL_ADD_M\s*:\s*MODEL_PROX_ADD_M/,
    );
    assert.match(
      keep,
      /(?:flightState\.)?_models3dMode\s*===\s*'all'\s*\?\s*MODEL_ALL_KEEP_M\s*:\s*MODEL_PROX_KEEP_M/,
    );
    assert.doesNotMatch(add, /COCKPIT_MODEL_ADD_M/);
    assert.doesNotMatch(keep, /COCKPIT_MODEL_KEEP_M/);

    const cap = /^([ \t]*)function _modelCap\b[\s\S]*?\n\1\}/m.exec(
      source,
    )?.[0];
    assert.match(
      cap,
      /Math\.min\(\s*COCKPIT_MODEL_MAX/,
      'Cockpit keeps its 60-model performance ceiling',
    );
  });

  test(`${layer.name}: near AIR state is independent from model admission`, () => {
    assert.match(
      source,
      /nextCockpitNearContacts\(/,
      'Cockpit derives a separate near-contact hysteresis set',
    );
    assert.match(
      source,
      /isCockpitContact && !isCockpitNear[\s\S]*cockpitContactDotImage\(\)/,
      'only out-of-range Cockpit contacts become dots',
    );
    // `_iconKind` is identity for every unconverted contact (see
    // tr3bRegistry.test.mjs) — it only swaps the glyph for a contact the
    // operator explicitly converted into a TR-3B.
    assert.match(
      source,
      /bb\.image\s*=\s*aircraftIcon\(\s*_iconKind\(\s*icao24,\s*meta\?\.klass,?\s*\)(,\s*bb\._gevIconLarge\s*\?\s*TRACKED_ICON_PX\s*:\s*undefined)?,?\s*\)/,
      'near contacts and model fallbacks retain the class-derived aircraft silhouette',
    );
    assert.match(
      source,
      /bb\.rotation\s*=\s*0;/,
      'far dots are reset to a rotation-free presentation',
    );
    assert.match(
      source,
      /\(\s*!(?:flightState\.)?_cockpitContactMode\s*\|\|\s*isCockpitNear,?\s*\)\s*&&\s*\(\s*doRotations\s*\|\|\s*revealed,?\s*\)/,
      'near 2D silhouettes continue to receive projected course',
    );
    assert.match(
      source,
      /if\s*\(\s*bb\.show,?\s*\)\s*bb\.show\s*=\s*false;\s*\/\/\s*hand\s*off\s*ONLY\s*once\s*the\s*model\s*renders/,
      'the gap-proof billboard-to-model handoff remains intact',
    );
  });

  test(`${layer.name}: Cockpit exit clears near state before restoring map presentation`, () => {
    const setMode =
      /^([ \t]*)function _setCockpitContactMode\b[\s\S]*?\n\1\}/m.exec(
        source,
      )?.[0];
    assert.match(
      setMode,
      /else\s*(?:flightState\.)?_cockpitNearContacts\s*=\s*new\s*Set\(\s*,?\s*\);/,
    );
    assert.match(
      setMode,
      /for\s*\(\s*const\s*\[icao24,\s*bb\]\s*of\s*(?:flightState\.)?_billboards,?\s*\)\s*(?:parts\.\w+\.)?_applyFleetBillboardPresentation\(\s*icao24,\s*bb,?\s*\);/,
    );
  });
}
