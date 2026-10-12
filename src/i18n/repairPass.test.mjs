// Repair-pass anchors (extraction correctness).
//
// en behavior must stay byte-identical: the values added for the director
// status corpus, the keySetup dev surface, and the map-source wiring are
// pinned here to the exact literals the code rendered before extraction.
// Cross-module anchors (keySetupCore registry) catch catalog/registry drift
// in either direction. The locale-scoped CCTV wrap rules and per-locale value
// pins live in their locale PRs (es first); this file pins the English
// contract plus the pixel-identical English layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getCatalog } from './index.js';
import { KEY_SETUP_KEYS, keySetupRequirement } from '../keySetupCore.mjs';

const en = getCatalog('en');

test('director status corpus keeps the pre-extraction English literals byte-identical', () => {
  const expected = {
    'setup.scenes.status.captureCameraNotReady': 'Cannot capture shot: camera not ready',
    'setup.scenes.status.shotTitleDefault': 'Shot {n}',
    'setup.scenes.status.captured': 'Captured: {scene} / {shot}',
    'setup.scenes.status.selectShotFirst': 'Select a shot first',
    'setup.scenes.status.updated': 'Updated: {scene} / {shot}',
    'setup.scenes.status.deleteShotConfirm': 'Delete shot "{shot}"?',
    'setup.scenes.status.loaded': 'Loaded: {scene} / {shot}',
    'setup.scenes.status.cameraUnavailable': 'Camera unavailable — exit cockpit first',
    'setup.scenes.status.noShotsToRun': 'No shots to run',
    'setup.scenes.status.runningShot': 'Running {index}/{total}: {scene} / {shot}',
    'setup.scenes.status.runComplete': 'Scene run complete',
    'setup.scenes.status.runError': 'Error: {message}',
    'setup.scenes.status.contextExitFailed': 'Could not exit {mode} — scene layers may be refused',
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(en[key], value, `${key} drifted from the removed English literal`);
  }
});

test('setup.keySetup.unlocks.* en values equal the keySetupCore registry copy', () => {
  for (const entry of KEY_SETUP_KEYS) {
    const key = `setup.keySetup.unlocks.${entry.id}`;
    assert.equal(en[key], entry.unlocks, `${key} drifted from KEY_SETUP_KEYS unlocks`);
  }
  assert.equal(en['setup.keySetup.requirement'], 'Needs {envVars} — add it in Provider Settings');
  assert.equal(
    keySetupRequirement('cesium-ion'),
    'Needs CESIUM_ION_TOKEN — add it in Provider Settings',
    'en requirement sentence must stay byte-identical (pinned by keySetupCore.test.mjs)',
  );
});

test('map-source keys match the static markup pinned by mapStackChips.test.mjs', () => {
  assert.equal(en['cockpit.presets.mapSourceLabel'], 'MAP SOURCE');
  assert.equal(en['cockpit.presets.mapSourceChipsAriaLabel'], 'Map source');
});

test('the seven redundant layers.radio transport seeds stay deleted', () => {
  const deleted = [
    'layers.radio.pause',
    'layers.radio.resume',
    'layers.radio.playNearestAria',
    'layers.radio.pauseSelectedAria',
    'layers.radio.pauseNearestAria',
    'layers.radio.resumeSelectedAria',
    'layers.radio.resumeNearestAria',
  ];
  for (const key of deleted) {
    assert.equal(en[key], undefined, `${key} was removed by the repair pass`);
  }
});

test('the English CCTV control rows stay unwrapped: no locale-scoped wrap rule ships ahead of its locale', () => {
  // Locale wrap rules (html[lang='…'] .cctv-controls { flex-wrap: wrap }) are
  // added one per locale PR, each with a measured-width justification — never
  // speculatively. Until then the base rule must stay unwrapped so English
  // pixels are unchanged, and no html[lang] override may exist.
  const css = readFileSync(new URL('../../src/ui/styles/cctv.css', import.meta.url), 'utf8');
  const baseStart = css.indexOf('.cctv-controls {');
  const baseBody = css.slice(baseStart, css.indexOf('}', baseStart));
  assert.ok(!baseBody.includes('flex-wrap'), 'base .cctv-controls must stay unwrapped (EN pixel-identical)');
  assert.ok(!/html\[lang=/i.test(css), 'no locale-scoped CCTV rule may ship before its locale does');
});
