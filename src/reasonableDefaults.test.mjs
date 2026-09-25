import { readSource } from './testSupport/readSource.js';
// src/reasonableDefaults.test.mjs
//
// What the console looks like the FIRST time it opens — before any share link,
// before any stored state. The "reasonable defaults" batch (product invariant,
// 2026-08-22) moved three of them together:
//
//   1. 3D aircraft models ON, mode `proximity`.
//      Pinned in `data/layerState.test.mjs`, next to the coordinator that
//      actually decides fresh-boot layer state — including the early return that
//      makes each layer's own initializer the operative default.
//   2. Scope feather moved to 0% on 2026-08-22, 8% on 2026-08-23, a soft 11%
//      edge on 2026-08-24, and a fully-feathered 100% edge on 2026-08-29.
//      The hard crop is still one drag away and pinned.
//   3. Detection ON (Dense @ 75%) for EVERY style, Normal included.
//   4. Detection OUTSIDE opacity 1% (final value, 2026-08-24; 3% on 08-23, 5% before), with
//      the slider's `step` at 1 so the range around it is reachable at all.
//
// Each pin below has the same three parts, because a default is never one
// literal:
//
//   • the first-run VALUE, at every surface that independently decides it — a
//     fresh boot runs no restore, so these literals ARE the startup state and
//     changing one alone ships a UI that disagrees with its own engine;
//   • explicit state still WINS over it — a link, or the operator's own hand,
//     because "default" means "what you get when you said nothing";
//   • the surrounding override machinery is INTACT, so a default flip cannot
//     quietly take a separate landed behaviour with it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { KEYHOLE_OUTER_RADIUS, KEYHOLE_OUTSIDE_OPACITY_DEFAULT, KEYHOLE_LABEL_FEATHER_RATIO } from './celestialRing.js';
import { AIRCRAFT_BRACKET_FLOOR_ANCHOR } from './data/detectionPolicy.js';
import {
  SCOPE_FEATHER_RATIO_DEFAULT,
  getScopeMaskFeather,
  scopeMaskGeometry,
  setScopeMaskFeather,
} from './scopeMask.js';
import { ShareLinkManager } from './sharelink.js';

const uiSource = readSource('./ui.js', import.meta.url);
const indexHtml = readSource('../index.html', import.meta.url);
const shareSource = readSource('./sharelink.js', import.meta.url);

/** Slice ui.js between two literal anchors, so a pin reads one method, not the file. */
function uiBlock(start, end) {
  const startIndex = uiSource.indexOf(start);
  assert.ok(startIndex >= 0, `missing source anchor: ${start}`);
  const endIndex = uiSource.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing source anchor: ${end}`);
  return uiSource.slice(startIndex, endIndex);
}

/** A ShareLinkManager over a synthetic hash — enough surface for parseInitialHash. */
function managerForHash(hash) {
  globalThis.window = { location: { hash, href: `http://localhost/${hash}` } };
  globalThis.history = { replaceState(_s, _t, next) { window.location.hash = next; } };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  };
  return new ShareLinkManager(viewer);
}

// ---------------------------------------------------------------------------
// 2. Scope feather — a subtle soft edge on a first run
// ---------------------------------------------------------------------------

test('first run opens with a fully-feathered scope, at every surface that decides it', () => {
  assert.equal(SCOPE_FEATHER_RATIO_DEFAULT, 1,
    'operator ruling 2026-08-29, superseding the 08-24 11% ruling');
  assert.equal(getScopeMaskFeather(), 1,
    'and the live module starts there, not merely documents it');

  // The slider and its readout are the same default rendered as markup — a
  // fresh boot applies no restore, so a stale value here would show one number
  // over a mask drawn at another.
  assert.match(indexHtml, /id="scope-feather-slider"[^>]*\svalue="100"/,
    'index.html: the feather slider ships at 100');
  assert.match(indexHtml, /id="scope-feather-value"[^>]*>100%</,
    'index.html: and its readout agrees with the handle');

  // The link this session generates must describe the mask this session draws,
  // for the window before the first _syncShareState.
  assert.match(shareSource, /this\._scopeFeatherPct = 100;/,
    'sharelink.js: the generator starts from the same value the mask starts at');
});

test('an explicit feather still wins over the subtle default', () => {
  // A link is authored state. The new default governs a session that said
  // nothing; it must never overwrite one that said something.
  assert.equal(managerForHash('#lat=10&lon=20&scf=35').parseInitialHash().scopeFeatherPct, 35);
  assert.equal(managerForHash('#lat=10&lon=20&scf=64').parseInitialHash().scopeFeatherPct, 64);
  assert.equal(managerForHash('#lat=10&lon=20&scf=0').parseInitialHash().scopeFeatherPct, 0,
    'an explicit 0 is a choice too, not an absent field');

  // A link from before `scf` existed still restores what ITS author saw, which
  // is the retired 35 — parsing an archive is not the same question as booting
  // fresh, and this deliberately did NOT move with either later default.
  assert.equal(managerForHash('#lat=10&lon=20&style=normal').parseInitialHash().scopeFeatherPct, 35,
    'a pre-scf link restores the author\'s view, not the new default');
});

test('the subtle default did not weaken the feather control, and 0 is still reachable', () => {
  // The cheap way to move a default would be to nerf the control. Prove the
  // slider still spans its full range and the geometry is still DERIVED from
  // the ratio — a check that would pass vacuously if it only ever saw one value.
  assert.match(indexHtml, /id="scope-feather-slider"[^>]*\smin="0"[^>]*\smax="100"/,
    'the slider still offers the whole range');
  const previous = getScopeMaskFeather();
  try {
    for (const ratio of [0.35, 0.7, 1]) {
      setScopeMaskFeather(ratio);
      const geo = scopeMaskGeometry(1200, 900);
      const keyholeR = 900 * 0.5 * KEYHOLE_OUTER_RADIUS;
      assert.ok(Math.abs((geo.outerR - geo.innerR) - keyholeR * ratio) < 1e-9,
        `feather ${ratio} must still widen the band to that fraction of the keyhole`);
    }
    // The new default is the full band — the feather spans the whole keyhole
    // radius, the opposite extreme from the retired hard-crop default.
    setScopeMaskFeather(SCOPE_FEATHER_RATIO_DEFAULT);
    const soft = scopeMaskGeometry(1200, 900);
    const keyholeR = 900 * 0.5 * KEYHOLE_OUTER_RADIUS;
    assert.ok(Math.abs((soft.outerR - soft.innerR) - keyholeR * SCOPE_FEATHER_RATIO_DEFAULT) < 1e-9,
      'the default really draws its own band, derived from the ratio');
    assert.ok(soft.outerR > soft.innerR, 'and it is a band, not a hard edge');
    // The hard crop the previous default shipped is still one drag away.
    setScopeMaskFeather(0);
    const hard = scopeMaskGeometry(1200, 900);
    assert.equal(hard.outerR, hard.innerR,
      'an explicit 0 is still the hard crop — the path was not removed with the default');
  } finally {
    setScopeMaskFeather(previous);
  }
});

// ---------------------------------------------------------------------------
// 2d. Visual preset — first run opens in CRT (operator ruling 2026-08-29).
// Applied through the real setStyle path so the retro preset, tray state,
// HUD tone, and share generator all observe one honest style switch.

test('first run opens in CRT, at every surface that decides it', () => {
  // The constructor must go through setStyle — not merely set the field —
  // so the retro stage, preset defaults, HUD, and tray all engage for real.
  assert.match(uiSource, /this\.setStyle\('retro', \{ applyPreset: true, revealParameters: false, restore: true \}\);/,
    'ui.js: the first-run CRT default goes through the real setStyle path');
  assert.match(uiSource, /`restore: true` skips the restore-lane claim/,
    'ui.js: the default documents why it skips the restore-lane claim');

  // Markup is the first paint: the tray and mini readout must already show
  // CRT before any script runs, matching the engine's first-run state.
  assert.match(indexHtml, /<button class="style-btn active" data-style="retro">/,
    'index.html: the CRT preset button ships active');
  assert.doesNotMatch(indexHtml, /<button class="style-btn active" data-style="normal">/,
    'index.html: Normal no longer ships as the active preset');
  assert.match(indexHtml, /id="style-mini-value"[^>]*>CRT</,
    'index.html: the style mini readout agrees with the tray');

  // A link that predates the style field restores what ITS author saw —
  // Normal — which now requires the restore path to travel retro → normal.
  assert.match(shareSource, /URL_TO_STYLE\[params\.get\('style'\)\] \|\| 'normal'/,
    'sharelink.js: the style parse fallback still restores the Normal era');
  assert.match(uiSource, /style !== 'ai-edit' && style !== this\.activeStyle/,
    'ui.js: an explicit Normal link still restores Normal over the CRT default');
});

// ---------------------------------------------------------------------------
// 2e. Attribution strip — docked on-screen (2026-09-24), superseding the
// 2026-08-29 removal. The 2026-08-29 ruling detached the credit container and
// a keep-removed pin guarded that state; PLAN.md's accepted resolution
// ("restore a visible credit line or ship an equivalent attribution surface")
// has now landed as src/creditsDock.js, so the pin flips AGAIN — from
// keep-removed to keep-docked-and-visible: Google Maps Platform ToS requires
// visible attribution for Photorealistic 3D Tiles, and matrix check C13
// asserts the clean-view visibility contract at runtime. This pin holds the
// static surfaces: the dock exists, main.js calls it, and nothing may hide
// the dock or re-detach the container silently.

test('the attribution strip stays docked and visible, at every surface that renders it', () => {
  const mainSource = readSource('./main.js', import.meta.url);
  const containerStart = mainSource.indexOf('// Credit container —');
  const creditContainer = mainSource.slice(
    containerStart,
    mainSource.indexOf('})(),', containerStart),
  );
  assert.ok(creditContainer.length > 0, 'main.js: the creditContainer IIFE is still present');
  assert.match(creditContainer, /Google Maps Platform ToS requires visible attribution/,
    'main.js: the ToS caveat stays discoverable next to the container');
  assert.match(mainSource, /attachCreditDock\(viewer\);/,
    'main.js: the viewer construction docks the credit container');

  const dockSource = readSource('./creditsDock.js', import.meta.url);
  assert.match(dockSource, /isConnected/,
    'creditsDock.js: docking is idempotent — a live container is never re-wrapped');
  assert.match(dockSource, /appendChild\(creditContainer\)/,
    'creditsDock.js: the viewer’s OWN container is docked (Cesium’s credit display lives inside)');

  const css = readSource('../style.css', import.meta.url);
  assert.match(css, /\.gev-credit-dock \{[^}]*position: fixed;/,
    'style.css: the dock is a positioned on-screen surface');
  assert.doesNotMatch(css, /\.gev-credit-dock \{[^}]*display: *none/,
    'style.css: nothing hides the dock — visibility is the compliance contract');
  assert.doesNotMatch(css, /#cesium-credits \{[^}]*display: *none/,
    'style.css: the credit container itself is never hidden either');
});

// ---------------------------------------------------------------------------
// 2c. Detection Fade — 7% on a first run, at every surface that decides it
// (final value 2026-08-24; 16% before). Fade is the label/card fading
// band around the keyhole — a different control from the scope-mask feather.
test('first run opens at 7% detection fade, at every surface that decides it', () => {
  assert.equal(KEYHOLE_LABEL_FEATHER_RATIO, 0.07,
    'celestialRing.js: the engine fade band opens at 7%');
  assert.match(uiSource, /detectionFadePct: 7,/,
    'ui.js: the global post defaults apply the same value on first load');
  assert.match(indexHtml, /id="detection-fade-slider"[^>]*\svalue="7"/,
    'index.html: the fade slider ships at 7');
  assert.match(indexHtml, /id="detection-fade-value"[^>]*>7%</,
    'index.html: the fade readout agrees with the slider');
  assert.match(shareSource, /this\._detectionFadePct = 7;/,
    'sharelink.js: the generator starts from the same value the overlay draws');
});

// 2b. Detection OUTSIDE opacity — 1% on a first run
// ---------------------------------------------------------------------------

test('first run opens at 1% OUTSIDE opacity, at every surface that decides it', () => {
  assert.equal(KEYHOLE_OUTSIDE_OPACITY_DEFAULT, 0.01,
    'final value 2026-08-24: the world overlay reads quieter beyond the keyhole');

  // Four independent literals decide this on a fresh boot: the engine constant
  // above, the markup and its readout, ui.js's global post defaults, and the
  // share generator's starting state. Changing one alone ships a UI that
  // disagrees with its own engine.
  assert.match(indexHtml, /id="detection-opacity-slider"[^>]*\svalue="1"/,
    'index.html: the OUTSIDE slider ships at 1');
  assert.match(indexHtml, /id="detection-opacity-value"[^>]*>1%</,
    'index.html: and its readout agrees with the handle');
  assert.match(uiSource, /detectionOutsideOpacityPct: 1,/,
    'ui.js: the global post defaults apply the same value on first load');
  assert.match(shareSource, /this\._detectionOutsideOpacityPct = 1;/,
    'sharelink.js: the generator starts from the same value the overlay draws');

  // The bracket floor is calibrated AT the default, so it moves with it — the
  // approval attaches to the bracket brightness, not to the slider position.
  assert.equal(AIRCRAFT_BRACKET_FLOOR_ANCHOR, KEYHOLE_OUTSIDE_OPACITY_DEFAULT,
    'the AIR bracket floor anchor tracks the default it calibrates against');

  // Reachability: the mapping was always continuous, but at the previous step
  // of 5 the whole sub-default range was one stop wide.
  assert.match(indexHtml, /id="detection-opacity-slider"[^>]*\sstep="1"/,
    'index.html: every integer percent is reachable from the handle');
});

test('an explicit OUTSIDE opacity still wins over the new default', () => {
  assert.equal(managerForHash('#lat=10&lon=20&ko=5').parseInitialHash().detectionOutsideOpacityPct, 5);
  assert.equal(managerForHash('#lat=10&lon=20&ko=40').parseInitialHash().detectionOutsideOpacityPct, 40);
  assert.equal(managerForHash('#lat=10&lon=20&ko=0').parseInitialHash().detectionOutsideOpacityPct, 0,
    'an explicit 0 is a choice too, not an absent field');

  // A link from before `ko` existed restores what ITS author saw. Every link
  // since carries the field explicitly, so the 5% era is unaffected either way.
  assert.equal(managerForHash('#lat=10&lon=20&style=normal').parseInitialHash().detectionOutsideOpacityPct, 5,
    'a pre-ko link restores the author\'s view, not the new default');
});

// ---------------------------------------------------------------------------
// 3. Detection — on for every style on a first run, Normal included
// ---------------------------------------------------------------------------

test('first run opens with detection on, in every style, using the one tactical preset', () => {
  // Normal used to start OFF while only CRT/NVG/FLIR auto-applied the preset.
  // It is now the baseline for all of them, reusing the SAME frozen object, so
  // "the tactical look" cannot fork into two definitions.
  assert.match(uiSource, /const MILITARY_DETECTION_PRESET = Object\.freeze\(\{ mode: 'dense', densityPct: 75 \}\);/,
    'the tactical look is still Dense @ 75%');
  const baseline = uiBlock('const GLOBAL_POST_DEFAULTS = {', '\n};');
  assert.match(baseline, /detectionMode: MILITARY_DETECTION_PRESET\.mode\.toUpperCase\(\),/,
    'the first-load baseline reads the preset rather than restating it');
  assert.match(baseline, /detectionDensity: MILITARY_DETECTION_PRESET\.densityPct,/,
    'density comes from the same object, so the two cannot drift');
  assert.doesNotMatch(baseline, /detectionMode: 'OFF'/,
    'the retired OFF baseline is gone, not shadowed');

  // `const` has no hoisted value: the baseline can only READ the preset if the
  // preset is declared first. Getting this backwards is a startup TDZ crash,
  // which no other test in the suite would reach.
  assert.ok(
    uiSource.indexOf('const MILITARY_DETECTION_PRESET =')
      < uiSource.indexOf('const GLOBAL_POST_DEFAULTS ='),
    'MILITARY_DETECTION_PRESET must be declared before the baseline that reads it',
  );
});

test('detection-on-by-default is a default, not an operator override', () => {
  // `_detectionUserOverridden` means the OPERATOR hand-edited detection, and it
  // suppresses the military-style auto-enable for the rest of the session.
  // A factory default is not that. If applying the baseline set the flag, a
  // fresh session would silently lose the style auto-enable behaviour — a
  // separate landed feature, taken out by an unrelated change.
  const applyDefaults = uiBlock('  _applyGlobalPostDefaults() {', '\n  }\n');
  assert.match(applyDefaults, /this\._setDetectionMode\(defaults\.detectionMode\)/,
    'the baseline still goes through the real detection path');
  assert.doesNotMatch(applyDefaults, /_detectionUserOverridden/,
    'applying a factory default must not impersonate an operator edit');

  // And the two halves of the override machinery are still wired: the style
  // preset consults the flag, and the detection button sets it.
  assert.match(uiSource, /if \(preset\.detection && !this\._detectionUserOverridden\) \{/,
    'a style preset still yields to an operator who changed detection by hand');
  const detectionButton = uiBlock("this._detectionBtn.addEventListener('click'", 'cycleDetectionMode()');
  assert.match(detectionButton, /this\._detectionUserOverridden = true;/,
    'and the detection control still claims the override when the operator uses it');

  // Style-switch semantics are unchanged: Normal is still not a preset owner,
  // so switching TO Normal does not re-apply or clear anything.
  const stylePresets = uiBlock('const STYLE_PRESET_DEFAULTS = {', '\n};');
  for (const style of ['retro', 'surveillance', 'thermal']) {
    assert.match(stylePresets, new RegExp(`\\n  ${style}: \\{`),
      `${style} still carries its own preset`);
  }
  assert.doesNotMatch(stylePresets, /\n {2}normal: \{/,
    'Normal gained a default, not a style preset — switching to it still touches nothing');
});

test('a share link that carries detection OFF still restores OFF', () => {
  // Same rule as the feather: the default governs a session that said nothing.
  const off = managerForHash('#lat=10&lon=20&dm=OFF&dd=50').parseInitialHash();
  assert.equal(off.detectionMode, 'OFF', 'an explicit OFF survives the default flip');

  const sparse = managerForHash('#lat=10&lon=20&dm=SPARSE&dd=25').parseInitialHash();
  assert.equal(sparse.detectionMode, 'SPARSE');
  assert.equal(sparse.detectionDensity, 25,
    'and a quieter explicit profile is not promoted to the new default');

  const dense = managerForHash('#lat=10&lon=20&dm=DENSE&dd=75').parseInitialHash();
  assert.equal(dense.detectionMode, 'DENSE');
  assert.equal(dense.detectionDensity, 75);
});
