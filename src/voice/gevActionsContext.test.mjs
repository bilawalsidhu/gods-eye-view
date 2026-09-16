// src/voice/gevActionsContext.test.mjs
// The scene-context subsystem of the voice actions (get_entity_context,
// get_basemap_label_context, and the geocode/nearby/summarize machinery under
// them) plus the annotation, scene-playback, camera-zoom, and framing actions.
// The whole battery runs against stub viewers/fetch — the real Cesium math
// (Cartographic/points/distance) does the geometry, so a broken seam fails.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { getContextStore, registerEntityContext, selectEntityContext } from '../data/contextStore.js';
import { createGevActionRunner, getBasemapLabelContext } from './gevActions.js';

// ─── Browser globals ────────────────────────────────────────────────────────
// Installed once per process; the actions read these lazily at call time.
globalThis.window = {
  setTimeout,
  clearTimeout,
  requestIdleCallback: null,
  dispatchEvent() {},
  __GOOGLE_MAPS_API_KEY__: 'test-gev-key',
  __godsEyeView: { tileset: { readyPromise: Promise.resolve() } },
};
globalThis.CSS = globalThis.CSS || { escape: (s) => String(s).replace(/"/g, '\\"') };

// ─── Fetch router ───────────────────────────────────────────────────────────
const calls = { geocode: [], nearby: [] };
let geocodePayload = null;
let nearbyPayload = { places: [] };

function setGeocode(payload) { geocodePayload = payload; }
function setNearby(payload) { nearbyPayload = payload; }
function resetCalls() { calls.geocode.length = 0; calls.nearby.length = 0; }

const prevFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('maps.googleapis.com/maps/api/geocode')) {
    calls.geocode.push(u);
    return new Response(JSON.stringify(geocodePayload), { headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/api/google/nearby-places')) {
    calls.nearby.push(u);
    return new Response(JSON.stringify(nearbyPayload), { headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`context harness: unexpected fetch ${u}`);
};
after(() => { globalThis.fetch = prevFetch; });

const AUSTIN_GEOCODE = {
  status: 'OK',
  results: [
    {
      formatted_address: '1200 Congress Ave, Austin, TX 78701, USA',
      types: ['premise'],
      address_components: [
        { long_name: 'Austin', types: ['locality', 'political'] },
        { long_name: 'Travis County', types: ['administrative_area_level_2'] },
        { long_name: 'Texas', types: ['administrative_area_level_1'] },
        { long_name: 'United States', types: ['country', 'political'] },
        { long_name: 'Congress Avenue', types: ['route'] },
      ],
    },
    {
      formatted_address: 'Downtown Austin, Austin, TX, USA',
      address_components: [{ long_name: 'Congress Avenue', types: ['route'] }],
    },
  ],
};

// ─── Viewer harness ─────────────────────────────────────────────────────────
/**
 * A viewer whose camera sits `height` meters above (-97.74, 30.26) looking at
 * `view` — the pick ellipsoid always answers with the view target, so the
 * context code reads one coherent place. `zoom` hooks let the zoom tests move
 * the camera for real.
 */
function makeViewer({ height = 500, view = [30.2747, -97.7403], zoom = null } = {}) {
  const [viewLat, viewLon] = view;
  // The camera hovers DIRECTLY above the view target, so target distance ==
  // height and the zoom arithmetic is exactly predictable.
  let position = Cesium.Cartesian3.fromDegrees(viewLon, viewLat, height);
  const viewTarget = Cesium.Cartesian3.fromDegrees(viewLon, viewLat, 0);
  const op = { requestRender: 0, zoomIn: [], zoomOut: [], cancelFlight: 0, flewTo: null };
  const viewer = {
    trackedEntity: undefined,
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: {
      canvas: {
        clientWidth: 1200,
        clientHeight: 800,
        addEventListener() {},
        removeEventListener() {},
      },
      requestRender() { op.requestRender += 1; },
      globe: { getHeight: () => 0, pick: () => null },
      tweens: [],
    },
    camera: {
      moveEnd: new Cesium.Event(),
      positionWC: position,
      positionCartographic: Cesium.Cartographic.fromCartesian(position),
      heading: Cesium.Math.toRadians(28),
      pitch: Cesium.Math.toRadians(-45),
      pickEllipsoid: () => viewTarget,
      cancelFlight() { op.cancelFlight += 1; },
      flyToBoundingSphere(sphere) { op.flewTo = sphere; },
      lookAtTransform() {},
      zoomIn(meters) {
        op.zoomIn.push(meters);
        step(viewer, viewTarget, meters);
      },
      zoomOut(meters) {
        op.zoomOut.push(meters);
        step(viewer, viewTarget, -meters);
      },
    },
  };
  function step(cam, target, meters) {
    const dir = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(target, cam.camera.positionWC, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    position = Cesium.Cartesian3.add(
      cam.camera.positionWC,
      Cesium.Cartesian3.multiplyByScalar(dir, meters, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    cam.camera.positionWC = position;
    cam.camera.positionCartographic = Cesium.Cartographic.fromCartesian(position);
  }
  if (zoom) Object.assign(viewer.camera, zoom);
  return { viewer, op, viewTarget };
}

function makeDataManager({ layers = ['flights'], hiddenInPanel = [] } = {}) {
  const CATALOG = {
    flights: { name: 'Flights', source: 'adsb.lol' },
    military: { name: 'Military', source: 'adsb.lol' },
    'ais-live-vessels': { name: 'Vessels', source: 'AISStream' },
  };
  const all = layers.map((id) => ({
    id,
    name: CATALOG[id]?.name || id,
    source: CATALOG[id]?.source || 'test',
    enabled: true,
    showInTogglePanel: !hiddenInPanel.includes(id),
    stats: { count: 2 },
  }));
  return {
    layers: new Map(all.map((l) => [l.id, { id: l.id, module: {} }])),
    isEnabled: (id) => all.some((l) => l.id === id),
    getAll: () => all,
  };
}

function makeStyleManager(overrides = {}) {
  const op = { style: [], panels: [], mapStacks: [], hud: [], post: [] };
  const styleManager = {
    activeStyle: 'normal',
    setStyle: (style) => { op.style.push(style); return { ok: true, style }; },
    setPanelCollapsed: (panelId, collapsed, opts) => { op.panels.push([panelId, collapsed, opts]); },
    setMapStack: async (stackId) => { op.mapStacks.push(stackId); return { ok: true, stack: stackId }; },
    setHudLayout: (layout) => { op.hud.push(['layout', layout]); return { ok: true, layout }; },
    setHudVisible: (visible) => { op.hud.push(['visible', visible]); return { ok: true, visible }; },
    getControlState: () => ({ hud: { layout: 'compact', visible: true } }),
    setBloom: (patch) => { op.post.push(['bloom', patch]); return { ok: true, bloom: patch }; },
    setSharpen: (patch) => { op.post.push(['sharpen', patch]); return { ok: true, sharpen: patch }; },
    runImmediateNavigation: (noun, navigate) => navigate(),
    getDetectionState: () => ({ detectionMode: 'OFF' }),
    setDetection: (patch) => ({ ok: true, ...patch }),
    ...overrides,
  };
  return { styleManager, op };
}

function resetStore() {
  const store = getContextStore();
  store.entities.clear();
  store.selectedEntityId = null;
  store.selectedAt = null;
}

// ═══════════════════════ Annotation actions ═══════════════════════

function makeAnnotations(result) {
  const op = { annotate: [], cleared: 0 };
  return {
    op,
    annotate: async (requests, options) => { op.annotate.push([requests, options]); return result; },
    clear: () => { op.cleared += 1; },
  };
}

test('annotate_map bounds the request, never clears as a side effect, and reports partial failure honestly', async () => {
  const { viewer } = makeViewer();
  const runner = createGevActionRunner({
    viewer,
    styleManager: makeStyleManager().styleManager,
    dataManager: makeDataManager(),
    annotations: makeAnnotations({
      drawn: 1,
      failed: 1,
      results: [
        { ok: true, target: 'Austin', fallback: true, outlinePending: true },
        { ok: false, failedTargets: ['Nowhereville', 'Ghost Town'] },
      ],
      capped: false,
    }),
  });

  const longTarget = 'x'.repeat(500);
  const result = await runner('annotate_map', {
    annotations: [
      { type: 'mark', target: longTarget, label: 'y'.repeat(300) },
      { type: 'route', points: Array.from({ length: 30 }, (_, i) => ({ target: `w${i}` })) },
    ],
    flyTo: true,
  });

  assert.equal(result.drawn, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.partial, true, 'a mixed draw is partial, not clean');
  assert.deepEqual(result.failedLabels, ['Nowhereville', 'Ghost Town']);
  assert.equal(result.routeFallback, true, 'a direct-line route is flagged');
  assert.equal(result.outlinePending, true);
  assert.equal(result.error, 'Could not place one or more annotations');
  assert.equal(result.ok, true, 'some marks did land');
  assert.equal(result.capped, false);
});

test('annotate_map clamps free text, slices oversized routes, and forwards persist/flyTo', async () => {
  const { viewer } = makeViewer();
  const annotations = makeAnnotations({ drawn: 1, failed: 0, results: [{ ok: true, target: 'a' }] });
  const runner = createGevActionRunner({
    viewer,
    styleManager: makeStyleManager().styleManager,
    dataManager: makeDataManager(),
    annotations,
  });

  const result = await runner('annotate_map', {
    annotations: [{ type: 'mark', target: 't'.repeat(400), label: 'l'.repeat(400) }],
    persist: false,
    flyTo: true,
  });

  const [requests, options] = annotations.op.annotate[0];
  assert.equal(requests[0].target.length, 200, 'target clamped to MAX_TARGET_LEN');
  assert.equal(requests[0].label.length, 120, 'label clamped to MAX_LABEL_LEN');
  assert.equal(options.clearPrevious, false, 'voice drawing must never clear the board');
  assert.equal(options.persist, false, 'persist:false is honored');
  assert.equal(options.flyTo, true);
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.partial, false, 'a clean draw is not partial');
  assert.equal(result.failedLabels, undefined);
});

test('annotate_map refuses oversized batches and empty boards before touching the engine', async () => {
  const { viewer } = makeViewer();
  const annotations = makeAnnotations({ drawn: 0, failed: 0, results: [] });
  const runner = createGevActionRunner({
    viewer,
    styleManager: makeStyleManager().styleManager,
    dataManager: makeDataManager(),
    annotations,
  });

  const tooMany = await runner('annotate_map', {
    annotations: Array.from({ length: 25 }, (_, i) => ({ target: `p${i}` })),
  });
  assert.match(tooMany.error, /Too many annotations in one call \(25\); max 24/);

  const empty = await runner('annotate_map', {});
  assert.equal(empty.error, 'No annotations supplied');
  assert.equal(annotations.op.annotate.length, 0, 'the engine never saw a rejected call');

  const noEngine = await createGevActionRunner({
    viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager(),
  })('annotate_map', { annotations: [{ target: 'a' }] });
  assert.equal(noEngine.error, 'Annotation engine unavailable');
});

test('annotate_map reports a total failure with unnamed-place fallbacks, not injected place text', async () => {
  const { viewer } = makeViewer();
  const runner = createGevActionRunner({
    viewer,
    styleManager: makeStyleManager().styleManager,
    dataManager: makeDataManager(),
    annotations: makeAnnotations({
      drawn: 0,
      failed: 2,
      results: [{ ok: false }, { ok: false, label: 'has caption only' }],
    }),
  });
  const result = await runner('annotate_map', { annotations: [{ target: 'a' }, { target: 'b' }] });
  assert.equal(result.ok, false);
  assert.equal(result.partial, false, 'nothing drew, so this is not "partial"');
  assert.deepEqual(result.failedLabels, ['an unnamed place', 'has caption only']);
  assert.equal(result.error, 'Could not place one or more annotations');
});

test('clear_annotations calls the engine wipe and reports an absent engine truthfully', async () => {
  const { viewer } = makeViewer();
  const annotations = makeAnnotations(null);
  const runner = createGevActionRunner({
    viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager(), annotations,
  });
  assert.deepEqual(await runner('clear_annotations', {}), { ok: true, action: 'clear_annotations' });
  assert.equal(annotations.op.cleared, 1);

  const bare = createGevActionRunner({
    viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager(),
  });
  assert.deepEqual(await bare('clear_annotations', {}), {
    ok: false, action: 'clear_annotations', error: 'Annotation engine unavailable',
  });
});

// ═══════════════════════ Scene playback ═══════════════════════

function makeSceneDirector({ scenes = null, running = false } = {}) {
  const op = { started: [], stopped: 0, next: 0 };
  const list = scenes || [
    { id: 'orbit-austin', title: 'Austin Orbit', shots: 4 },
    { id: 'dive-sf', title: 'SF Dive', shots: 3 },
  ];
  return {
    op,
    running,
    listScenes: () => list,
    getPlaybackStatus: () => ({ running, shotIndex: 0 }),
    findSceneByQuery: (q) => list.find((s) => s.id.includes(q) || s.title.toLowerCase().includes(String(q).toLowerCase())) || null,
    startScene: (id, opts) => { op.started.push([id, opts]); },
    stopScene: () => { op.stopped += 1; },
    runNextScene: () => { op.next += 1; },
  };
}

test('control_scene covers list, status, stop, next, and fire-and-forget play', async () => {
  const { viewer } = makeViewer();
  const director = makeSceneDirector();
  const runner = createGevActionRunner({
    viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager(), sceneDirector: director,
  });

  const listed = await runner('control_scene', { action: 'list' });
  assert.equal(listed.ok, true);
  assert.equal(listed.scenes.length, 2);
  assert.equal(listed.running, false, 'playback status is merged into the list result');

  assert.deepEqual((await runner('control_scene', { action: 'status' })).shotIndex, 0);

  await runner('control_scene', { action: 'stop' });
  assert.equal(director.op.stopped, 1);

  assert.deepEqual(await runner('control_scene', { action: 'next' }), { ok: true, action: 'control_scene', advanced: true });
  assert.equal(director.op.next, 1);

  const played = await runner('control_scene', { action: 'play' });
  assert.equal(played.playing, 'Austin Orbit', 'no sceneId plays the first scene');
  assert.deepEqual(director.op.started[0], ['orbit-austin', { single: true }], 'voice play is single-scene');

  const byQuery = await runner('control_scene', { action: 'play', sceneId: 'dive' });
  assert.equal(byQuery.playing, 'SF Dive');

  const noDirector = await createGevActionRunner({
    viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager(),
  })('control_scene', { action: 'list' });
  assert.equal(noDirector.error, 'Scene director unavailable');
});

test('control_scene refuses a second play and unknown actions; a missed query names the miss', async () => {
  const { viewer } = makeViewer();
  const runner = createGevActionRunner({
    viewer,
    styleManager: makeStyleManager().styleManager,
    dataManager: makeDataManager(),
    sceneDirector: makeSceneDirector({ running: true }),
  });

  const busy = await runner('control_scene', { action: 'play' });
  assert.equal(busy.ok, false);
  assert.match(busy.error, /already running/);

  const miss = await createGevActionRunner({
    viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager(),
    sceneDirector: makeSceneDirector(),
  })('control_scene', { action: 'play', sceneId: 'nonexistent' });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /No scene matched "nonexistent"/);
  assert.equal(miss.scenes.length, 2, 'the miss result carries the inventory');

  await assert.rejects(() => runner('control_scene', { action: 'rewind' }), /Unknown scene action: rewind/);
});

// ═══════════════════════ Style / panel / map stack / HUD ═══════════════════════

test('set_visual_style maps spoken aliases and rejects unknown styles without side effects', async () => {
  const { viewer } = makeViewer();
  const { styleManager, op } = makeStyleManager();
  const runner = createGevActionRunner({ viewer, styleManager, dataManager: makeDataManager() });

  assert.deepEqual(await runner('set_visual_style', { style: 'nvg' }), { ok: true, action: 'set_visual_style', style: 'surveillance' });
  assert.deepEqual(await runner('set_visual_style', { style: 'flir' }), { ok: true, action: 'set_visual_style', style: 'thermal' });
  assert.deepEqual(await runner('set_visual_style', { style: 'off' }), { ok: true, action: 'set_visual_style', style: 'normal' });
  assert.deepEqual(op.style, ['surveillance', 'thermal', 'normal']);

  await assert.rejects(() => runner('set_visual_style', { style: 'hologram' }), /Unknown visual style: hologram/);
  await assert.rejects(() => runner('set_visual_style', {}), /Unknown visual style: missing/);
  assert.equal(op.style.length, 3, 'rejected styles never reach the style manager');
});

test('set_panel_open normalizes panel aliases and honors the closed direction', async () => {
  const { viewer } = makeViewer();
  const { styleManager, op } = makeStyleManager();
  const runner = createGevActionRunner({ viewer, styleManager, dataManager: makeDataManager() });

  assert.deepEqual(await runner('set_panel_open', { panel: 'cctv' }), { ok: true, action: 'set_panel_open', panelId: 'cctv-panel', open: true });
  assert.deepEqual(await runner('set_panel_open', { panelId: 'radio-panel', open: false }), { ok: true, action: 'set_panel_open', panelId: 'radio-panel', open: false });
  assert.deepEqual(op.panels, [
    ['cctv-panel', false, { explicit: true }],
    ['radio-panel', true, { explicit: true }],
  ], 'the UI seam is setPanelCollapsed with the open state inverted');

  await assert.rejects(() => runner('set_panel_open', { panelId: 'nope' }), /Unknown panel: nope/);
  await assert.rejects(() => runner('set_panel_open', {}), /Unknown panel: missing/);
});

test('set_map_stack normalizes spoken basemap names to stack ids', async () => {
  const { viewer } = makeViewer();
  const { styleManager, op } = makeStyleManager();
  const runner = createGevActionRunner({ viewer, styleManager, dataManager: makeDataManager() });

  const google = await runner('set_map_stack', { stack: 'Google' });
  assert.equal(google.requested, 'photoreal');
  const roads = await runner('set_map_stack', { stack: 'road map' });
  assert.equal(roads.requested, 'osm');
  const labels = await runner('set_map_stack', { stack: 'aerial with labels' });
  assert.equal(labels.requested, 'bing-labels');
  assert.deepEqual(op.mapStacks, ['photoreal', 'osm', 'bing-labels']);

  await assert.rejects(() => runner('set_map_stack', { stack: 'hologram' }), /Unknown map stack: hologram/);
  await assert.rejects(() => runner('set_map_stack', {}), /Unknown map stack: missing/);
});

test('set_hud and set_post_processing forward only the provided fields with coerced numbers', async () => {
  const { viewer } = makeViewer();
  const { styleManager, op } = makeStyleManager();
  const runner = createGevActionRunner({ viewer, styleManager, dataManager: makeDataManager() });

  const hud = await runner('set_hud', { layout: 'compact', visible: true });
  assert.equal(hud.ok, true);
  assert.deepEqual(hud.hud, { layout: 'compact', visible: true }, 'the result reports the settled HUD state');
  assert.deepEqual(op.hud, [['layout', 'compact'], ['visible', true]]);

  styleManager.setHudLayout = () => ({ ok: false, error: 'no such layout' });
  const failed = await runner('set_hud', { layout: 'impossible' });
  assert.equal(failed.ok, false);
  assert.equal(failed.action, 'set_hud');

  const post = await runner('set_post_processing', {
    bloom: { enabled: true, intensityPct: '55' },
    sharpen: { enabled: false, intensityPct: 'not-a-number' },
  });
  assert.equal(post.ok, true);
  assert.deepEqual(op.post, [
    ['bloom', { enabled: true, intensityPct: 55 }],
    ['sharpen', { enabled: false, intensityPct: undefined }],
  ], 'numeric strings coerce; junk numbers stay undefined');
});

test('unknown tool names are rejected, not silently ignored', async () => {
  const { viewer } = makeViewer();
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager() });
  await assert.rejects(() => runner('teleport_everywhere', {}), /Unknown GEV tool: teleport_everywhere/);
});

// ═══════════════════════ Camera zoom ═══════════════════════

test('adjust_camera_zoom validates direction and amount before touching the camera', async () => {
  const { viewer } = makeViewer();
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager() });
  await assert.rejects(() => runner('adjust_camera_zoom', { direction: 'sideways' }), /direction must be "in" or "out"/);
  await assert.rejects(() => runner('adjust_camera_zoom', { direction: 'in', amount: 'lots' }), /Unknown zoom amount: lots/);
});

test('adjust_camera_zoom zooms in toward the view target and reports real movement', async () => {
  const { viewer, op } = makeViewer({ height: 1000 });
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager() });
  const result = await runner('adjust_camera_zoom', { direction: 'in', amount: 'medium' });
  assert.equal(result.ok, true);
  assert.equal(result.direction, 'in');
  assert.equal(result.amount, 'medium');
  // 1000 m camera → ~1000 m target distance; medium = 55%.
  assert.equal(result.movementRequestedM, Math.round(1000 * 0.55));
  assert.equal(result.movementActualM, result.movementRequestedM);
  assert.equal(op.zoomIn.length, 1);
  assert.equal(op.requestRender, 1, 'the zoom re-renders the frozen frame');
  assert.equal(result.error, null);
});

test('adjust_camera_zoom zoom-out always has headroom and clamps to a floor', async () => {
  const { viewer, op } = makeViewer({ height: 100 });
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager() });
  const result = await runner('adjust_camera_zoom', { direction: 'out', amount: 'lot' });
  assert.equal(result.ok, true);
  assert.equal(result.movementRequestedM, Math.max(50, 100), 'the 50 m floor beats a tiny fraction');
  assert.equal(op.zoomOut.length, 1);
});

test('adjust_camera_zoom refuses to push through the target and reports an unmoved camera', async () => {
  // The camera hovers 20 m above its target: zoom-in has less than the 25 m
  // buffer, so the movement would overshoot and is refused outright.
  const { viewer, op } = makeViewer({ height: 20 });
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager() });
  const blocked = await runner('adjust_camera_zoom', { direction: 'in', amount: 'little' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'Camera is already at the minimum target distance');
  assert.equal(op.zoomIn.length, 0);

  const frozen = makeViewer({ height: 1000, zoom: { zoomIn() { /* camera does not move */ } } });
  const frozenRunner = createGevActionRunner({
    viewer: frozen.viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager(),
  });
  const stalled = await frozenRunner('adjust_camera_zoom', { direction: 'in', amount: 'medium' });
  assert.equal(stalled.ok, false);
  assert.equal(stalled.error, 'Cesium camera position did not change');
});

// ═══════════════════════ ISS pass + framing ═══════════════════════

test('next_iss_pass answers from the camera position and reports unloaded orbital elements honestly', async (t) => {
  const { viewer } = makeViewer({ height: 500, view: [30.27, -97.74] });
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager() });
  t.after(() => resetStore());

  const fromCamera = await runner('next_iss_pass', {});
  assert.equal(fromCamera.action, 'next_iss_pass');
  assert.equal(fromCamera.ok, false);
  assert.match(fromCamera.error, /orbital elements not loaded/i,
    'a cold process has no ISS TLE — say so instead of inventing a pass');

  // Explicit coordinates take the same argument path but still find no TLE
  // in a cold process — the gate precedes any pass math.
  const explicit = await runner('next_iss_pass', { latitude: 51.5, longitude: -0.12, minElevationDeg: 25 });
  assert.equal(explicit.ok, false);
  assert.match(explicit.error, /orbital elements not loaded/i);

  const noCamera = createGevActionRunner({
    viewer: {
      clock: { onTick: { addEventListener: () => () => {} } },
      scene: { canvas: { clientWidth: 1200, clientHeight: 800, addEventListener() {}, removeEventListener() {} } },
      camera: { moveEnd: new Cesium.Event() },
    },
    styleManager: makeStyleManager().styleManager, dataManager: makeDataManager(),
  });
  await assert.rejects(() => noCamera('next_iss_pass', {}), /Camera position unavailable/);
});

test('frame_overhead validates the layer, frames the nearest cohort, and survives a dead detection facade', async () => {
  const { viewer, op } = makeViewer({ height: 5000 });
  const dataManager = makeDataManager();
  dataManager.layers.set('flights', {
    id: 'flights',
    module: {
      getNearby: () => ([
        { icao24: 'ae1fa4', callsign: 'SWA696', position: Cesium.Cartesian3.fromDegrees(-97.74, 30.26, 10000) },
        { icao24: 'ae99b1', callsign: null, name: 'N99', position: Cesium.Cartesian3.fromDegrees(-97.70, 30.22, 11000) },
      ]),
    },
  });
  let detectionThrew = false;
  const { styleManager } = makeStyleManager({
    getDetectionState: () => { if (detectionThrew) throw new Error('facade gone'); return { detectionMode: 'OFF' }; },
  });
  const runner = createGevActionRunner({ viewer, styleManager, dataManager });

  const framed = await runner('frame_overhead', { target: 'planes' });
  assert.equal(framed.ok, true);
  assert.equal(framed.layerId, 'flights');
  assert.equal(framed.count, 2);
  assert.equal(framed.detectionEnabled, true, 'OFF detection is switched to dense by framing');
  assert.deepEqual(framed.nearest[0], { id: 'ae1fa4', label: 'SWA696' });
  assert.ok(op.flewTo, 'the camera flew to the cohort bounding sphere');
  assert.ok(op.flewTo.radius >= 8000, 'the sphere keeps a minimum framing radius');

  detectionThrew = true;
  const resilient = await runner('frame_overhead', { target: 'aircraft', radiusKm: 40 });
  assert.equal(resilient.ok, true, 'a broken detection facade never fails the framing');
  assert.equal(resilient.detectionEnabled, false);
  assert.equal(resilient.radiusKm, 40, 'clamped radius is echoed, not the default');
});

test('frame_overhead falls back to getAllPositions, filters by radius, and reports empty skies', async () => {
  const { viewer } = makeViewer({ height: 50000 });
  const near = (dLon) => Cesium.Cartesian3.fromDegrees(-97.74 + dLon, 30.26, 5000);
  const dataManager = makeDataManager({ layers: ['flights'] });
  dataManager.layers.set('flights', {
    id: 'flights',
    module: {
      getAllPositions: () => ([
        { id: 'far', position: Cesium.Cartesian3.fromDegrees(-80.0, 30.26, 5000) },
        { id: 'near-2', position: near(0.2) },
        { id: 'near-1', position: near(0.1) },
        { id: 'no-position', position: null },
      ]),
    },
  });
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager });

  const framed = await runner('frame_overhead', {});
  assert.equal(framed.ok, true);
  assert.equal(framed.count, 2, 'entries beyond the radius and without positions are dropped');
  assert.equal(framed.nearest[0].id, 'near-1', 'the cohort is nearest-first');

  dataManager.layers.set('flights', { id: 'flights', module: { getNearby: () => [] } });
  const empty = await runner('frame_overhead', { target: 'planes' });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /No planes within 150 km/);

  const unknown = await runner('frame_overhead', { target: 'weather-balloons' });
  assert.equal(unknown.ok, false, 'an unknown family falls back to a raw layer id lookup');
});

// ═══════════════════════ Entity context ═══════════════════════

test('get_entity_context scope=selected returns the selected record with full scene truth', async (t) => {
  t.after(() => resetStore());
  resetStore();
  setGeocode(AUSTIN_GEOCODE);
  setNearby({ places: [] });
  const { viewer } = makeViewer({ height: 500, view: [30.2747, -97.7403] });
  const dataManager = makeDataManager({ layers: ['flights'] });
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager });

  const entity = { id: 'ae1fa4', __localLayerId: 'flights' };
  registerEntityContext(entity, {
    id: 'ac-sel', layerId: 'flights', label: 'N123AB', source: 'adsb.lol', layerName: 'Flights',
    latitude: 30.27, longitude: -97.74,
    properties: { name: 'N123AB', icao24: 'ae1fa4', junk: { nested: true }, operator: 'Southwest' },
  });
  selectEntityContext(entity);

  const result = await runner('get_entity_context', { scope: 'selected' });
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'selected');
  assert.equal(result.selected.id, 'ac-sel');
  assert.equal(result.selected.name, 'N123AB');
  assert.equal(result.selected.layerName, 'Flights');
  assert.equal(result.selected.active, true, 'the layer is enabled, so the selection is live');
  assert.deepEqual(result.selected.properties, { name: 'N123AB', operator: 'Southwest', icao24: 'ae1fa4' },
    'properties are compacted to flat text; nested objects are dropped');

  assert.equal(result.scene.camera.heightM, 500);
  assert.equal(result.scene.style, 'normal');
  assert.deepEqual(result.scene.enabledLayers, [{ id: 'flights', name: 'Flights', count: 2, source: 'adsb.lol' }]);
  assert.equal(result.scene.basemap.place.country, 'United States');
  assert.deepEqual(result.scene.basemap.place.streetLabels, ['Congress Avenue']);
  assert.match(result.scene.basemap.source, /Google Photorealistic/);
});

test('get_entity_context in-view scan returns nearest-to-center screen entities and honors every filter', async (t) => {
  t.after(() => resetStore());
  resetStore();
  setGeocode({ status: 'ZERO_RESULTS' });
  setNearby({ places: [] });
  const { viewer } = makeViewer({ height: 8000, view: [30.41, -97.81] });

  const realW2W = Cesium.SceneTransforms.worldToWindowCoordinates;
  Cesium.SceneTransforms.worldToWindowCoordinates = (scene, position) => {
    const lat = Cesium.Math.toDegrees(Cesium.Cartographic.fromCartesian(position).latitude);
    return lat > 30.42 ? { x: 5000, y: 5000 } : { x: 610, y: 390 };
  };
  t.after(() => { Cesium.SceneTransforms.worldToWindowCoordinates = realW2W; });

  const mk = (id, lat, lon, withPosition = true, show = true) => {
    const entity = { id, show };
    if (withPosition) entity.__localBaseCartesian = Cesium.Cartesian3.fromDegrees(lon, lat, 9000);
    return entity;
  };
  registerEntityContext(mk('ae-near', 30.410, -97.810), {
    id: 'ac-near', layerId: 'flights', label: 'NEAR1', latitude: 30.410, longitude: -97.810, layerName: 'Flights',
  });
  registerEntityContext(mk('ae-far', 30.400, -97.800), {
    id: 'ac-far', layerId: 'flights', label: 'FAR2', latitude: 30.400, longitude: -97.800, layerName: 'Flights',
  });
  registerEntityContext(mk('ae-off', 30.450, -97.850), {
    id: 'ac-off', layerId: 'flights', label: 'OFFSCREEN', latitude: 30.450, longitude: -97.850,
  });
  registerEntityContext(mk('ae-nopos', 30.460, -97.860, false), {
    id: 'ac-nopos', layerId: 'flights', label: 'NOPOS', latitude: 30.460, longitude: -97.860,
  });
  registerEntityContext(mk('ae-hidden', 30.415, -97.815, true, false), {
    id: 'ac-hidden', layerId: 'flights', label: 'HIDDEN', latitude: 30.415, longitude: -97.815,
  });
  registerEntityContext(mk('ae-vessel', 30.412, -97.812), {
    id: 'ac-vessel', layerId: 'ais-live-vessels', label: 'EVER GIVEN', latitude: 30.412, longitude: -97.812,
  });

  const dataManager = makeDataManager({ layers: ['flights'] });
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager });
  const result = await runner('get_entity_context', { scope: 'auto', layerId: 'flights' });

  assert.equal(result.ok, true);
  assert.equal(result.scope, 'in_view');
  assert.deepEqual(result.visible.map((v) => v.id), ['ac-near', 'ac-far'],
    'on-screen entities sort by pixel distance from center; off-screen, hidden, positionless, and other-layer records are excluded');
  assert.equal(result.count, 2);
  assert.equal(result.visibleScanSkipped, false);
  assert.equal(result.selected, null);
});

test('get_entity_context skips the visible scan above 100 km and says so', async (t) => {
  t.after(() => resetStore());
  resetStore();
  setGeocode({ status: 'ZERO_RESULTS' });
  setNearby({ places: [] });
  const { viewer } = makeViewer({ height: 200000, view: [31.50, -96.10] });
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager() });

  const result = await runner('get_entity_context', {});
  assert.equal(result.scope, 'in_view');
  assert.deepEqual(result.visible, []);
  assert.equal(result.count, 0);
  assert.equal(result.visibleScanSkipped, true, 'a 200 km camera cannot see entity chips; claim the skip');
});

// ═══════════════════════ Scene / basemap context truth ═══════════════════════

test('scene context classifies global scale and answers with the coarse global place, not an invented address', async (t) => {
  t.after(() => resetStore());
  resetStore();
  resetCalls();
  setGeocode(AUSTIN_GEOCODE);
  const { viewer } = makeViewer({ height: 15000000, view: [30.0, -97.0] });
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager() });

  const result = await runner('get_entity_context', { scope: 'auto' });
  const basemap = result.scene.basemap;
  assert.equal(basemap.viewScale, 'global');
  assert.equal(basemap.place.formattedAddress, 'Global Earth view');
  assert.match(basemap.place.note, /do not infer a local place/);
  assert.equal(basemap.hasGoogle3DTiles, true);
  assert.deepEqual(basemap.knownLandmarks, [], 'no landmark query runs at 15,000 km');
  assert.deepEqual(basemap.nearbyPlaces, []);
  assert.equal(basemap.target.latitude, 30);
  assert.equal(calls.geocode.length, 0, 'geocoding is skipped at global scale');
});

test('scene context at continental range falls back to a country-attributed approximate place', async (t) => {
  t.after(() => resetStore());
  resetStore();
  resetCalls();
  setGeocode(AUSTIN_GEOCODE);
  const { viewer } = makeViewer({ height: 5000000, view: [32.0, -98.0] });
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager() });

  const basemap = (await runner('get_entity_context', {})).scene.basemap;
  assert.equal(basemap.viewScale, 'continental');
  assert.equal(basemap.place.formattedAddress, 'Continental basemap view over United States',
    'the sampled viewport attributes the view to a country');
  assert.equal(basemap.place.country, 'United States');
  assert.equal(basemap.place.precision, 'continental');
  assert.match(basemap.place.note, /approximate basemap context/);
  assert.equal(calls.geocode.length, 0, 'point reverse-geocoding is skipped above 750 km');
});

test('scene context at city range names curated landmarks near the view target', async (t) => {
  t.after(() => resetStore());
  resetStore();
  resetCalls();
  setGeocode(AUSTIN_GEOCODE);
  setNearby({ places: [] });
  const { viewer } = makeViewer({ height: 2000, view: [30.2747, -97.7403] });
  const runner = createGevActionRunner({ viewer, styleManager: makeStyleManager().styleManager, dataManager: makeDataManager() });

  const basemap = (await runner('get_entity_context', {})).scene.basemap;
  assert.equal(basemap.viewScale, 'local', '2 km altitude is building scale');
  assert.equal(basemap.knownLandmarks[0]?.name, 'Texas State Capitol');
  assert.equal(basemap.knownLandmarks[0]?.cityId, 'austin');
  assert.ok(basemap.knownLandmarks[0]?.distanceKm < 0.1, 'the capitol is the view target itself');
  assert.equal(basemap.place.formattedAddress, '1200 Congress Ave, Austin, TX 78701, USA',
    'the second read at the same point is served from the seeded geocode cache');
});

// ═══════════════════════ Basemap label context (HUD summary feed) ═══════════════════════

test('get_basemap_label_context merges place, street, and nearby labels with hostile text sanitized', async () => {
  resetCalls();
  setGeocode({
    status: 'OK',
    results: [{
      formatted_address: 'Evil\nPlace\tWithControl, Austin, TX, USA',
      address_components: [
        { long_name: 'Austin', types: ['locality'] },
        { long_name: 'Texas', types: ['administrative_area_level_1'] },
        { long_name: 'United States', types: ['country'] },
        { long_name: 'Congress Avenue', types: ['route'] },
      ],
    }],
  });
  setNearby({ places: [
    { name: 'Capitol Grill', address: '1200 Congress Ave' },
    { name: 'No Name Skip', address: null },
    { name: null, address: 'should be dropped' },
  ] });

  const { viewer } = makeViewer({ height: 400, view: [30.2674, -97.7434] });
  const labels = await getBasemapLabelContext(viewer);

  assert.deepEqual(labels.placeLabels, [
    'Evil Place With Control, Austin, TX, USA',
    'Austin',
    'Texas',
    'United States',
  ], 'control characters collapse to spaces; one label per address line');
  assert.deepEqual(labels.streetLabels, ['Congress Avenue']);
  assert.deepEqual(labels.nearbyPlaceLabels, ['Capitol Grill', '1200 Congress Ave', 'No Name Skip'],
    'named places survive with their address optional; truly unnamed places are dropped');
  assert.equal(calls.geocode.length, 1, 'exactly one geocode fetch (in-flight dedupe)');
  assert.equal(calls.nearby.length, 1, 'exactly one nearby fetch');
});

test('get_basemap_label_context caches every layer: a second read issues zero fetches', async () => {
  resetCalls();
  setGeocode(AUSTIN_GEOCODE);
  setNearby({ places: [{ name: 'Frost Tower', address: '111 Congress Ave' }] });
  // Fresh coordinates: the merge test already cached the Frost Tower point.
  const { viewer } = makeViewer({ height: 20000, view: [33.50, -101.20] });

  const first = await getBasemapLabelContext(viewer);
  const afterGeocode = calls.geocode.length;
  const afterNearby = calls.nearby.length;
  assert.ok(afterGeocode > 0, 'the first read populates the caches');

  const second = await getBasemapLabelContext(viewer);
  assert.equal(calls.geocode.length, afterGeocode, 'viewport + place labels come from cache');
  assert.equal(calls.nearby.length, afterNearby, 'nearby places come from cache');
  assert.deepEqual(second, first);

  // A failed geocode is cached too: ZERO_RESULTS must not refetch forever.
  setGeocode({ status: 'OVER_QUERY_LIMIT' });
  const { viewer: viewer2 } = makeViewer({ height: 400, view: [31.10, -96.50] });
  const failed = await getBasemapLabelContext(viewer2);
  const failedCount = calls.geocode.length;
  assert.deepEqual(failed.placeLabels, [], 'a failed lookup yields no labels, not an error');
  const again = await getBasemapLabelContext(viewer2);
  assert.equal(calls.geocode.length, failedCount, 'the negative result is cached');
  void again;
});

// ═══════════════════════ show_data_layers_menu + focus ═══════════════════════

test('show_data_layers_menu lists visible layers and focuses the named row when the DOM has one', async () => {
  const { viewer } = makeViewer();
  const dataManager = makeDataManager({
    layers: ['flights', 'military', 'ais-live-vessels'],
    hiddenInPanel: ['ais-live-vessels'],
  });
  const row = {
    classList: { remove() {}, add() {} },
    scrollIntoView() {},
    offsetWidth: 0,
    querySelector: () => ({ textContent: ' Flights ' }),
  };
  const prevDocument = globalThis.document;
  globalThis.document = { querySelector: (sel) => (sel.includes('flights') ? row : null) };
  t_afterDocument(prevDocument);

  const { styleManager, op } = makeStyleManager();
  const runner = createGevActionRunner({ viewer, styleManager, dataManager });

  const menu = await runner('show_data_layers_menu', { layerId: 'flights' });
  assert.equal(menu.ok, true);
  assert.equal(menu.panelId, 'data-panel');
  assert.deepEqual(op.panels, [['data-panel', false, { explicit: true }]], 'the menu opens the data panel');
  assert.deepEqual(menu.layers.map((l) => l.id), ['flights', 'military'],
    'layers hidden from the toggle panel stay out of the voice inventory');
  assert.deepEqual(menu.focusedLayer, { id: 'flights', name: 'Flights' });

  globalThis.document = { querySelector: () => null };
  const missing = await runner('show_data_layers_menu', { layerId: 'flights' });
  assert.equal(missing.focusedLayer, null, 'a missing DOM row degrades to no focus');

  const unlisted = await runner('show_data_layers_menu', { layerId: 'unknown-layer' });
  assert.equal(unlisted.focusedLayer, null, 'a layer outside the manager never gets focused');
});

function t_afterDocument(prev) {
  after(() => { globalThis.document = prev; });
}
