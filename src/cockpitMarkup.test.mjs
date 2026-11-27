import { renderApplicationHtml } from './testSupport/applicationHtml.mjs';
import { createVisionState } from './ui/cockpitInstrumentState.js';
import { COCKPIT_VISION_MODES } from './cockpitVisionPolicy.js';
import { createBriefState } from './ui/cockpitBriefPages.js';
import { publishBriefView, setBriefAutoRotate } from './ui/cockpitBriefing.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const html = await renderApplicationHtml(
  fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'),
);

test('Cockpit has one reset action beside its bottom exit path', () => {
  assert.doesNotMatch(html, /id="cockpit-quick-entry"/);
  assert.doesNotMatch(html, /id="cockpit-exit"/);
  // The exit button's attributes, in whatever order the button renders them.
  const exit = html.match(
    /<button\b(?=[^>]*\sid="map-view-switch")([^>]*)>([\s\S]*?)<\/button>/,
  );
  assert.ok(exit, 'Cockpit exit is missing');
  assert.match(exit[1], /\saria-label="Exit cockpit view"/);
  assert.match(exit[1], /\saria-keyshortcuts="Escape"/);
  assert.match(exit[2], /close_fullscreen[\s\S]*?EXIT COCKPIT/);
  const topCenterActions = html.match(
    /<nav id="top-center-actions"[\s\S]*?<\/nav>/,
  );
  assert.ok(topCenterActions, 'Top-center globe actions are missing');
  assert.match(
    topCenterActions[0],
    /id="clear-selected-layers"[\s\S]*?id="share-btn"[\s\S]*?id="tilt-map-view"[\s\S]*?id="north-up-view"[\s\S]*?id="reset-globe-view"/,
  );
  assert.equal(
    (html.match(/id="clear-selected-layers"/g) || []).length,
    1,
    'Clear Layers must have one DOM owner',
  );
  assert.equal(
    (html.match(/id="reset-globe-view"/g) || []).length,
    1,
    'Reset Globe must have one DOM owner',
  );
  assert.equal(
    (html.match(/id="cockpit-reset-globe"/g) || []).length,
    1,
    'Cockpit Reset must have one DOM owner',
  );
  const viewSwitcher = html.match(/<nav id="view-switcher"[\s\S]*?<\/nav>/);
  assert.ok(viewSwitcher, 'View switcher is missing');
  assert.doesNotMatch(
    viewSwitcher[0],
    /id="reset-globe-view"/,
    'map-only reset must stay outside Cockpit',
  );
  // The reset button's attributes, in whatever order the button renders them.
  const reset = viewSwitcher[0].match(
    /<button\b(?=[^>]*\sid="cockpit-reset-globe")([^>]*)>([\s\S]*?)<\/button>/,
  );
  assert.ok(reset, 'Cockpit Reset is missing from the view switcher');
  assert.match(reset[1], /\stype="button"/);
  assert.match(reset[1], /\saria-label="Reset cockpit to full globe view"/);
  assert.match(reset[1], /\shidden(?=[\s>=]|$)/);
  assert.match(reset[2], /public[\s\S]*?RESET/);
  assert.ok(
    viewSwitcher[0].indexOf('id="map-view-switch"') > reset.index,
    'Cockpit Reset must sit before the exit button',
  );

  const actions = html.match(
    /<div class="global-context-actions"[\s\S]*?<\/div>/,
  );
  assert.ok(actions, 'Contact Context actions are missing');
  assert.ok(
    actions[0].indexOf('id="cockpit-entry"') <
      actions[0].indexOf('id="installations-search-btn"'),
    'Cockpit must precede Search Nearby Sites',
  );
});

test('Cockpit heading tape leaves the bottom exit row unobstructed', () => {
  const compass = html.match(
    /<div class="cockpit-compass"[\s\S]*?<div class="cockpit-position-readout">/,
  );
  assert.ok(compass, 'Cockpit compass markup is missing');
  assert.match(compass[0], /id="cockpit-speed-value"/);
  assert.match(compass[0], /id="cockpit-heading-value"/);
  assert.match(compass[0], /id="cockpit-altitude-value"/);
  assert.match(compass[0], /id="cockpit-compass-tape"/);
  assert.doesNotMatch(html, /cockpit-compass-label|>TRACK<\/span>/);
});

test('Cockpit vision cycle exposes every map preset exactly once', () => {
  assert.deepEqual(
    COCKPIT_VISION_MODES.map((mode) => createVisionState(mode).label),
    ['NORMAL', 'CRT', 'NVG', 'FLIR', 'ANIME', 'NOIR'],
  );
  assert.match(html, /id="cockpit-vision-current-label"[^>]*>NORMAL<\/strong>/);
});

test('Contacts uses the approved radar icon', () => {
  const button = html.match(
    /<button\b[^>]*\bid="global-context-flights-btn"[\s\S]*?<\/button>/,
  );
  assert.ok(button, 'Contacts button is missing');
  assert.match(
    button[0],
    /material-symbols-outlined"[^>]*aria-hidden="true">radar<\/span>/,
  );
});

test('Cockpit owns a focused shared Display portal and compact Radio controls', () => {
  assert.match(
    html,
    /id="cockpit-display-toggle-btn"[^>]*aria-controls="cockpit-display-panel"/,
  );
  assert.match(html, /id="cockpit-display-toggle-btn"[^>]*>◀<\/button>/);
  assert.match(
    html,
    /data-cockpit-launcher="display"[\s\S]*?id="cockpit-display-toggle-btn"/,
  );
  assert.match(html, /data-cockpit-display-slot="hud"/);
  assert.match(
    html,
    /data-cockpit-display-slot="detection"[\s\S]*?data-cockpit-display-slot="parameters"[\s\S]*?data-cockpit-display-slot="models3d"/,
  );
  assert.doesNotMatch(html, /data-cockpit-display-slot="presets"/);
  assert.match(
    html,
    /<button\b(?=[^>]*\bid="clear-selected-layers")[^>]*aria-label="Clear selected data layers"/,
  );
  assert.match(
    html,
    /<button\b(?=[^>]*\bid="reset-globe-view")[^>]*aria-label="Reset to full globe view"/,
  );
  assert.equal(
    (html.match(/id="hud-toggle"/g) || []).length,
    1,
    'HUD control must have one stateful DOM owner',
  );
  assert.equal(
    (html.match(/id="detection-toggle"/g) || []).length,
    1,
    'Detection control must have one stateful DOM owner',
  );
  assert.equal(
    (html.match(/id="models3d-toggle"/g) || []).length,
    1,
    '3D control must have one stateful DOM owner',
  );
  assert.doesNotMatch(html, /id="cockpit-(?:hud|detection|models3d)-toggle"/);
  assert.match(
    html,
    /id="cockpit-radio-toggle-btn"[^>]*aria-controls="cockpit-radio-panel"/,
  );
  assert.match(html, /id="cockpit-radio-toggle-btn"[^>]*>◀<\/button>/);
  assert.match(
    html,
    /data-cockpit-launcher="radio"[\s\S]*?id="cockpit-radio-toggle-btn"/,
  );
  const cockpitRadio = html.match(
    /id="cockpit-radio-panel"[\s\S]*?<\/div>\s*<\/div>\s*<div class="cockpit-utility-rail/,
  );
  assert.ok(cockpitRadio, 'Cockpit compact Radio controls are missing');
  assert.doesNotMatch(cockpitRadio[0], /radio-filter|radio-tuner/);
  assert.doesNotMatch(
    html,
    /id="stack-panel"/,
    'the retired Map Stack panel must not remain in Cockpit layout',
  );
});

test('Visual orders Parameters below Detection, 3D below them, and Clean UI above the Effects', () => {
  const display = html.match(/id="pp-toggles"[\s\S]*?id="clean-view-exit"/);
  assert.ok(display, 'Display markup is missing');
  assert.match(
    display[0],
    /id="detection-toggle"[\s\S]*?id="param-slider-panel"[\s\S]*?id="models3d-toggle"[\s\S]*?id="scope-toggle"[\s\S]*?id="clean-view-toggle"[\s\S]*?class="pp-section-heading">Effects<[\s\S]*?id="celestial-toggle"/,
  );
  assert.equal(
    (html.match(/id="param-slider-panel"/g) || []).length,
    1,
    'Parameters must have one DOM owner',
  );
  // The markup places Parameters below Detection; nothing re-homes it.
  assert.match(
    html,
    /id="detection-toggle"[\s\S]*?id="param-slider-panel"[\s\S]*?id="models3d-toggle"/,
  );
});

test('Cockpit Display portals shared HUD, Detection, Parameters, and 3D controls', () => {
  assert.equal((html.match(/class="visual-presets"/g) || []).length, 1);
  assert.equal((html.match(/id="param-slider-panel"/g) || []).length, 1);
  assert.match(
    html,
    /data-cockpit-display-slot="detection"[\s\S]*?data-cockpit-display-slot="parameters"[\s\S]*?data-cockpit-display-slot="models3d"/,
  );
});

test('cockpit route direction uses self-contained vector artwork, not a font ligature', () => {
  const match = html.match(/<div id="cockpit-route-direction"[\s\S]*?<\/div>/);
  assert.ok(match, 'cockpit route-direction markup is missing');
  assert.match(match[0], /<svg class="cockpit-route-chevron"/);
  assert.match(match[0], /<path d="[^"]+"/);
  assert.doesNotMatch(match[0], />navigation</);
  assert.doesNotMatch(match[0], /material-icons-round/);
});

test('cockpit weather control is off before JavaScript restores an explicit opt-in', () => {
  const match = html.match(
    /<button[^>]*\sid="cockpit-weather-toggle"[\s\S]*?<\/button>/,
  );
  assert.ok(match, 'cockpit weather toggle markup is missing');
  assert.match(match[0], /aria-label="Enable cockpit weather effects"/);
  assert.match(match[0], /aria-pressed="false"/);
  assert.match(match[0], /id="cockpit-weather-state">OFF</);
});

test('cockpit summary presents the focused item as Contact', () => {
  const match = html.match(/<aside id="cockpit-context"[\s\S]*?<\/aside>/);
  assert.ok(match, 'cockpit Contact summary is missing');
  assert.match(match[0], /aria-label="Contact cockpit summary"/);
  assert.match(
    match[0],
    /class="cockpit-card-kicker cockpit-context-kicker">CONTACT</,
  );
  assert.match(match[0], /aria-label="Contact navigation"/);
  assert.match(
    match[0],
    /aria-label="Previous — prior visited contact in the 250 km window"/,
  );
  assert.match(
    match[0],
    /aria-label="Next — nearest unvisited contact in the 250 km window"/,
  );
  assert.match(match[0], /aria-label="Collapse Contact panel"/);
  assert.doesNotMatch(match[0], />GLOBAL CONTEXT</);
});

test('Cockpit Contact navigation omits the redundant Focus camera action', () => {
  assert.match(html, /id="cockpit-context-previous"/);
  assert.match(html, /id="cockpit-context-next"/);
  assert.doesNotMatch(html, /id="cockpit-context-focus"/);
});

test('Global Context names its mixed contact cycle without changing the stable mode id', () => {
  const match = html.match(
    /<button\b[^>]*\bid="global-context-flights-btn"[\s\S]*?<\/button>/,
  );
  assert.ok(match, 'Global Context contacts button is missing');
  assert.match(match[0], />CONTACTS</);
  assert.match(match[0], /aria-label="CONTACTS"/);
  assert.match(
    match[0],
    /title="Cycles the nearest contacts of whatever type you select — planes, vessels, installations\. Satellites track independently\."/,
  );
  assert.doesNotMatch(match[0], />FLIGHTS</);
});

test('Global Context and Space Missions keep their own panels', () => {
  assert.match(html, /id="global-context-panel"/);
  assert.match(html, /id="global-context-flights-btn"/);
  assert.doesNotMatch(html, /id="global-context-missions-btn"/);
  assert.match(html, /id="space-missions-panel"/);
});

test('Global Context standby describes Contacts', () => {
  const match = html.match(/<div id="context-mode-standby"[\s\S]*?<\/div>/);
  assert.ok(match, 'Global Context standby is missing');
  assert.match(match[0], /CONTACTS — nearest planes · vessels · sites/);
  assert.doesNotMatch(match[0], /SPACE MISSIONS/);
});

test('cockpit briefing cycle control keeps its state as the accessible name', () => {
  const match = html.match(
    /<button[^>]*\sid="cockpit-brief-auto"[\s\S]*?<\/button>/,
  );
  assert.ok(match, 'cockpit briefing cycle toggle is missing');
  assert.match(match[0], /aria-label="CYCLE OFF"/);
  assert.match(match[0], /aria-pressed="false"/);
  assert.match(match[0], />CYCLE OFF<\/button>/);
  assert.match(
    match[0],
    /title="Cycle briefing pages automatically every 9 seconds \(Signals → News → Local\)\./,
  );

  // The presented label is the state; the help is only the tooltip.
  const views = [];
  const owner = {
    brief: createBriefState(),
    publishBrief: (view) => views.push(view),
    publishBriefView,
    startBriefRotation() {},
    stopBriefRotation() {},
  };
  setBriefAutoRotate.call(owner, true);
  assert.equal(views.at(-1).autoLabel, 'CYCLE ON');
  assert.equal(views.at(-1).autoRotate, true);
  assert.match(views.at(-1).autoHelp, /^Stop automatic page cycling\./);
  setBriefAutoRotate.call(owner, false);
  assert.equal(views.at(-1).autoLabel, 'CYCLE OFF');
  assert.match(views.at(-1).autoHelp, /^Cycle briefing pages automatically/);
});

test('Contact folded for one Cockpit left panel comes back only once neither is open', async () => {
  const { PanelChrome } = await import('./ui/panelChrome.js');
  const previous = globalThis.document;
  const panels = {};
  globalThis.document = { getElementById: (id) => panels[id] ?? null };
  const panel = (...classes) => ({
    classList: { contains: (name) => classes.includes(name) },
  });
  try {
    const otherOpen = (id) =>
      PanelChrome.prototype._otherCockpitLeftPanelOpen(id);
    panels['data-panel'] = panel('collapsed');
    assert.equal(
      otherOpen('utilities-panel'),
      false,
      'Data Layers closed: restore',
    );
    panels['data-panel'] = panel('collapsed', 'layout-auto-collapsed');
    assert.equal(
      otherOpen('utilities-panel'),
      true,
      'Data Layers comes back: keep Contact folded',
    );
    panels['data-panel'] = panel();
    assert.equal(
      otherOpen('utilities-panel'),
      true,
      'Data Layers open: keep it folded',
    );
  } finally {
    globalThis.document = previous;
  }
});
