import { expandApplicationHtml } from '../build/application-html.js';
import { readLayerSource } from './testSupport/readLayerSource.mjs';
import { PanelLayoutController } from './ui/panelLayoutController.js';
import { readShellElements } from './ui/shellElements.js';
import { readStylesheet } from './testSupport/readStylesheet.mjs';
import { SceneControls } from './ui/sceneControls.js';
import { isRenderedOnScreen } from './ui/cockpitPresentation.js';
import { onKeyDown as cockpitKeyDown } from './ui/cockpitInput.js';
import { enter as cockpitEnter, exit as cockpitExit, readAircraftInfo, _adoptTrackedEntity } from './ui/cockpitTrackingController.js';
import { setVisionMode, cycleVisionMode } from './ui/cockpitInstruments.js';
import { updateContext as cockpitContext } from './ui/cockpitContext.js';
import { syncSignalLayout, setContextCollapsed, setSignalCollapsed } from './ui/cockpitLayout.js';
import { setBriefAutoRotate } from './ui/cockpitBriefing.js';
import { CockpitDisplayPortal } from './ui/cockpitDisplayPortal.js';
import { _handleContextLayerChange } from './ui/contextLayerChanges.js';
import { clearSelectedLayers } from './ui/contextActions.js';
import { _selectContextMode } from './ui/contextTransactions.js';
import { _restoreContextSession } from './ui/contextSession.js';
import { readFileSync as readRadioSource } from 'node:fs';
const radioBindings = readRadioSource(new URL('./ui/radioBindings.js', import.meta.url), 'utf8');
const radioPresentation = readRadioSource(new URL('./ui/radioPresentation.js', import.meta.url), 'utf8');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const html = expandApplicationHtml(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
const ui = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'applicationShell.js'), 'utf8');
const css = readStylesheet(path.join(ROOT, 'style.css'));
const sceneDirector = fs.readFileSync(path.join(ROOT, 'src', 'scenes', 'director.js'), 'utf8');
const manager = fs.readFileSync(path.join(ROOT, 'src', 'data', 'manager.js'), 'utf8');
const contextLayer = readLayerSource(path.join(ROOT, 'src', 'data', 'militaryAwareness.js'), 'utf8');
const voiceActions = fs.readFileSync(path.join(ROOT, 'src', 'voice', 'gevActions.js'), 'utf8');

test('Cockpit has one reset action beside its bottom exit path', () => {
  assert.doesNotMatch(html, /id="cockpit-quick-entry"/);
  assert.doesNotMatch(html, /id="cockpit-exit"/);
  assert.match(
    html,
    /id="map-view-switch"[^>]*aria-label="Exit cockpit view"[^>]*aria-keyshortcuts="Escape C"[\s\S]*?close_fullscreen[\s\S]*?EXIT COCKPIT/,
  );
  const topCenterActions = html.match(/<nav id="top-center-actions"[\s\S]*?<\/nav>/);
  assert.ok(topCenterActions, 'Top-center globe actions are missing');
  assert.match(topCenterActions[0], /id="clear-selected-layers"[\s\S]*?id="share-btn"[\s\S]*?id="tilt-map-view"[\s\S]*?id="north-up-view"[\s\S]*?id="reset-globe-view"/);
  assert.equal((html.match(/id="clear-selected-layers"/g) || []).length, 1, 'Clear Layers must have one DOM owner');
  assert.equal((html.match(/id="reset-globe-view"/g) || []).length, 1, 'Reset Globe must have one DOM owner');
  assert.equal((html.match(/id="cockpit-reset-globe"/g) || []).length, 1, 'Cockpit Reset must have one DOM owner');
  const viewSwitcher = html.match(/<nav id="view-switcher"[\s\S]*?<\/nav>/);
  assert.ok(viewSwitcher, 'View switcher is missing');
  assert.doesNotMatch(viewSwitcher[0], /id="reset-globe-view"/, 'map-only reset must stay outside Cockpit');
  assert.match(
    viewSwitcher[0],
    /id="cockpit-reset-globe"[^>]*type="button"[^>]*aria-label="Reset cockpit to full globe view"[^>]*hidden[\s\S]*?public[\s\S]*?RESET[\s\S]*?id="map-view-switch"/,
  );

  const actions = html.match(/<div class="global-context-actions"[\s\S]*?<\/div>/);
  assert.ok(actions, 'Contact Context actions are missing');
  assert.ok(
    actions[0].indexOf('id="cockpit-entry"') < actions[0].indexOf('id="installations-search-btn"'),
    'Cockpit must precede Search Nearby Sites',
  );
  assert.match(
    css,
    /body\.cockpit-mode #view-switcher \{[\s\S]*?bottom: max\(clamp\(128px, 15vh, 150px\), env\(safe-area-inset-bottom\)\);[\s\S]*?margin-bottom: -95px;/,
    'Cockpit exit must retain the owner-approved bottom-center position',
  );
  assert.match(
    css,
    /body\.cockpit-mode #view-switcher \{[\s\S]*?display:\s*flex;[\s\S]*?max-width:\s*calc\(100vw - 24px\);[\s\S]*?justify-content:\s*center;/,
    'Cockpit Reset and Exit must share one bounded bottom-center row',
  );
});

test('Cockpit heading tape leaves the bottom exit row unobstructed', () => {
  const compass = html.match(/<div class="cockpit-compass"[\s\S]*?<div class="cockpit-position-readout">/);
  assert.ok(compass, 'Cockpit compass markup is missing');
  assert.match(compass[0], /id="cockpit-speed-value"/);
  assert.match(compass[0], /id="cockpit-heading-value"/);
  assert.match(compass[0], /id="cockpit-altitude-value"/);
  assert.match(compass[0], /id="cockpit-compass-tape"/);
  assert.doesNotMatch(html, /cockpit-compass-label|>TRACK<\/span>/);
  assert.doesNotMatch(css, /cockpit-compass-label/);
});

test('Cockpit vision cycle exposes exactly five real visual styles without NONE', () => {
  assert.match(cycleVisionMode.toString(), /const modes = COCKPIT_VISION_MODES;/);
  assert.match(setVisionMode.toString(), /const labels = \{\s*optical: inherited,\s*crt: 'CRT',\s*nvg: 'NVG',\s*thermal: 'FLIR',\s*noir: 'NOIR',?\s*\};/);
  assert.doesNotMatch(setVisionMode.toString(), /none: 'NONE'/);
  assert.match(ui, /getInheritedVisionLabel: \(\) =>\s*\(?[\s\S]*?STYLE_STATUS_LABELS\[this\.activeStyle\]/);
  assert.match(html, /id="cockpit-vision-current-label"[^>]*>NORMAL<\/strong>/);
  assert.match(ui, /const target = applyCockpitVisionStageIntensities\(\s*this\.stages,\s*next,\s*this\._cockpitVisionRestore,?\s*\);/);
  assert.match(ui, /this\._cockpitVisionRestore = captureCockpitVisionBaseline\(\s*this\.stages,\s*this\.transitions,?\s*\);/);
  assert.match(
    ui,
    /if \(next === 'optical'\) \{[\s\S]*?applyCockpitVisionStageIntensities\(\s*this\.stages,\s*next,\s*this\._cockpitVisionRestore,?\s*\);[\s\S]*?return;[\s\S]*?const target = applyCockpitVisionStageIntensities/,
    'the inherited entry must restore the map shader while CRT, NVG, FLIR, and NOIR remain temporary Cockpit overrides',
  );
  assert.match(
    ui,
    /_syncCockpitInheritedStyle\(\)[\s\S]*?name === this\.activeStyle \? 1 : 0[\s\S]*?this\.transitions\.delete\(name\)[\s\S]*?setVisionMode\(this\.cockpitView\.visionMode\)/,
    'changing the map preset in Cockpit must refresh both the inherited label and restore baseline',
  );
  assert.match(ui, /setStyle\([\s\S]*?this\._syncCockpitInheritedStyle\(\);/);
});

test('Contacts uses the approved radar icon', () => {
  const button = html.match(/<button id="global-context-flights-btn"[\s\S]*?<\/button>/);
  assert.ok(button, 'Contacts button is missing');
  assert.match(button[0], /material-symbols-outlined" aria-hidden="true">radar<\/span>/);
});

test('Cockpit Escape handling precedes form-control shortcut suppression and focus is restored', () => {
  const keydown = cockpitKeyDown.toString();
  assert.ok(keydown, 'Cockpit keyboard handler is missing');
  const escapeIndex = keydown.indexOf("event.key === 'Escape'");
  const formGuardIndex = keydown.indexOf("closest?.('input, textarea, select, [contenteditable]')");
  assert.ok(escapeIndex >= 0 && formGuardIndex > escapeIndex, 'Escape must work while focus is inside a form control');

  const enter = cockpitEnter.toString();
  const exit = cockpitExit.toString();
  assert.ok(enter && exit, 'Cockpit entry/exit methods are missing');
  assert.match(enter, /activeElement/);
  assert.match(enter, /mapViewButton.*focus|focus.*mapViewButton/s);
  assert.match(exit, /focus\(\{ preventScroll: true \}\)/);
  assert.match(exit, /this\.restoreTrackingFrame\(entity\)/);
  assert.doesNotMatch(exit, /applyTrackedCameraFrame/);
  assert.match(
    ui,
    /restoreTrackingFrame: \(entity\) => \{[\s\S]*?gevTrackedId[\s\S]*?flightsLayer\.refocusTrackedById[\s\S]*?militaryFlightsLayer\.refocusTrackedById/,
    'Cockpit exit must return camera-frame ownership through the source layer so Contact Focus cannot accumulate a second owner',
  );
});

test('Cockpit shortcut failures do not leak and open Radio owns the first Escape', () => {
  const keydown = cockpitKeyDown.toString();
  assert.ok(keydown, 'Cockpit keyboard handler is missing');
  assert.match(keydown, /document\s*\.getElementById\('context-radio-dock'\)\s*\?\.classList\.contains\('disclosure-open'\)/);
  assert.match(keydown, /#cockpit-utility-controls \[aria-expanded="true"\]/);
  assert.match(
    keydown,
    /const cockpitAttempt = !!\(\s*this\.readAircraftInfo\(\) && this\.viewer\.trackedEntity\?\.position\s*\);[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopImmediatePropagation\(\);[\s\S]*?!this\.isEntryAllowed\(\)/,
  );
});

test('the Contact panel never hides itself out from under its own NEXT button', () => {
  const updateContext = cockpitContext.toString();
  assert.ok(updateContext, 'Cockpit updateContext is missing');
  const body = updateContext;
  // Pin the real presentation owner to the readout policy: PREVIOUS/NEXT
  // remains reachable unless no Context snapshot exists at all.
  assert.match(body, /resolveCockpitContextReadout\(\{ snapshot, info \}\)/);
  assert.match(body, /if \(!readout\.visible\) \{[\s\S]*?this\.context\.hidden = true;/);
  assert.equal(
    (body.match(/this\.context\.hidden = true/g) || []).length,
    1,
    'the panel has exactly one hide path, and it is the no-snapshot standby case',
  );
  assert.doesNotMatch(
    body,
    /snapshot\.subject\?\.layerId !== info\.layerId/,
    'subject identity must never gate panel visibility again',
  );
  // A foreign subject dashes the nose-relative arrow/bearing only.
  assert.match(body, /readout\.aircraftRelative/);
  assert.match(body, /'BRG —'/);
  // A culled subject holds last-known content behind the CONTACT LOST cue.
  assert.match(body, /readout\.contactLost/);
  assert.match(body, /CONTACT LOST/);
  assert.match(body, /this\.context\.dataset\.state = 'lost'/);
  assert.match(body, /if \(readout\.contactLost\) \{/, 'the CONTACT LOST branch is missing');
  // PREVIOUS/NEXT must be written before any early return, so the operator can
  // always step off the current contact — including a lost one.
  const navIndex = body.indexOf('this.contextNext.disabled');
  const lostIndex = body.indexOf('if (readout.contactLost)');
  assert.ok(navIndex >= 0 && lostIndex > navIndex, 'nav state must be written before the CONTACT LOST return');
  assert.equal(
    (body.match(/this\.contextNext\.disabled/g) || []).length,
    1,
    'one owner for the NEXT enabled state, reached by every visible path',
  );
  assert.match(
    css,
    /\.cockpit-context-window\[data-state='lost'\]/,
    'CONTACT LOST reuses the panel-level data-state cue that "uncertain" already uses',
  );
});

test('the cockpit reads its aircraft from the layer that owns Cesium tracking', () => {
  const read = readAircraftInfo.toString();
  assert.ok(read, 'readAircraftInfo is missing');
  assert.match(read, /resolveTrackedAircraftInfo\(\{/);
  assert.match(read, /gevTrackedId/);
  // In cockpit mode the controller moves the entity off viewer.trackedEntity,
  // so its own handle is the tracked identity there.
  assert.match(read, /this\.viewer\?\.trackedEntity \|\| this\.trackedEntity/);
});

test('programmatic Context layer changes cannot bypass explicit expansion policy', () => {
  assert.doesNotMatch(_handleContextLayerChange.toString(), /setPanelCollapsed\('global-context-panel', false\)/);
});

test('share startup isolates panel defaults from recipient-local collapse preferences', () => {
  const parseIndex = ui.indexOf('this._initialShareState = this.shareLinkManager.parseInitialHash();');
  const panelChromeIndex = ui.indexOf('this._initPanelChrome();');
  assert.ok(parseIndex >= 0, 'initial share state must be parsed during UI construction');
  assert.ok(
    parseIndex < panelChromeIndex,
    'share state must be known before panel chrome can read recipient-local preferences',
  );
  assert.equal(
    (ui.match(/this\.shareLinkManager\.parseInitialHash\(\)/g) || []).length,
    1,
    'startup must parse the incoming share exactly once',
  );
  const panelChrome = ui.match(/_initPanelChrome\(\) \{([\s\S]*?)\n  \}\n\n  \/\*\*/);
  assert.ok(panelChrome, 'panel chrome initializer is missing');
  assert.match(
    panelChrome[1],
    /_restorePanelCollapsedState\(targetId, \{[\s\S]*?allowStored: !this\._initialShareState/,
    'valid shares must use deterministic markup defaults before applying encoded panel state',
  );
});

test('Cockpit owns a focused shared Display portal and compact Radio controls', () => {
  const hiddenRule = css.match(/body\.cockpit-mode\s*:is\(([^)]*)\)\s*\{\s*display:\s*none\s*!important;/);
  assert.ok(hiddenRule, 'Cockpit hidden-chrome rule is missing');
  assert.match(css, /body\.cockpit-mode #right-context-rail\s*\{\s*display:\s*none\s*!important;/);
  assert.match(css, /body\.cockpit-mode #left-panel-stack > #scene-panel\s*\{\s*display:\s*none\s*!important;/);
  assert.match(html, /id="cockpit-display-toggle-btn"[^>]*aria-controls="cockpit-display-panel"/);
  assert.match(html, /id="cockpit-display-toggle-btn"[^>]*>◀<\/button>/);
  assert.match(html, /data-cockpit-launcher="display"[\s\S]*?id="cockpit-display-toggle-btn"/);
  assert.match(html, /data-cockpit-display-slot="hud"/);
  assert.match(html, /data-cockpit-display-slot="detection"[\s\S]*?data-cockpit-display-slot="parameters"[\s\S]*?data-cockpit-display-slot="models3d"/);
  assert.doesNotMatch(html, /data-cockpit-display-slot="presets"/);
  assert.match(html, /id="clear-selected-layers"[^>]*aria-label="Clear selected data layers"/);
  assert.match(html, /id="reset-globe-view"[^>]*aria-label="Reset to full globe view"/);
  assert.match(css, /#top-center-actions\s*\{[\s\S]*?left:\s*50%;[\s\S]*?display:\s*flex;[\s\S]*?transform:\s*translateX\(-50%\)/);
  assert.match(css, /body\.ui-clean-view #top-center-actions/);
  assert.match(css, /body\.recording-mode #top-center-actions/);
  assert.match(
    css,
    /body\.scene-playback-mode\s*:is\([\s\S]*?#clear-selected-layers,[\s\S]*?#tilt-map-view,[\s\S]*?#north-up-view,[\s\S]*?#reset-globe-view[\s\S]*?\)\s*\{\s*display:\s*none !important;/,
  );
  assert.match(sceneDirector, /this\._running = true;\s*this\._setPlaybackActive\(true\);/);
  assert.match(sceneDirector, /styleManager\.setRecordingMode\(false\);\s*this\._setPlaybackActive\(false\);/);
  assert.match(SceneControls.prototype.setPlaybackActive.toString(), /document\.body\.classList\.toggle\('scene-playback-mode', active\)/);
  assert.equal((html.match(/id="hud-toggle"/g) || []).length, 1, 'HUD control must have one stateful DOM owner');
  assert.equal((html.match(/id="detection-toggle"/g) || []).length, 1, 'Detection control must have one stateful DOM owner');
  assert.equal((html.match(/id="models3d-toggle"/g) || []).length, 1, '3D control must have one stateful DOM owner');
  assert.doesNotMatch(html, /id="cockpit-(?:hud|detection|models3d)-toggle"/);
  assert.match(html, /id="cockpit-radio-toggle-btn"[^>]*aria-controls="cockpit-radio-panel"/);
  assert.match(html, /id="cockpit-radio-toggle-btn"[^>]*>◀<\/button>/);
  assert.match(html, /data-cockpit-launcher="radio"[\s\S]*?id="cockpit-radio-toggle-btn"/);
  const cockpitRadio = html.match(/id="cockpit-radio-panel"[\s\S]*?<\/div>\s*<\/div>\s*<\/aside>/);
  assert.ok(cockpitRadio, 'Cockpit compact Radio controls are missing');
  assert.doesNotMatch(cockpitRadio[0], /context-radio-details-btn|radio-filter|radio-tuner/);
  assert.match(css, /\.cockpit-utility-controls[\s\S]*?top:\s*var\(\s*--cockpit-utility-top/);
  assert.match(css, /\[data-cockpit-launcher='display'\]\s*\{\s*width:\s*var\(\s*--left-collapsed-width, 176px\)/);
  assert.match(css, /--display-panel-expanded-width:\s*272px/);
  assert.match(css, /#pp-toggles\s*\{[\s\S]*?--pp-expanded-width:\s*var\(\s*--display-panel-expanded-width\)/);
  assert.match(css, /is-expanded:has\(\[data-cockpit-launcher='display'\]\)\s*\{[\s\S]*?width:\s*var\(\s*--display-panel-expanded-width\)/);
  assert.doesNotMatch(ui, /--cockpit-display-expanded-width|dataPanelWidth/);
  assert.match(css, /is-expanded:has\(\[data-cockpit-launcher='display'\]\)[\s\S]*?box-shadow:\s*0 8px 32px rgba\(0, 0, 0, 0\.42\)/);
  assert.match(css, /\.cockpit-utility-control\.is-expanded \.cockpit-utility-launcher\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/);
  assert.match(css, /\.cockpit-utility-control\.is-expanded \.cockpit-utility-divider\s*\{[\s\S]*?linear-gradient\(\s*90deg,\s*rgb\(0 212 255 \/ 28%\),\s*rgba\(0, 212, 255, 0\.18\) 58%,\s*transparent\s*\)[\s\S]*?box-shadow:\s*0 0 7px rgba\(0, 212, 255, 0\.22\);/);
  assert.match(radioBindings, /this\._cockpitDisplayToggleBtn\.textContent = displayOpen \? '▶' : '◀';/);
  assert.match(radioBindings, /this\._cockpitRadioToggleBtn\.textContent = radioOpen \? '▶' : '◀';/);
  assert.match(css, /#cockpit-display-panel\s*\{[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*7px;[\s\S]*?padding:\s*0;[\s\S]*?border-top:\s*0;/);
  assert.doesNotMatch(ui, /--cockpit-display-tab-width/);
  // These two widths size Cockpit Radio and nothing else. They were named for
  // the Map Stack panel that once shared them; a Radio-specific name is what
  // keeps a later Map Stack cleanup from silently resizing Radio.
  assert.match(css, /--cockpit-radio-collapsed-width:\s*148px/);
  assert.match(css, /--cockpit-radio-expanded-width:\s*232px/);
  assert.doesNotMatch(css, /--map-stack-(?:collapsed|expanded)-width/);
  assert.doesNotMatch(html, /id="stack-panel"/, 'the retired Map Stack panel must not remain in Cockpit layout');
  assert.match(css, /\[data-cockpit-launcher='radio'\]\s*\{\s*width:\s*var\(\s*--cockpit-radio-collapsed-width, 148px\)/);
  assert.match(css, /is-expanded:has\(\[data-cockpit-launcher='radio'\]\)[\s\S]*?--cockpit-radio-expanded-width/);
  assert.doesNotMatch(ui, /--cockpit-radio-tab-width/);
  assert.doesNotMatch(css, /\.cockpit-utility-launcher:hover/);
  const desktopUtilityCss = css.slice(
    css.indexOf('.cockpit-utility-controls {'),
    css.indexOf('@media (max-width: 760px)', css.indexOf('.cockpit-utility-controls {')),
  );
  assert.doesNotMatch(
    desktopUtilityCss,
    /\.cockpit-utility-controls:has\(\.cockpit-utility-control\.is-expanded\)/,
  );
  assert.match(css, /\.cockpit-utility-controls\.layout-primary-only[\s\S]*?display:\s*none/);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*?\.cockpit-utility-controls:has\(\.cockpit-utility-control\.is-expanded\)[\s\S]*?display:\s*none/);
  assert.match(syncSignalLayout.toString(), /resolveCockpitUtilityLayout\(\{\s*availableHeight,\s*expandedHeight,\s*collapsedHeight,?\s*\}\)/);
  assert.match(syncSignalLayout.toString(), /setAttribute\('aria-hidden', String\(hiddenSibling\)\)/);
});

test('Display orders 3D above Celestial, Clean UI below it, and Parameters below Detection', () => {
  const display = html.match(/id="pp-toggles"[\s\S]*?id="clean-view-exit"/);
  assert.ok(display, 'Display markup is missing');
  assert.match(
    display[0],
    /id="detection-toggle"[\s\S]*?id="param-slider-panel"[\s\S]*?id="models3d-toggle"[\s\S]*?id="celestial-toggle"[\s\S]*?id="clean-view-toggle"/,
  );
  assert.equal((html.match(/id="param-slider-panel"/g) || []).length, 1, 'Parameters must have one DOM owner');
  assert.match(
    PanelLayoutController.prototype._initRightPanelAdaptiveLayout.toString(),
    /const detectionGroup = this\._detectionBtn\?\.closest\('\.pp-toggle-group'\);[\s\S]*?detectionGroup\.after\(this\._sliderPanel\)/,
  );
  assert.match(
    ui,
    /\['detection', this\._detectionBtn\?\.closest\('\.pp-toggle-group'\)\],[\s\S]*?\['parameters', this\._sliderPanel\],[\s\S]*?\['models3d'/,
  );
  assert.doesNotMatch(ui, /\['presets',/);
});

test('Clear Selected Layers uses one adopted batch and discards Context restoration state', () => {
  assert.match(manager, /async clearSelectedLayers\([\s\S]*?\.filter\(\(\[, entry\]\) => this\._effectiveEnabled\(entry\)\)[\s\S]*?\.reverse\(\)/);
  assert.match(
    manager,
    /for \(const \{ layerId, intentEpoch \} of targets\)[\s\S]*?visibilityIntentEpoch !== intentEpoch[\s\S]*?await this\.setEnabled\(layerId, false/,
  );
  assert.match(clearSelectedLayers.toString(), /if \(this\._clearSelectedLayersPromise\) return this\._clearSelectedLayersPromise/);
  assert.match(_selectContextMode.toString(), /async function _selectContextMode\([\s\S]*?if \(this\._clearSelectedLayersPromise\) return false/);
  assert.match(clearSelectedLayers.toString(), /this\._contextModeGeneration[\s\S]*?this\._contextSessionSnapshot = null;[\s\S]*?this\._contextRestoreState = null;/);
  assert.match(clearSelectedLayers.toString(), /if \(this\._contextRestoreState\) this\._contextRestoreState\.cancelled = true/);
  assert.match(_restoreContextSession.toString(), /if \(restoreState\.cancelled\) return;[\s\S]*?settleContextIntentReplay/);
  assert.match(radioPresentation, /!this\.actions\.preservePanelStateDuringClear\(\)[\s\S]*?this\.actions\.setPanelCollapsed\('radio-panel', true\)/);
  assert.match(clearSelectedLayers.toString(), /this\._userFacingContextNotificationTokens\.add\(notificationToken\)/);
});

test('Cockpit Display portal retains both scroll owners across round trips', () => {
  const portal = CockpitDisplayPortal.toString();
  assert.match(portal, /this\.standardScrollTop = standardPanel\?\.scrollTop \|\| 0/);
  assert.match(portal, /this\.cockpitScrollTop = cockpitPanel\?\.scrollTop \|\| 0/);
  assert.match(portal, /if \(!this\.active\)[\s\S]*?this\.standardScrollTop = standardPanel\.scrollTop/);
  assert.match(portal, /if \(this\.active\)[\s\S]*?this\.cockpitScrollTop = cockpitPanel\.scrollTop/);
  assert.match(portal, /this\.cockpitPanel\.scrollTop = this\.cockpitScrollTop[\s\S]*?this\.standardPanel\.scrollTop = this\.standardScrollTop/);
});

test('Cockpit side surfaces behave as two single-expanded accordions', () => {
  assert.match(radioBindings,
    /if \(displayOpen \|\| radioOpen\) this\.actions\.setSignalCollapsed\(true\);/,
  );
  assert.match(radioBindings,
    /'gev:cockpit-signal-expanded'[\s\S]*?setCockpitDisclosure\('display', false\);/,
  );
  assert.match(radioBindings,
    /'gev:cockpit-context-expanded'[\s\S]*?setPanelCollapsed\('data-panel', true\);/,
  );
  assert.match(
    ui,
    /!nextCollapsed\s*&&\s*this\.cockpitView\?\.active\s*&&\s*panelId === 'data-panel'[\s\S]*?_cockpitContextCollapsedForDataPanel =\s*!this\.cockpitView\.contextCollapsed[\s\S]*?this\.cockpitView\.setContextCollapsed\(true\);/,
  );
  assert.match(
    ui,
    /nextCollapsed\s*&&\s*this\.cockpitView\?\.active\s*&&\s*panelId === 'data-panel'[\s\S]*?_cockpitContextCollapsedForDataPanel[\s\S]*?this\.cockpitView\.setContextCollapsed\(false\);/,
    'closing Data Layers must restore Contact only after an automatic collapse',
  );
  assert.match(setContextCollapsed.toString(),
    /const wasCollapsed = this\.contextCollapsed;[\s\S]*?this\.active && wasCollapsed && !this\.contextCollapsed[\s\S]*?'gev:cockpit-context-expanded'/,
    'Contact expansion must notify only on a collapsed-to-expanded transition',
  );
  assert.match(setSignalCollapsed.toString(),
    /const wasCollapsed = this\.signalCollapsed;[\s\S]*?this\.active && wasCollapsed && !this\.signalCollapsed[\s\S]*?'gev:cockpit-signal-expanded'/,
    'Live Signals expansion must notify only on a collapsed-to-expanded transition',
  );
  assert.match(
    setSignalCollapsed.toString(),
    /setSignalCollapsed\(collapsed, \{ user = false \} = \{\}\)[\s\S]*?if \(user\) this\.signalUserCollapsed = this\.signalCollapsed/,
  );
  assert.match(
    radioBindings,
    /!displayOpen\s*&&\s*!radioOpen[\s\S]*?this\.actions\.isCockpitActive\(\)[\s\S]*?!this\.actions\.signalUserCollapsed\(\)[\s\S]*?setSignalCollapsed\(false\)/,
    'Live Signals should reopen only after both utility panels close and no manual collapse is retained',
  );
  assert.match(
    radioBindings,
    /event\.target\?\.closest\?\.\('#left-panel-stack, #cockpit-context'\)\)\s*return;[\s\S]*?setCockpitDisclosure\('display', false\);/,
    'left-side interactions must not collapse the independent Cockpit utilities',
  );
});

test('fresh Cockpit entry temporarily collapses map panels and exit restores their exact layout', () => {
  const entryPanels = ui.match(
    /const COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object\.freeze\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(entryPanels, 'Cockpit entry panel list is missing');
  for (const panelId of [
    'data-panel',
    'cctv-panel',
    'scene-panel',
    'pp-toggles',
    'global-context-panel',
    'radio-panel',
  ]) {
    assert.match(entryPanels[1], new RegExp(`'${panelId}'`), `${panelId} must collapse on entry`);
  }

  const callback = ui.match(/onEntered: \(\) => \{([\s\S]*?)\n      \},\n      onExited:/);
  assert.ok(callback, 'Cockpit onEntered callback is missing');
  assert.match(
    callback[1],
    /_cockpitPanelRestore = new Map\(\)/,
    'fresh entry must capture one map-panel snapshot',
  );
  assert.match(
    callback[1],
    /_cockpitPanelRestore\.set\(\s*panelId,\s*panel\.classList\.contains\('collapsed'\),?\s*\)/,
    'entry must remember each panel\'s exact collapsed state before hiding it',
  );
  assert.match(
    callback[1],
    /for \(const panelId of COCKPIT_ENTRY_COLLAPSE_PANEL_IDS\)[\s\S]*?setPanelCollapsed\(panelId, true, \{[\s\S]*?persist: false,[\s\S]*?syncShare: false,/,
    'map panels must collapse without rewriting the normal saved/share layout',
  );
  assert.match(callback[1], /setContextCollapsed\(false\)/, 'Cockpit Contact rail must open');
  assert.match(
    callback[1],
    /setSignalCollapsed\(false, \{ user: true \}\)/,
    'Cockpit Live Signals rail must open and clear an older manual collapse',
  );
  assert.doesNotMatch(
    callback[1],
    /setPanelCollapsed\('global-context-panel', false\)/,
    'normal Context must not reopen over Cockpit',
  );

  const exitCallback = ui.match(/onExited: \(\) => \{([\s\S]*?)\n      \},\n      restoreTrackingFrame:/);
  assert.ok(exitCallback, 'Cockpit onExited callback is missing');
  assert.match(
    exitCallback[1],
    /const restore = this\._cockpitPanelRestore;[\s\S]*?_cockpitPanelRestore = null;/,
    'exit must consume the entry snapshot exactly once',
  );
  assert.match(
    exitCallback[1],
    /for \(const \[panelId, wasCollapsed\] of restore\)[\s\S]*?setPanelCollapsed\(panelId, wasCollapsed, \{[\s\S]*?persist: false,[\s\S]*?syncShare: false,/,
    'exit must restore each pre-Cockpit panel without rewriting saved/share state',
  );

  const navigation = ui.slice(
    ui.indexOf("if (normalized === 'next' || normalized === 'previous')"),
    ui.indexOf("return {\n      ok: false,\n      action: 'control_cockpit'", ui.indexOf("if (normalized === 'next' || normalized === 'previous')")),
  );
  assert.doesNotMatch(
    navigation,
    /COCKPIT_ENTRY_COLLAPSE_PANEL_IDS|setPanelCollapsed/,
    'NEXT/PREVIOUS must preserve panels opened after entry',
  );
});

test('real disclosure changes reconsider only their own temporary panel lane', () => {
  const collapseStart = ui.indexOf('  setPanelCollapsed(');
  const collapse = ui.slice(
    collapseStart,
    ui.indexOf('toggleCleanView(forceEnabled)', collapseStart),
  );
  assert.match(collapse, /classList\.contains\('collapsed'\) === nextCollapsed\s*&&\s*!wasAutoCollapsed[\s\S]*?return;/);
  assert.match(collapse, /_rightPanelStack\?\.contains\(panelEl\)[\s\S]*?_scheduleRightPanelLayout\(\{ reconsiderAutoCollapse: true \}\)/);
  assert.match(collapse, /_scheduleLeftPanelLayout\(\{[\s\S]*?reconsiderAutoCollapse: this\._leftPanelStack\?\.contains\(panelEl\) === true/);
});

test('Cockpit hides the complete top-center globe action group', () => {
  assert.match(
    css,
    /body\.cockpit-mode\s*:is\([\s\S]*?#top-center-actions[\s\S]*?\)\s*\{\s*display: none !important;\s*\}/,
  );
  assert.match(
    css,
    /body\.cockpit-mode\s*:is\([\s\S]*?#clear-selected-layers,[\s\S]*?#share-btn,[\s\S]*?#tilt-map-view,[\s\S]*?#north-up-view,[\s\S]*?#reset-globe-view[\s\S]*?\)\s*\{\s*display:\s*none !important;/,
    'Cockpit must hide each map-only globe action even if its group layout is disturbed',
  );
});

test('Reset releases Contact camera ownership through its selection-preserving route', () => {
  const resetStart = ui.indexOf('resetToGlobeView()');
  const contextRelease = ui.indexOf("militaryAwarenessLayer.releaseCameraOwnership?.({ origin: 'tool' })", resetStart);
  const satelliteRelease = ui.indexOf("satellitesLayer.stopTracking?.({ origin: 'tool' })", resetStart);

  assert.ok(resetStart >= 0);
  assert.ok(contextRelease > resetStart);
  assert.ok(satelliteRelease > contextRelease);
  assert.match(readShellElements.toString(), /_cockpitResetGlobeBtn: document\.getElementById\('cockpit-reset-globe'\)/);
  const controls = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'locationControls.js'), 'utf8');
  assert.match(ui, /resetButtons: \[this\._resetGlobeBtn, this\._cockpitResetGlobeBtn\]/);
  assert.match(ui, /onReset: \(\) => this\.resetToGlobeView\(\)/);
  assert.match(controls, /for \(const button of elements\.resetButtons\)[\s\S]*?this\.bind\(button, 'click', onReset\)/,
    'both reset controls delegate to the same supplied reset action');
  assert.match(cockpitEnter.toString(), /if \(this\.resetGlobeButton\) this\.resetGlobeButton\.hidden = false;/);
  assert.match(readRadioSource(new URL('./ui/cockpitTrackingController.js', import.meta.url), 'utf8'), /if \(this\.resetGlobeButton\) this\.resetGlobeButton\.hidden = true;/);
});

test('Location navigation releases immediate routes before flight and deferred routes after resolution', () => {
  const releaseStart = ui.indexOf('  _releaseFollowCamera(');
  const locationFlight = ui.indexOf('_flyWithTransition(cityChanged, flyAction)');
  const search = ui.indexOf('searchAndFlyTo(this.viewer, query, {');
  const voiceStart = voiceActions.indexOf('beginDeferredLocationNavigation');

  assert.ok(releaseStart >= 0, 'shared Location camera handoff is missing');
  assert.match(
    ui.slice(releaseStart, releaseStart + 1800),
    /militaryAwarenessLayer\.releaseCameraOwnership\?\.\(\{[\s\S]*?origin: trackingOrigin[\s\S]*?\}\)[\s\S]*?satellitesLayer\.stopTracking\?\.\(\{ origin: trackingOrigin \}\)[\s\S]*?rocketLaunchesLayer\.releaseCameraOwnership\?\.\(\)/,
  );
  assert.match(
    ui.slice(locationFlight, locationFlight + 900),
    /this\._runExplicitNavigation\('location',[\s\S]*?flyAction\(/,
  );
  const cityHandler = ui.slice(ui.indexOf('_onCityPillClick(cityId) {'), ui.indexOf('_onPoiClick(cityId, poiIndex) {'));
  const poiHandler = ui.slice(ui.indexOf('_onPoiClick(cityId, poiIndex) {'), ui.indexOf('_expandPOIRow(cityId) {'));
  assert.match(cityHandler, /if \(result === false\) return;[\s\S]*?_setActiveLocation/);
  assert.match(poiHandler, /if \(result === false\) return;[\s\S]*?_setActiveLocation/);
  assert.match(ui, /beforeFly: \(generation\) => this\._reassertNavigationHandoff\(generation\)/);
  assert.match(ui.slice(search, search + 180), /\.\.\.options/);
  const lookup = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'locationSearch.js'), 'utf8');
  assert.match(lookup, /beforeFly: \(\) => current\(\) && this\.beforeFly\(authority\)/);
  assert.ok(voiceStart >= 0, 'voice Location must use the same handoff');
  assert.match(voiceActions, /styleManager\.reassertDeferredLocationNavigation\(generation\)/);
});

test('Cockpit Radio station changes preserve first-person camera ownership', () => {
  const cycleHelper = radioBindings.match(/const cycleRadio = \(direction, \{ rotate = true \} = \{\}\) => \{([\s\S]*?)\n  \};/);
  assert.ok(cycleHelper, 'shared Radio cycle helper is missing');
  assert.match(cycleHelper[1], /cycleStation\(direction, \{[\s\S]*?rotate,/);
  assert.match(radioBindings, /listen\(this\._radioPrevBtn, 'click', \(\) => cycleRadio\(-1\)\)/);
  assert.match(radioBindings, /listen\(this\._contextRadioMiniNextBtn, 'click', \(\) => cycleRadio\(1\)\)/);
  assert.match(
    radioBindings,
    /listen\(this\._cockpitRadioPrevBtn, 'click', \(\) =>\s*cycleRadio\(-1, \{ rotate: false \}\),?\s*\)/,
  );
  assert.match(
    radioBindings,
    /listen\(this\._cockpitRadioNextBtn, 'click', \(\) =>\s*cycleRadio\(1, \{ rotate: false \}\),?\s*\)/,
  );
});

test('Cockpit panel corridors reserve the owned topline readouts', () => {
  const layout = fs.readFileSync(new URL('./ui/panelLayoutController.js', import.meta.url), 'utf8');
  const leftObstacles = layout.match(/const LEFT_STACK_OBSTACLE_SELECTOR = \[([\s\S]*?)\]\.join/);
  const rightObstacles = layout.match(/const RIGHT_STACK_OBSTACLE_SELECTOR = \[([\s\S]*?)\]\.join/);
  assert.ok(leftObstacles && rightObstacles, 'responsive panel obstacle selectors are missing');
  assert.match(leftObstacles[1], /#cockpit-hud \.cockpit-topline/);
  assert.match(rightObstacles[1], /#cockpit-hud \.cockpit-topline/);
  assert.match(leftObstacles[1], /#cockpit-hud \.cockpit-topline > div/);
  assert.match(rightObstacles[1], /#cockpit-hud \.cockpit-topline > div/);
  const leftLayout = fs.readFileSync(new URL('./ui/leftPanelRail.js', import.meta.url), 'utf8');
  assert.ok(leftLayout, 'left accordion layout pass is missing');
  assert.doesNotMatch(
    leftLayout,
    /setProperty\('--cockpit-utility-top'/,
    'the right margin must not borrow the left accordion corridor: it is solved '
      + 'against left-lane obstacles and put the strip through the briefing card',
  );
  const signalLayout = syncSignalLayout.toString();
  assert.ok(signalLayout, 'Cockpit signal layout method is missing');
  assert.match(
    signalLayout,
    /setProperty\(\s*'--cockpit-utility-top',\s*`\$\{utilityAnchor\.top\.toFixed\(1\)\}px`,?\s*\)/,
    'Cockpit owns the utility strip anchor and republishes it every layout tick',
  );
  assert.match(
    signalLayout,
    /resolveCockpitUtilityAnchor\(\{[\s\S]*?recBottom: recBounds \? recBounds\.bottom : 0,[\s\S]*?signalTop: signalBounds\.top,[\s\S]*?stripHeight: utilityBounds\.height,/,
    'the strip hangs off the REC readout and is clamped by the briefing card it shares the margin with',
  );
  assert.match(signalLayout, /#intel-hud \.hud-top-right/);
  assert.match(
    signalLayout,
    /const recBounds = isRenderedOnScreen\(recReadout\)\s*\? recReadout\.getBoundingClientRect\(\)\s*: null;/,
    'HUD Off retires the Intel HUD with visibility/opacity, which leaves the REC '
      + 'readout a rect — a rect test alone would anchor the strip to an invisible readout',
  );
  assert.match(
    isRenderedOnScreen.toString(),
    /function isRenderedOnScreen\(element\) \{[\s\S]*?style\.display === 'none'\s*\|\|\s*style\.visibility === 'hidden'\s*\|\|\s*Number\(style\.opacity\) === 0[\s\S]*?rect\.width > 0 && rect\.height > 0;/,
  );
  assert.match(
    layout,
    /_leftStackHudTransitionHandler = \(event\) => \{[\s\S]*?_scheduleLeftPanelLayout\(\{ reconsiderAutoCollapse: true \}\);[\s\S]*?this\.scheduleCockpitLayout\(\);/,
    'the strip must remeasure on the same HUD fade the accordion does — the REC '
      + 'readout keeps its rect until the transition ends',
  );
  assert.doesNotMatch(
    signalLayout,
    /Math\.max\(120,/,
    'the 120px corridor floor can never be reached by a 107px strip and only hid the collision',
  );
  assert.match(signalLayout, /const availableHeight = utilityAnchor\.maxHeight;/);
  assert.match(signalLayout, /cockpit-utility-controls[\s\S]*?--cockpit-utility-max-height/);
  assert.match(
    css,
    /\.cockpit-utility-controls\s*\{[\s\S]*?top:\s*var\(\s*--cockpit-utility-top,\s*var\(\s*--left-stack-safe-top,\s*var\(\s*--left-stack-top\)\s*\)\s*\)/,
    'the first frame before Cockpit publishes an anchor still needs the fallback chain',
  );
  assert.match(css, /body\.cockpit-mode #left-panel-stack\s*\{[\s\S]*?transition:\s*none;/);
});

test('an expanded Cockpit left panel stays above Contact, HUD, and attribution', () => {
  assert.doesNotMatch(
    ui,
    /COCKPIT_PASSABLE_LEFT_OBSTACLE_SELECTOR|cockpitOverlaysPassable/,
    'Cockpit obstacles must never be bypassed by an expanded map panel',
  );
  const leftLayout = fs.readFileSync(new URL('./ui/leftPanelRail.js', import.meta.url), 'utf8');
  assert.ok(leftLayout, 'left accordion layout pass is missing');
  assert.match(
    leftLayout,
    /rect\.top >= baseTop\) \{\s*\n\s*bottomObstacles\.push\(\{ top: rect\.top \}\);/,
    'every rendered lower-lane obstacle must constrain the panel corridor',
  );
  assert.match(
    leftLayout,
    /safeBottom = resolveLeftStackBottomBoundary\(\{[\s\S]*?safeGap,\s*\n\s*\}\);/,
  );
  const cockpitHud = css.match(/#cockpit-hud\s*\{[\s\S]*?z-index:\s*(\d+);/);
  const cockpitIntelHud = css.match(
    /body\.cockpit-mode #intel-hud\.active\s*\{[\s\S]*?z-index:\s*(\d+);/,
  );
  const leftStack = css.match(/body\.cockpit-mode #left-panel-stack\s*\{[\s\S]*?z-index:\s*(\d+);/);
  assert.ok(cockpitHud && cockpitIntelHud && leftStack);
  assert.ok(Number(leftStack[1]) > Number(cockpitHud[1]));
  assert.ok(Number(leftStack[1]) > Number(cockpitIntelHud[1]));
  // Long layer lists scroll inside the panel instead of being clipped away.
  assert.match(
    css,
    /\.data-toggle-list\s*\{[\s\S]*?overflow-y:\s*auto;/,
  );
  assert.match(
    css,
    /#left-panel-stack > #data-panel:not\(\.collapsed\) \.data-panel-inner[\s\S]*?\{[\s\S]*?height:\s*100%;[\s\S]*?max-height:\s*100%;/,
  );
});

test('Cockpit side rulers stay behind interactive panel surfaces', () => {
  const cockpitHud = css.match(/#cockpit-hud\s*\{[\s\S]*?z-index:\s*(\d+);/);
  const leftStack = css.match(/body\.cockpit-mode #left-panel-stack\s*\{[\s\S]*?z-index:\s*(\d+);/);
  const sideRuler = css.match(/\.cockpit-altitude-rim\s*\{[\s\S]*?z-index:\s*(\d+);/);
  const context = css.match(/\.cockpit-context-window\s*\{[\s\S]*?z-index:\s*(\d+);/);
  const signals = css.match(/\.cockpit-signal-window\s*\{[\s\S]*?z-index:\s*(\d+);/);
  const utilities = css.match(/\.cockpit-utility-controls\s*\{[\s\S]*?z-index:\s*(\d+);/);
  assert.ok(cockpitHud && leftStack && sideRuler && context && signals && utilities);
  assert.ok(Number(leftStack[1]) > Number(cockpitHud[1]));
  assert.ok(Number(context[1]) > Number(sideRuler[1]));
  assert.ok(Number(signals[1]) > Number(sideRuler[1]));
  assert.ok(Number(utilities[1]) > Number(sideRuler[1]));
});

test('Cockpit Display portals shared HUD, Detection, Parameters, and 3D controls', () => {
  assert.match(
    ui,
    /_initCockpitDisplayPortal\(\) \{[\s\S]*?\['hud', this\._hudBtn\?\.closest[\s\S]*?\['detection', this\._detectionBtn\?\.closest[\s\S]*?\['parameters', this\._sliderPanel\][\s\S]*?\['models3d', this\._models3dBtn\?\.closest/,
  );
  assert.doesNotMatch(ui, /\['presets',/);
  assert.match(
    CockpitDisplayPortal.toString(),
    /group\.before\(anchor\)[\s\S]*?window\.addEventListener\(\s*'gev:cockpit-mode-changed'/,
  );
  assert.match(
    CockpitDisplayPortal.prototype.setActive.toString(),
    /record\.slot\.append\(record\.group\)[\s\S]*?record\.anchor\.after\(record\.group\)/,
  );
  assert.match(
    CockpitDisplayPortal.prototype.destroy.toString(),
    /this\.stop\(\)[\s\S]*?record\.anchor\.after\(record\.group\)[\s\S]*?record\.anchor\.remove\(\)/,
  );
  assert.doesNotMatch(ui, /_cycleCockpitHud|_cockpitModels3dToggle|_cockpitDetectionToggle/);
  assert.equal((html.match(/id="style-buttons"/g) || []).length, 1);
  assert.equal((html.match(/id="param-slider-panel"/g) || []).length, 1);
  assert.match(html, /data-cockpit-display-slot="detection"[\s\S]*?data-cockpit-display-slot="parameters"[\s\S]*?data-cockpit-display-slot="models3d"/);
  assert.match(ui, /_revealStyleParameters\(\) \{[\s\S]*?if \(this\._cockpitDisplayPortalActive\) return;/);
  assert.match(radioBindings, /closest\?\.\('\.cockpit-vision-controls'\)\) return;/);
  assert.match(ui, /_revealCockpitStyleParameters\(\{ openDisplay = false \} = \{\}\) \{[\s\S]*?openDisplay[\s\S]*?_setCockpitDisclosure\?\.\('display', true\)[\s\S]*?aria-expanded'\) !== 'true'[\s\S]*?classList\.remove\('collapsed'\)/);
  assert.match(radioBindings, /if \(displayOpen\) this\.actions\.revealStyleParameters\(\);/);
  assert.match(cycleVisionMode.toString(), /setVisionMode\(modes\[nextIndex\], \{ revealParameters: true \}\);/);
  assert.match(css, /\.cockpit-display-slot\s*\{[\s\S]*?display:\s*block;[\s\S]*?min-width:\s*0;/);
  assert.match(css, /#cockpit-display-panel \.pp-toggle-group\s*\{\s*width:\s*100%/);
  assert.match(css, /#cockpit-display-panel \.pp-toggle-group\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(css, /#cockpit-display-panel \.pp-toggle-btn\s*\{[\s\S]*?width:\s*100%/);
});

test('mobile Cockpit prioritizes flight instruments and collision-safe controls', () => {
  const mobileCockpit = css.match(
    /@media \(max-width: 760px\) \{([\s\S]*?)\n\}\n\n@media \(prefers-reduced-motion/,
  );
  assert.ok(mobileCockpit, 'mobile Cockpit rules are missing');
  assert.match(mobileCockpit[1], /body\.cockpit-mode #left-panel-stack,[\s\S]*?display:\s*none\s*!important;/);
  assert.match(mobileCockpit[1], /body\.cockpit-mode #intel-hud/);
  assert.match(mobileCockpit[1], /body\.cockpit-mode \.cockpit-context-window/);
  assert.match(mobileCockpit[1], /body\.cockpit-mode \.cockpit-signal-window/);
  assert.match(mobileCockpit[1], /body\.cockpit-mode \.cockpit-utility-controls[\s\S]*?bottom:\s*152px;/);
  assert.match(mobileCockpit[1], /body\.cockpit-mode \.cockpit-utility-control\.is-expanded[\s\S]*?top:\s*96px;/);
  assert.match(mobileCockpit[1], /body\.cockpit-mode \.cockpit-utility-popover[\s\S]*?position:\s*static;/);
  assert.match(
    mobileCockpit[1],
    /body\.cockpit-mode #view-switcher \{[\s\S]*?bottom:\s*max\(76px, env\(safe-area-inset-bottom\)\);[\s\S]*?max-width:\s*calc\(100vw - 20px\);/,
  );
  assert.match(mobileCockpit[1], /body\.cockpit-mode #view-switcher button \{[\s\S]*?padding-inline:\s*9px;/);
});

test('cockpit route direction uses self-contained vector artwork, not a font ligature', () => {
  const match = html.match(
    /<div id="cockpit-route-direction"[\s\S]*?<\/div>/,
  );
  assert.ok(match, 'cockpit route-direction markup is missing');
  assert.match(match[0], /<svg class="cockpit-route-chevron"/);
  assert.match(match[0], /<path d="[^"]+"/);
  assert.doesNotMatch(match[0], />navigation</);
  assert.doesNotMatch(match[0], /material-icons-round/);
});

test('cockpit aircraft handoff invalidates the prior world-position anchor', () => {
  const match = _adoptTrackedEntity.toString();
  assert.ok(match, 'cockpit tracked-entity handoff block is missing');
  assert.match(match, /this\.viewer\.trackedEntity = undefined;/);
  assert.match(match, /this\.cockpitAnchorValid = false;/);
  assert.match(match, /this\.heading = normalizeHeading\(info\.track \?\? 0\);/);
  assert.match(match, /this\.lastFrameMs = nowMs;/);
});

test('cockpit weather control is off before JavaScript restores an explicit opt-in', () => {
  const match = html.match(
    /<button\s+id="cockpit-weather-toggle"[\s\S]*?<\/button>/,
  );
  assert.ok(match, 'cockpit weather toggle markup is missing');
  assert.match(match[0], /aria-label="Enable cockpit weather effects"/);
  assert.match(match[0], /aria-pressed="false"/);
  assert.match(match[0], /id="cockpit-weather-state">OFF</);
});

test('cockpit summary presents the focused item as Contact', () => {
  const match = html.match(
    /<aside id="cockpit-context"[\s\S]*?<\/aside>/,
  );
  assert.ok(match, 'cockpit Contact summary is missing');
  assert.match(match[0], /aria-label="Contact cockpit summary"/);
  assert.match(match[0], /class="cockpit-context-kicker">CONTACT</);
  assert.match(match[0], /aria-label="Contact navigation"/);
  assert.match(match[0], /aria-label="Previous — prior visited contact in the 250 km window"/);
  assert.match(match[0], /aria-label="Next — nearest unvisited contact in the 250 km window"/);
  assert.match(match[0], /aria-label="Collapse Contact panel"/);
  assert.doesNotMatch(match[0], />GLOBAL CONTEXT</);
  assert.match(setContextCollapsed.toString(), /`\$\{expanded \? 'Collapse' : 'Expand'\} Contact panel`/);
});

test('Cockpit Contact navigation omits the redundant Focus camera action', () => {
  assert.match(html, /id="cockpit-context-previous"/);
  assert.match(html, /id="cockpit-context-next"/);
  assert.doesNotMatch(html, /id="cockpit-context-focus"/);
  assert.doesNotMatch(ui, /contextFocus|militaryAwarenessLayer\.focusCurrent/);
});

test('Global Context names its mixed contact cycle without changing the stable mode id', () => {
  const match = html.match(
    /<button id="global-context-flights-btn"[\s\S]*?<\/button>/,
  );
  assert.ok(match, 'Global Context contacts button is missing');
  assert.match(match[0], />CONTACTS</);
  assert.match(match[0], /aria-label="CONTACTS"/);
  assert.match(match[0], /title="Cycles the nearest contacts of whatever type you select — planes, vessels, installations\. Satellites track independently\."/);
  assert.doesNotMatch(match[0], />FLIGHTS</);
});

test('Global Context uses its dedicated right rail without a duplicate Data Layers row', () => {
  assert.match(contextLayer, /id:\s*'military-awareness'[\s\S]*?showInTogglePanel:\s*false/);
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'layerPanel.js'), 'utf8');
  assert.match(panel, /if \(!layer\.showInTogglePanel\) continue;/);
  assert.match(manager, /getLayers: \(\) => this\.getAll\(\)/);
  assert.match(html, /id="global-context-panel"/);
  assert.match(html, /id="global-context-flights-btn"/);
  assert.match(html, /id="global-context-missions-btn"/);
});

test('Global Context standby describes both chooser modes', () => {
  const match = html.match(
    /<div id="context-mode-standby"[\s\S]*?<\/div>/,
  );
  assert.ok(match, 'Global Context standby is missing');
  assert.match(match[0], /CONTACTS — nearest planes · vessels · sites/);
  assert.match(match[0], /SPACE MISSIONS — launches &amp; orbital assets/);
});

test('cockpit briefing cycle control keeps its state as the accessible name', () => {
  const match = html.match(
    /<button\s+id="cockpit-brief-auto"[\s\S]*?<\/button>/,
  );
  assert.ok(match, 'cockpit briefing cycle toggle is missing');
  assert.match(match[0], /aria-label="CYCLE OFF"/);
  assert.match(match[0], /aria-pressed="false"/);
  assert.match(match[0], />CYCLE OFF<\/button>/);
  assert.match(match[0], /title="Cycle briefing pages automatically every 9 seconds \(Signals → News → Local\)\./);

  const update = setBriefAutoRotate.toString();
  assert.ok(update, 'cockpit briefing cycle state updater is missing');
  assert.match(update, /const label = this\.briefAutoRotateEnabled \? 'CYCLE ON' : 'CYCLE OFF';/);
  assert.match(update, /setAttribute\('aria-label', label\)/);
  assert.match(update, /\.title = help;/);
  assert.doesNotMatch(update, /setAttribute\('aria-label', help\)/);
});

test('voice Cockpit entry honours a requested contact layer before it enters', () => {
  // Field case (mic test 01:43:23): enter with targetLayer:"military" reported
  // ok:true on a FLIGHTS subject — the requested layer was read only by
  // next/previous, so entry silently used whatever was already tracked.
  const branch = ui.slice(
    ui.indexOf("if (normalized === 'enter') {"),
    ui.indexOf("if (normalized === 'exit') {"),
  );
  assert.ok(branch, 'cockpit enter branch is missing');
  const gateIndex = branch.indexOf('isEntryAllowed?.()');
  const retargetIndex = branch.indexOf('_retargetCockpitEntryLayer(');
  const enterIndex = branch.indexOf('enterCockpitWithTracking({');
  assert.ok(gateIndex >= 0, 'entry consults the same gate the manual chip uses');
  assert.ok(retargetIndex > gateIndex, 'the requested layer is resolved after the gate');
  assert.ok(enterIndex > retargetIndex, 'and BEFORE the entry transaction runs');
  // The retarget must be REACHED, not merely present: a guard that can never be
  // true reproduces the original defect while keeping the call in the source.
  assert.match(
    branch,
    /if \(targetLayer\) \{\s*const requested = this\._retargetCockpitEntryLayer\(\{/,
    'the retarget runs whenever a layer was requested',
  );
  // A retarget invalidates any selection sampled before it, or entry would be
  // dragged straight back to the wrong layer.
  assert.match(branch, /selectedTarget = null;/);
  // A refused retarget is an honest failure, never a silent wrong-layer entry.
  assert.match(branch, /ok: false,[\s\S]*?error: requested\.error,/);

  const retarget = ui.slice(
    ui.indexOf('  _retargetCockpitEntryLayer({'),
    ui.indexOf('   * Controls cockpit entry/exit and context navigation.'),
  );
  assert.match(
    retarget,
    /militaryAwarenessLayer\.navigateNext\(\{\s*targetLayer,\s*aircraftClass,\s*origin: 'voice',\s*\}\)/,
    'retargeting reuses filtered navigation with durable voice selection authority',
  );
  assert.match(retarget, /Cockpit flies aircraft only/, 'non-aircraft layers are refused by name');
  assert.match(retarget, /No \$\{filtered\}\$\{label\} contact is available to enter/);
});

test('voice Cockpit entry refuses when the entry gate is shut', () => {
  // The half-entered state the operator reported (a plane anchored under the
  // camera, no HUD, no exit) is what attempting entry through a shut gate looks
  // like. Refuse with the reason instead.
  const branch = ui.slice(
    ui.indexOf("if (normalized === 'enter') {"),
    ui.indexOf("if (normalized === 'exit') {"),
  );
  assert.match(branch, /if \(!this\.cockpitView\.isEntryAllowed\?\.\(\)\) \{/);
  assert.match(branch, /Contacts must be active to enter Cockpit/);
  assert.match(branch, /Contacts is still starting up/);
});

test('cockpit state cannot report entryAllowed while already active', () => {
  // Cockpit takes the entity off viewer.trackedEntity on entry and NEXT puts
  // one back, so this flipped true/false between calls while active stayed
  // true — read by the voice model as a broken half-entered state.
  const state = ui.slice(
    ui.indexOf('  getCockpitState() {'),
    ui.indexOf('  _retargetCockpitEntryLayer({'),
  );
  assert.match(
    state,
    /const entryAllowed =\s*!active &&\s*Boolean\(/,
    'entry is impossible while already inside, unconditionally',
  );
  assert.match(state, /entryBlockedReason:/, 'and a refusal can be explained');
  assert.match(state, /'contacts-starting'/);
  assert.match(state, /'contacts-inactive'/);
  assert.match(state, /'no-tracked-aircraft'/);
});
