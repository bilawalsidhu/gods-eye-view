import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');
const firms = fs.readFileSync(path.join(ROOT, 'src', 'data', 'firmsHeatmap.js'), 'utf8');
const vessels = fs.readFileSync(path.join(ROOT, 'src', 'data', 'aisLiveVessels.js'), 'utf8');
const voice = fs.readFileSync(path.join(ROOT, 'src', 'voice', 'gevActions.js'), 'utf8');
const cameraVerbs = fs.readFileSync(path.join(ROOT, 'src', 'cameraVerbs.js'), 'utf8');

function body(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `${label} is missing`);
  return match[1];
}

function ordered(source, needles, label) {
  let previous = -1;
  for (const needle of needles) {
    const index = source.indexOf(needle);
    assert.ok(index >= 0, `${label}: missing ${needle}`);
    assert.ok(index > previous, `${label}: ${needle} is out of order`);
    previous = index;
  }
}

test('one explicit tracking selection clears sibling IDs before publishing its durable replacement', () => {
  const persist = body(
    ui,
    /_persistAwarenessSelection\(event, cleared = false\) \{([\s\S]*?)\n  \}/,
    'tracking persistence',
  );
  assert.match(persist, /adoptLayerParams\?\.\(layerId,/);
  assert.match(persist, /\['flights', 'selectedFlightsTrackingId'\]/);
  assert.match(persist, /\['military', 'selectedMilitaryTrackingId'\]/);
  assert.match(persist, /\['satellites', 'selectedSatTrackingId'\]/);
  assert.match(persist, /if \(otherLayerId === layerId\) continue;/);
  assert.match(
    persist,
    /for \(const \[otherLayerId, otherKey\][\s\S]*?setLayerParams\(otherLayerId,[\s\S]*?adoptLayerParams\?\.\(layerId,/,
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
  assert.match(stamp, /if \(!passivelyClearedShareSelection && !flightsLayer\.getTrackedInfo\?\.\(\)\)[\s\S]*?selectedFlightsTrackingId: null/);
  assert.match(stamp, /if \(!passivelyClearedShareSelection && !militaryFlightsLayer\.getTrackedInfo\?\.\(\)\)[\s\S]*?selectedMilitaryTrackingId: null/);
  assert.match(stamp, /if \(!passivelyClearedShareSelection && !satellitesLayer\.getTrackedInfo\?\.\(\)\)[\s\S]*?selectedSatTrackingId: null/);
});

test('accepted navigation releases through PR15-aware ownership before flight', () => {
  const run = body(
    ui,
    /_runExplicitNavigation\(noun, navigate, releaseOptions = undefined\) \{([\s\S]*?)\n  \}/,
    'explicit navigation',
  );
  ordered(run, [
    'immersiveViewActive: this._isDroneViewActive()',
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
  assert.match(voice, /runManagedVoiceNavigation\(\s*styleManager, 'camera', 'move_camera', navigate, releaseOptions/);
  assert.match(voice, /runManagedVoiceNavigation\(styleManager, 'route', 'fly_route', navigate/);
  assert.match(voice, /runManagedVoiceNavigation\(styleManager, 'fire', 'track_entity'/);
  assert.match(voice, /runManagedVoiceNavigation\(styleManager, family\.kind, 'track_entity'/);
  assert.match(voice, /runManagedVoiceNavigation\(styleManager, 'frame', 'frame_overhead'/);
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
    "const preserveCameraFlight = motion === 'orbit'",
    'runNavigation(start, { preserveCameraFlight })',
  ], 'move validation before handoff');

  const route = body(
    cameraVerbs,
    /export function flyRoute\(annoList, args = \{\}, floorFn = null, runNavigation = null, warmFn = null\) \{([\s\S]*?)\n\}/,
    'fly route',
  );
  ordered(route, [
    'if (!routes.length)',
    'const pts = route.path.map',
    'const start = () => {',
    "return typeof runNavigation === 'function' ? runNavigation(start) : start();",
  ], 'route validation before handoff');
  // The corridor warm is injected the same way the floor READ is — the dolly
  // never reaches into the data layer itself, and the voice dispatch is the one
  // place that binds both.
  assert.match(voice, /\(lat, lon\) => cachedGroundFloor\(lat, lon\),[\s\S]{0,200}?\(cells\) => warmGroundFloor\(cells\),/);
});

test('deferred search releases only after its final authority check', () => {
  const handler = body(
    ui,
    /this\._locationSearch\.addEventListener\('keydown', async \(e\) => \{([\s\S]*?)\n    \}\);/,
    'search handler',
  );
  ordered(handler, [
    "this._beginDeferredNavigation('location')",
    'this._activeLocationSearchGeneration = generation;',
    'searchAndFlyTo(this.viewer, query',
    'beforeFly: () => this._reassertNavigationHandoff(generation)',
    'generation !== this._navigationGeneration',
    'destination?.cancelled',
    'finally',
    'this._settleLocationSearchUi(generation)',
  ], 'deferred search');
  assert.doesNotMatch(handler.slice(0, handler.indexOf('searchAndFlyTo')), /_releaseFollowCamera/);
});

test('a direct globe gesture retires delayed camera and selection restore only', () => {
  assert.match(
    ui,
    /this\._initialShareGestureHandler = \(\) => \{[\s\S]*?!this\._resolveInitialShareRestore[\s\S]*?stampInitialShareGesture\(\(options\) => this\._stampNavigation\(options\)\);/,
  );
  assert.match(
    ui,
    /viewer\?\.canvas\?\.addEventListener\('pointerdown', this\._initialShareGestureHandler/,
  );
  assert.match(
    ui,
    /viewer\?\.canvas\?\.addEventListener\('wheel', this\._initialShareGestureHandler/,
  );
  assert.match(
    ui,
    /removeEventListener\('pointerdown', this\._initialShareGestureHandler\)[\s\S]*?removeEventListener\('wheel', this\._initialShareGestureHandler\)/,
  );
  const stamp = body(
    ui,
    /_stampNavigation\(\{ cancelPendingSelection = true[^)]*\} = \{\}\) \{([\s\S]*?)\n  \}/,
    'navigation stamp',
  );
  assert.match(stamp, /if \(cancelPendingSelection\) \{[\s\S]*?cancelPendingTrackingRestore/);
  assert.doesNotMatch(stamp, /cancelPendingRestores\(\)/);
});

test('newer navigation, reset, Drone View, and teardown share one generation', () => {
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
    'this._stampNavigation();',
    'this._removeWorldRequestFocusListener?.();',
    'await this._restoreContextSession();',
  ], 'dispose invalidation');
});

test('teardown synchronously closes immediate camera entry points', () => {
  const dispose = body(ui, /async dispose\(\) \{([\s\S]*?)\n  \}/, 'dispose');
  ordered(dispose, [
    'this._disposed = true;',
    'this._removeCctvRequestFocusListener?.();',
    'this._removeWorldRequestFocusListener?.();',
    'this._navigationOwnerChangedRemover?.();',
    'await this._restoreContextSession();',
  ], 'synchronous teardown barrier');

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
  const deferred = body(
    ui,
    /_beginDeferredNavigation\(noun = 'location', \{ cancelPendingSelection = true \} = \{\}\) \{([\s\S]*?)\n  \}/,
    'deferred navigation',
  );
  assert.match(deferred, /disposed: this\._disposed/);

  const handler = body(
    ui,
    /this\._locationSearch\.addEventListener\('keydown', async \(e\) => \{([\s\S]*?)\n    \}\);/,
    'search handler',
  );
  ordered(handler, [
    "const generation = this._beginDeferredNavigation('location');",
    'if (generation === false)',
    'this._locationSearch.blur();',
    'searchAndFlyTo(this.viewer, query',
  ], 'disposed search refusal');
  assert.match(handler, /if \(generation === false\) \{[\s\S]*?return;[\s\S]*?\}\s*this\._activeLocationSearchGeneration/);
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
    /handler\.setInputAction\(\(click\) => \{([\s\S]*?)\n  \}, Cesium\.ScreenSpaceEventType\.LEFT_CLICK\);/,
    'vessel click',
  );
  ordered(vesselClick, [
    "isOwnedByOtherLayer('ais-live-vessels', pickedId)",
    '_vesselOverlayHost.hitTest?.(',
    'selectAndFocusVessel(record)',
  ], 'vessel sibling ownership');
  const vesselFocus = body(
    vessels,
    /function selectAndFocusVessel\(record\) \{([\s\S]*?)\n\}/,
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
