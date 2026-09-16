import { LayerBindings } from './ui/layerBindings.js';
import { readShellSource, shellMethod } from './testSupport/readShellSource.mjs';
import { readLayerSource } from './testSupport/readLayerSource.mjs';
import { StyleManager } from './ui/applicationShell.js';
import { enter as cockpitEnter, navigateContext } from './ui/cockpitTrackingController.js';
import { CockpitViewController } from './ui/cockpitController.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = readShellSource();
const firms = readLayerSource(path.join(ROOT, 'src', 'data', 'firmsHeatmap.js'));
const vessels = readLayerSource(path.join(ROOT, 'src', 'data', 'aisLiveVessels.js'));
const voice = fs.readFileSync(path.join(ROOT, 'src', 'voice', 'gevActions.js'), 'utf8');
const cameraVerbs = fs.readFileSync(path.join(ROOT, 'src', 'cameraVerbs.js'), 'utf8');
const cockpitTracking = fs.readFileSync(path.join(ROOT, 'src', 'cockpitTracking.js'), 'utf8');

function body(source, pattern, label) {
  const name = pattern.source.match(/^(\w+)/)?.[1];
  if (source === ui && typeof shellMethod(name) === 'function') {
    const method = shellMethod(name).toString();
    return method.slice(method.indexOf(') {') + 3, -1);
  }
  const match = source.match(pattern);
  assert.ok(match, `${label} is missing`);
  return match[1];
}

function ordered(source, needles, label) {
  let previous = -1;
  for (const needle of needles) {
    const match = needle instanceof RegExp ? needle.exec(source.slice(previous + 1)) : null;
    const index = needle instanceof RegExp ? (match ? previous + 1 + match.index : -1) : source.indexOf(needle, previous + 1);
    assert.ok(index >= 0, `${label}: missing ${needle}`);
    assert.ok(index > previous, `${label}: ${needle} is out of order`);
    previous = index;
  }
}

test('Cockpit takeover invalidates deferred work before camera cancellation', () => {
  const enter = cockpitEnter.toString();
  ordered(enter, [
    'if (!info || !entity?.position) return false;',
    'this.onCameraTakeover?.();',
    'this.viewer.camera.cancelFlight();',
    'this.viewer.trackedEntity = undefined;',
  ], 'Cockpit takeover');
  assert.match(
    ui,
    /onCameraTakeover: \(\) =>\s*this\._stampNavigation\(\{\s*cancelPendingSelection: false,?\s*\}\),/,
    'Cockpit retires stale camera work without clearing the aircraft selection it adopts',
  );
});

test('one explicit tracking selection clears sibling IDs before publishing its durable replacement', () => {
  const persist = body(
    ui,
    /_persistAwarenessSelection\(event, cleared = false\) \{([\s\S]*?)\n  \}/,
    'tracking persistence',
  );
  assert.match(persist, /adoptLayerParams\?\.\(\s*layerId,/);
  assert.match(persist, /\['flights', 'selectedFlightsTrackingId'\]/);
  assert.match(persist, /\['military', 'selectedMilitaryTrackingId'\]/);
  assert.match(persist, /\['satellites', 'selectedSatTrackingId'\]/);
  assert.match(persist, /if \(otherLayerId === layerId\) continue;/);
  assert.match(
    persist,
    /for \(const \[otherLayerId, otherKey\][\s\S]*?setLayerParams\(\s*otherLayerId,[\s\S]*?adoptLayerParams\?\.\(\s*layerId,/,
    'the previous family clears before Flight/Military/Satellite publishes the new durable ID',
  );
});

test('navigation clears dormant tracker IDs without aborting unrelated layer restoration', () => {
  const stamp = body(
    ui,
    /_stampNavigation\(\{ cancelPendingSelection = true[^)]*\} = \{\}\) \{([\s\S]*?)\n  \}/,
    'navigation authority stamp',
  );
  assert.doesNotMatch(stamp, /cancelPendingRestores\(\)/);
  assert.match(stamp, /flightsLayer\.cancelPendingTrackingRestore\?\.\(\)/);
  assert.match(stamp, /militaryFlightsLayer\.cancelPendingTrackingRestore\?\.\(\)/);
  assert.match(stamp, /satellitesLayer\.cancelPendingTrackingRestore\?\.\(\)/);
  assert.match(stamp, /if \(\s*!passivelyClearedShareSelection\s*&&\s*!flightsLayer\.getTrackedInfo\?\.\(\)\s*\)[\s\S]*?selectedFlightsTrackingId: null/);
  assert.match(stamp, /if \(\s*!passivelyClearedShareSelection\s*&&\s*!militaryFlightsLayer\.getTrackedInfo\?\.\(\)\s*\)[\s\S]*?selectedMilitaryTrackingId: null/);
  assert.match(stamp, /if \(\s*!passivelyClearedShareSelection\s*&&\s*!satellitesLayer\.getTrackedInfo\?\.\(\)\s*\)[\s\S]*?selectedSatTrackingId: null/);
});

test('voice Cockpit entry reaches the camera only through stamping seams', () => {
  // Cockpit is the camera-authority VETO HOLDER, not a petitioner: routing
  // entry through _runExplicitNavigation would make it refuse itself, because
  // cockpitActive is the state entry is trying to reach. What entry owes the
  // policy is the STAMP that retires deferred navigation — and the voice path
  // must not acquire the camera by any route that skips it.
  //
  // The transaction has exactly two camera-owner mutations, and each one
  // stamps:
  //   1. selectedLayer.trackById(id) -> viewer.trackedEntity
  //        -> viewer.trackedEntityChanged -> _stampNavigation()
  //   2. cockpitView.enter() -> onCameraTakeover() -> _stampNavigation()
  const transaction = body(
    cockpitTracking,
    /export function enterCockpitWithTracking\(\{[\s\S]*?\n\}\) \{([\s\S]*?)\n\}\n/,
    'Cockpit entry transaction',
  );
  ordered(transaction, [
    /if \(\s*!selectedLayer\.trackById\?\.\(selectedTarget\.id, \{\s*origin: selectionOrigin,?\s*\}\)\s*\) \{/,
    'if (!entryError) entered = Boolean(cockpitView.enter());',
  ], 'Cockpit entry transaction');
  // No direct camera control: every mutation goes through a layer tracker or
  // the cockpit controller, both of which stamp.
  assert.doesNotMatch(transaction, /\b(?:viewer\.)?camera\s*(?:\.|\[|=)/);
  assert.doesNotMatch(cockpitTracking, /trackedEntity\s*=/);
  assert.doesNotMatch(cockpitTracking, /flyTo/);

  // Seam 1: any tracker handoff stamps, so the adoption step is covered.
  assert.match(
    ui,
    /viewer\.trackedEntityChanged\.addEventListener\(\s*\(entity\) => \{\s*if \(entity && !this\._disposed\)\s*this\._stampNavigation\(\{\s*cancelPendingSelection: false,?\s*\}\);/,
    'tracker handoff must stamp',
  );
  // Seam 2 is pinned by "Cockpit takeover invalidates deferred work" above.
  const control = body(
    ui,
    /if \(normalized === 'enter'\) \{([\s\S]*?)\n    \}/,
    'controlCockpit enter branch',
  );
  assert.match(control, /enterCockpitWithTracking\(\{/);
  // A refused entry is reported as a failure, never as silent success.
  assert.match(control, /ok: entry\.entered,/);
  assert.match(control, /error: entry\.error,/);
});

test('voice Cockpit next/previous shares the manual Context navigation path', () => {
  // The voice verb must not grow a private focus route: manual PREVIOUS/NEXT
  // and the voice verb both hand off through the owning layer's tracker, which
  // is what stamps. Divergence here is how a voice-only camera path escapes
  // the arbiter.
  assert.match(
    CockpitViewController.toString(),
    /this\._listen\(this\.contextPrevious, 'click', \(\) =>\s*this\.navigateContext\(-1, \{ origin: 'user' \}\),?\s*\);/,
  );
  assert.match(
    CockpitViewController.toString(),
    /this\._listen\(this\.contextNext, 'click', \(\) =>\s*this\.navigateContext\(1, \{ origin: 'user' \}\),?\s*\);/,
  );
  const funnel = navigateContext.toString();
  assert.match(funnel, /const navigationOptions = wasActive\s*\? \{ \.\.\.options, aircraftOnly: true \}\s*: options;/);
  ordered(funnel, [
    "const method = direction < 0 ? 'navigatePrevious' : 'navigateNext';",
    'const navigationOptions = wasActive',
    'militaryAwarenessLayer?.[method]?.(navigationOptions)',
    'this._adoptTrackedEntity(performance.now());',
  ], 'Cockpit Context navigation funnel');
  const navigate = body(
    ui,
    /if \(normalized === 'next' \|\| normalized === 'previous'\) \{([\s\S]*?)\n    \}/,
    'controlCockpit navigation branch',
  );
  ordered(navigate, [
    'this.cockpitView.navigateContext(',
    "normalized === 'next' ? 1 : -1,",
  ], 'controlCockpit navigation branch');
  // No private camera route around the awareness layer.
  assert.doesNotMatch(navigate, /flyTo|camera|trackById|_runExplicitNavigation/);
  // An exhausted cohort is an honest failure, not a silent success.
  assert.match(navigate, /ok: changed,/);
  assert.match(navigate, /error: changed \? null : 'No further context target was available',/);
});

test('accepted navigation releases through PR15-aware ownership before flight', () => {
  const run = body(
    ui,
    /_runExplicitNavigation\(noun, navigate, releaseOptions = undefined\) \{([\s\S]*?)\n  \}/,
    'explicit navigation',
  );
  ordered(run, [
    'cockpitActive: this.isCockpitActive()',
    'stamp: () => this._stampNavigation()',
    'release: () => this._releaseFollowCamera(releaseOptions)',
    'navigate,',
  ], 'explicit navigation');
  const release = body(
    ui,
    /_releaseFollowCamera\(\{[\s\S]*?\} = \{\}\) \{([\s\S]*?)\n  \}/,
    'follow release',
  );
  ordered(release, [
    'origin: trackingOrigin',
    'satellitesLayer.stopTracking?.({ origin: trackingOrigin })',
    'rocketLaunchesLayer.releaseCameraOwnership?.()',
    'this.viewer.trackedEntity = undefined;',
    "interruptCameraMotion('explicit-navigation')",
    'this.viewer.camera.cancelFlight();',
    'this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);',
  ], 'follow release');
  assert.match(release, /flightsLayer\.stopTracking\?\.\(\{ origin: trackingOrigin \}\)/);
  assert.match(release, /militaryFlightsLayer\.stopTracking\?\.\(\{ origin: trackingOrigin \}\)/);
});

test('validated voice camera destinations share the UI navigation authority facade', () => {
  assert.match(ui, /runImmediateNavigation\(noun, navigate, releaseOptions = undefined\) \{\s*return this\._runExplicitNavigation\(noun, navigate, releaseOptions\);/);
  assert.match(voice, /runManagedVoiceNavigation\(\s*styleManager,\s*'camera',\s*'move_camera',\s*navigate,\s*releaseOptions/);
  assert.match(voice, /runManagedVoiceNavigation\(\s*styleManager,\s*'route',\s*'fly_route',\s*navigate/);
  assert.match(voice, /runManagedVoiceNavigation\(\s*styleManager,\s*'fire',\s*'track_entity'/);
  assert.match(voice, /runManagedVoiceNavigation\(\s*styleManager,\s*family\.kind,\s*'track_entity'/);
  assert.match(voice, /runManagedVoiceNavigation\(\s*styleManager,\s*'frame',\s*'frame_overhead'/);
  const trackedVoice = voice.slice(
    voice.indexOf('async function trackEntity'),
    voice.indexOf('async function frameOverhead'),
  );
  const framedVoice = voice.slice(
    voice.indexOf('async function frameOverhead'),
    voice.indexOf('/** Gathers tracked/selected entities'),
  );
  assert.doesNotMatch(trackedVoice, /supersedeDeferredNavigation/);
  assert.doesNotMatch(framedVoice, /supersedeDeferredNavigation/);

  const move = body(
    cameraVerbs,
    /export function moveCamera\(args = \{\}, runNavigation = null\) \{([\s\S]*?)\n\}/,
    'move camera',
  );
  ordered(move, [
    "if (!['orbit', 'pan', 'tilt', 'rotate'].includes(motion))",
    'const start = () => {',
    /const preserveCameraFlight =\s*motion === 'orbit'/,
    'runNavigation(start, { preserveCameraFlight })',
  ], 'move validation before handoff');

  const route = body(
    cameraVerbs,
    /export function flyRoute\(\s*annoList,\s*args = \{\},\s*floorFn = null,\s*runNavigation = null,\s*warmFn = null,?\s*\) \{([\s\S]*?)\n\}/,
    'fly route',
  );
  ordered(route, [
    'if (!routes.length)',
    'const pts = route.path.map',
    'const start = () => {',
    /return typeof runNavigation === 'function'\s*\? runNavigation\(start\)\s*: start\(\);/,
  ], 'route validation before handoff');
  // The corridor warm is injected the same way the floor READ is — the dolly
  // never reaches into the data layer itself, and the voice dispatch is the one
  // place that binds both.
  assert.match(voice, /\(lat, lon\) => floorServices\.cachedGroundFloor\(lat, lon\),[\s\S]{0,200}?\(cells\) => floorServices\.warmGroundFloor\(cells\),/);
});

test('deferred search releases only after its final authority check', () => {
  const search = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'locationSearch.js'), 'utf8');
  ordered(search, [
    'const authority = this.begin();',
    'this.onStart?.(authority);',
    'await this.search(query',
    'beforeFly: () => current() && this.beforeFly(authority)',
    'if (!current() || controller.signal.aborted) return;',
    'destination?.cancelled',
    'finally',
    'this.onSettled?.(authority)',
  ], 'deferred search component');
  assert.match(ui, /begin: \(\) => this\._beginDeferredNavigation\('location'\)/);
  assert.match(ui, /beforeFly: \(generation\) => this\._reassertNavigationHandoff\(generation\)/);
  assert.match(ui, /isCurrent: \(generation\) =>\s*!this\._disposed && generation === this\._navigationGeneration/);
  assert.match(ui, /change\.type === 'settled'\)\s*this\._settleLocationSearchUi\(change\.generation\)/);
  assert.doesNotMatch(search.slice(0, search.indexOf('await this.search')), /_releaseFollowCamera/);
});

test('a direct globe gesture retires delayed camera and selection restore only', () => {
  assert.match(
    ui,
    /this\._initialShareGestureHandler = \(\) => \{[\s\S]*?!this\._resolveInitialShareRestore[\s\S]*?stampInitialShareGesture\(\(options\) =>\s*this\.navigation\._stampNavigation\(options\),?\s*\);/,
  );
  assert.match(
    ui,
    /viewer\?\.canvas\?\.addEventListener\(\s*'pointerdown',\s*this\._initialShareGestureHandler/,
  );
  assert.match(
    ui,
    /viewer\?\.canvas\?\.addEventListener\(\s*'wheel',\s*this\._initialShareGestureHandler/,
  );
  assert.match(
    ui,
    /removeEventListener\(\s*'pointerdown',\s*this\._initialShareGestureHandler,?\s*\)[\s\S]*?removeEventListener\(\s*'wheel',\s*this\._initialShareGestureHandler,?\s*\)/,
  );
  const stamp = body(
    ui,
    /_stampNavigation\(\{ cancelPendingSelection = true[^)]*\} = \{\}\) \{([\s\S]*?)\n  \}/,
    'navigation stamp',
  );
  assert.match(stamp, /if \(cancelPendingSelection\) \{[\s\S]*?cancelPendingTrackingRestore/);
  assert.doesNotMatch(stamp, /cancelPendingRestores\(\)/);
});

test('newer navigation, reset, Cockpit, and teardown share one generation', () => {
  assert.equal((ui.match(/_navigationGeneration \+= 1/g) || []).length, 1);
  const reset = body(ui, /resetToGlobeView\(\) \{([\s\S]*?)\n  \}/, 'reset');
  ordered(reset, [
    'if (this._globeResetPromise) return this._globeResetPromise;',
    'this._stampNavigation();',
    "interruptCameraMotion('reset-globe')",
  ], 'reset supersession');
  const dispose = body(ui, /async dispose\(\) \{([\s\S]*?)\n  \}/, 'dispose');
  ordered(dispose, [
    'this._disposed = true;',
    'this._layerBindings.stop();',
    'this._navigation.destroy();',
    'await this._contextControls.restoreForDisposal();',
  ], 'dispose invalidation');
  assert.match(shellMethod('destroy').toString(), /this\._stampNavigation\(\)/);
});

test('teardown synchronously closes immediate camera entry points', () => {
  const dispose = body(ui, /async dispose\(\) \{([\s\S]*?)\n  \}/, 'dispose');
  ordered(dispose, [
    'this._disposed = true;',
    'this._layerBindings.stop();',
    'await this._contextControls.restoreForDisposal();',
  ], 'synchronous teardown barrier');
  ordered(LayerBindings.prototype.stop.toString(), [
    'this._disposed = true;',
    'this._removeCctvRequestFocusListener?.();',
    'this._removeWorldRequestFocusListener?.();',
    'this._navigationOwnerChangedRemover?.();',
  ], 'camera bindings close synchronously');

  const navigation = body(
    ui,
    /_runExplicitNavigation\(noun, navigate, releaseOptions = undefined\) \{([\s\S]*?)\n  \}/,
    'explicit navigation',
  );
  ordered(navigation, [
    'disposed: this._disposed',
    'release: () => this._releaseFollowCamera(releaseOptions)',
    'navigate,',
  ], 'disposed navigation guard');

  const cctvFocus = body(
    ui,
    /_runExplicitCctvFocus\(activate, focus\) \{([\s\S]*?)\n  \}/,
    'explicit CCTV focus',
  );
  ordered(cctvFocus, [
    'if (this._disposed) return false;',
    'const cameraId = activate();',
  ], 'disposed CCTV activation guard');
});

test('teardown refuses deferred location work before geocoding begins', () => {
  const deferred = body(ui, /_beginDeferredNavigation\(noun = 'location', \{ cancelPendingSelection = true \} = \{\}\) \{([\s\S]*?)\n  \}/, 'deferred navigation');
  assert.match(deferred, /disposed: this\._disposed/);
  const search = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'locationSearch.js'), 'utf8');
  ordered(search, [
    'if (!query || this.destroyed) return;',
    'const authority = this.begin();',
    'if (authority === false)',
    'this.input.blur();',
    'this.onStart?.(authority);',
    'await this.search(query',
  ], 'disposed search refusal');
  assert.match(search, /if \(authority === false\) \{[\s\S]*?return;[\s\S]*?\}\s*this\.controller/);
});

test('refused canned destinations commit no location or POI state', () => {
  for (const [name, pattern] of [
    ['city', /_onCityPillClick\(cityId\) \{([\s\S]*?)\n  \}/],
    ['poi', /_onPoiClick\(cityId, poiIndex\) \{([\s\S]*?)\n  \}/],
  ]) {
    const handler = body(ui, pattern, name);
    ordered(handler, [
      'this._flyWithTransition(',
      'if (result === false) return;',
      'this._setActiveLocation(cityId);',
    ], name);
  }
});

test('world-focus listener lifecycle is symmetric and idempotent', () => {
  assert.match(ui, /registerWorldFocusRequestListener\(\s*window,/);
  assert.match(ui, /routeWorldFocusRequest\(/);
  assert.match(ui, /flyToWorldTarget\(this\.viewer, detail\)/);
  assert.match(ui, /this\._removeWorldRequestFocusListener\?\.\(\);/);
  assert.match(ui, /this\._removeWorldRequestFocusListener = null;/);
});

test('vessel and fire layers announce valid clicks and never fly cameras', () => {
  for (const [label, source] of [['vessels', vessels], ['fires', firms]]) {
    assert.match(source, /requestWorldFocus\(\{/);
    assert.doesNotMatch(source, /camera\.flyTo/);
  }
  const vesselClick = body(
    vessels,
    /handler\.setInputAction\(\s*\(click\) => \{([\s\S]*?)\n\s*\},\s*Cesium\.ScreenSpaceEventType\.LEFT_CLICK,?\s*\);/,
    'vessel click',
  );
  ordered(vesselClick, [
    "isOwnedByOtherLayer('ais-live-vessels', pickedId)",
    '_vesselOverlayHost.hitTest?.(',
    'selectAndFocusVessel(record)',
  ], 'vessel sibling ownership');
  const vesselFocus = body(
    vessels,
    /function selectAndFocusVessel\(record\) \{([\s\S]*?)\n  \}/,
    'vessel focus helper',
  );
  assert.match(vesselFocus, /requestWorldFocus\(\{/);
  const fireClick = body(
    firms,
    /_clickHandler\.setInputAction\(\(click\) => \{([\s\S]*?)\n    \}, Cesium\.ScreenSpaceEventType\.LEFT_CLICK\);/,
    'fire click',
  );
  ordered(fireClick, [
    'isOwnedByOtherLayer(id, pickedId)',
    'overlayHost.hitTest?.(',
    'selectAndFocusFire(carded)',
  ], 'fire sibling ownership');
});
