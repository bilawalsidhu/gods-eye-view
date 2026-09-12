/**
 * @module directions
 * @description Keyless A→B directions on the globe: drive, walk or cycle.
 *
 * The row's chips arm a click ("SET A", then click the globe; "SET B", click
 * again). With both ends placed the layer asks the existing `/api/route`
 * proxy (OSRM on the FOSSGIS servers, © OpenStreetMap contributors) for the
 * street-following route with turn-by-turn steps, drapes it on the terrain
 * and 3D tiles with the same flowing dashes the voice "route from A to B"
 * annotation uses, and drops one dot per maneuver. Click a dot for the
 * instruction; "FLY" rides the camera along the route through the shared
 * route-flight cinematic (`flyRoute`), the way voice's `fly_route` does.
 *
 * Needs no key, no geocoder and no microphone. A route that cannot be found
 * says so — there is never a straight-line stand-in drawn as if it were a
 * route.
 */

import * as Cesium from 'cesium';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import { registerSpriteCollection, restoreSpriteOrder } from './spriteOrder.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';
import { isPickedWorldPosition } from './scenePick.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  FlowMaterialProperty,
  ensureFlowFabricRegistered,
} from '../annotations/worldAnnotationRenderer.js';
import { flyRoute, initCameraVerbs } from '../cameraVerbs.js';
import { formatRouteDistance, formatRouteDuration } from './routeSteps.js';

export const DIRECTIONS_STEP_OVERLAY_SOURCE_ID = 'directions-step';
export const DIRECTIONS_STEP_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

/** Travel modes, keyed by the `/api/route` profile name. */
export const DIRECTIONS_MODES = Object.freeze({
  car: Object.freeze({ chip: 'DRIVE', word: 'Drive', icon: '🚗' }),
  foot: Object.freeze({ chip: 'WALK', word: 'Walk', icon: '🚶' }),
  bike: Object.freeze({ chip: 'BIKE', word: 'Bike', icon: '🚲' }),
});
export const DEFAULT_DIRECTIONS_MODE = 'car';

/** Route colour — the annotation palette's cyan, so voice routes and Directions match. */
export const DIRECTIONS_ROUTE_COLOR = '#39d0ff';
const MARKER_A_COLOR = Cesium.Color.fromCssColorString('#5dff9f');
const MARKER_B_COLOR = Cesium.Color.fromCssColorString('#ff6b6b');
const STEP_COLOR = Cesium.Color.WHITE.withAlpha(0.95);
const STEP_OUTLINE = Cesium.Color.fromCssColorString(DIRECTIONS_ROUTE_COLOR);
const STEP_PIXEL_SIZE = 8;
const STEP_SELECTED_PIXEL_SIZE = 13;
/** Route request timeout (ms) — the proxy itself gives OSRM 12 s. */
const ROUTE_TIMEOUT_MS = 15_000;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});
let _overlayHost = DEFAULT_OVERLAY_HOST;

// --- Module state ---
let _viewer = null;
let _enabled = false;
let _mode = DEFAULT_DIRECTIONS_MODE;
/** @type {null|'a'|'b'} which endpoint the next globe click places */
let _armed = null;
/** @type {{lat:number, lon:number}|null} */
let _a = null;
/** @type {{lat:number, lon:number}|null} */
let _b = null;
/** @type {'idle'|'routing'|'ready'|'error'} */
let _status = 'idle';
let _error = null;
/** @type {{distanceM:number, durationS:number, geometry:number[][], steps:object[], mode:string}|null} */
let _route = null;
let _routeSeq = 0;
let _routeAbort = null;
let _lastUpdate = null;
let _markerA = null;
let _markerB = null;
let _routeEntity = null;
let _stepPoints = null;
let _selectedStep = null;
let _clickHandler = null;
let _renderHeld = false;
let _rowControlsListener = null;
let _dataManager = null;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Validate a params patch. Returns null when it contains an unknown mode.
 * @param {object} params
 * @returns {{mode?: string, arm?: 'a'|'b'|null, swap?: boolean, fly?: boolean, clear?: boolean}|null}
 */
export function normalizeDirectionsParams(params = {}) {
  const out = {};
  if (params.mode !== undefined) {
    const mode = String(params.mode).toLowerCase();
    if (!DIRECTIONS_MODES[mode]) return null;
    out.mode = mode;
  }
  if (params.arm !== undefined) {
    out.arm = params.arm === 'a' || params.arm === 'b' ? params.arm : null;
  }
  if (params.swap === true) out.swap = true;
  if (params.fly === true) out.fly = true;
  if (params.clear === true) out.clear = true;
  return out;
}

/**
 * Row chips for a given state. Pure so the chip logic is testable without a DOM.
 * @param {{mode:string, armed:null|'a'|'b', a:object|null, b:object|null, status:string, route:object|null}} state
 * @returns {{chips: object[], legend: object[]}}
 */
export function directionsRowControls(state) {
  const { mode, armed, a, b, status, route } = state;
  const routing = status === 'routing';
  const chips = Object.entries(DIRECTIONS_MODES).map(([id, spec]) => ({
    id: `mode-${id}`,
    label: spec.chip,
    active: mode === id,
    state: mode === id ? 'active' : 'idle',
    title: `${spec.word} — reroute for ${spec.word.toLowerCase()}`,
    params: { mode: id },
  }));
  chips.push({
    id: 'set-a',
    label: armed === 'a' ? 'CLICK MAP' : (a ? 'A ✓' : 'SET A'),
    active: armed === 'a',
    state: armed === 'a' ? 'active' : 'idle',
    title: armed === 'a' ? 'Click a spot on the globe to place A (click again to cancel)' : 'Then click the globe to place the start',
    params: { arm: armed === 'a' ? null : 'a' },
  });
  chips.push({
    id: 'set-b',
    label: armed === 'b' ? 'CLICK MAP' : (b ? 'B ✓' : 'SET B'),
    active: armed === 'b',
    state: armed === 'b' ? 'active' : 'idle',
    title: armed === 'b' ? 'Click a spot on the globe to place B (click again to cancel)' : 'Then click the globe to place the destination',
    params: { arm: armed === 'b' ? null : 'b' },
  });
  chips.push({
    id: 'swap',
    label: '⇄',
    disabled: !(a && b) || routing,
    state: 'idle',
    title: 'Swap A and B',
    params: { swap: true },
  });
  chips.push({
    id: 'fly',
    label: routing ? 'FLY ···' : 'FLY',
    disabled: !route || routing,
    busy: routing,
    state: routing ? 'loading' : 'idle',
    title: route ? 'Fly the camera along the route' : 'Place A and B first',
    params: { fly: true },
  });
  chips.push({
    id: 'clear',
    label: 'CLEAR',
    disabled: !a && !b && !route,
    state: 'idle',
    title: 'Remove the route and both markers',
    params: { clear: true },
  });
  return { chips, legend: [] };
}

/**
 * Stats for the Data Layers row. Pure.
 * @param {{enabled:boolean, mode:string, a:object|null, b:object|null, status:string, error:string|null, route:object|null, lastUpdate:number|null, armed:null|'a'|'b'}} state
 * @returns {object}
 */
export function directionsStats(state) {
  const { mode, a, b, status, error, route, lastUpdate, armed } = state;
  const source = 'OSM routing';
  if (status === 'routing') {
    return { count: 0, lastUpdate, error: null, loading: true, loadingLabel: 'Routing…', source };
  }
  if (status === 'error') {
    return { count: 0, lastUpdate, error: error || 'No route found', status: 'empty', source };
  }
  // The manager prints `loadingLabel` as the row's detail line whenever it is
  // set (not only while loading), so the route summary and the placement
  // guidance ride on it; `coverage` carries the same text for stats readers.
  if (route) {
    const word = DIRECTIONS_MODES[mode]?.word || mode;
    const summary = `${formatRouteDistance(route.distanceM)} · ${formatRouteDuration(route.durationS)} · ${word}`;
    return {
      count: route.steps.length,
      lastUpdate,
      error: null,
      source,
      coverage: summary,
      loadingLabel: summary,
    };
  }
  let coverage;
  if (armed) coverage = `Click the globe to place ${armed.toUpperCase()}`;
  else if (a && !b) coverage = 'SET B, then click the globe';
  else if (!a && b) coverage = 'SET A, then click the globe';
  else coverage = 'SET A, then click the globe';
  return { count: 0, lastUpdate, error: null, status: 'idle', source, coverage, loadingLabel: coverage };
}

/**
 * Card copy for one maneuver.
 * @param {object[]} steps
 * @param {number} index
 * @returns {{title:string, details:string[]}}
 */
export function directionsStepCopy(steps, index) {
  const step = steps[index];
  const details = [];
  const leg = [];
  if (step.distanceM > 0) leg.push(formatRouteDistance(step.distanceM));
  if (step.durationS > 0) leg.push(formatRouteDuration(step.durationS));
  details.push(`Step ${index + 1} of ${steps.length}${leg.length ? ` · then ${leg.join(' · ')}` : ''}`);
  const next = steps[index + 1];
  if (next) details.push(`Then: ${next.instruction}`);
  return { title: step.instruction, details };
}

/**
 * Shared-host card for the selected maneuver.
 * @param {number} index
 * @param {Cesium.Cartesian3} position
 * @param {{title:string, details:string[]}} copy
 * @returns {object|null}
 */
export function createDirectionsStepOverlayEntry(index, position, copy) {
  if (!Number.isInteger(index) || !position) return null;
  return {
    id: `directions-step-${index}`,
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: copy.title,
    details: copy.details,
    accent: DIRECTIONS_ROUTE_COLOR,
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/**
 * Build the `/api/route` URL for two endpoints.
 * @param {string} mode car | foot | bike
 * @param {{lat:number, lon:number}} a
 * @param {{lat:number, lon:number}} b
 * @returns {string}
 */
export function directionsRequestUrl(mode, a, b) {
  const coords = `${a.lon.toFixed(6)},${a.lat.toFixed(6)};${b.lon.toFixed(6)},${b.lat.toFixed(6)}`;
  return `/api/route?profile=${encodeURIComponent(mode)}&coords=${encodeURIComponent(coords)}&steps=1`;
}

/**
 * Validate a proxy payload into the route record the layer keeps, or null.
 * @param {object} payload
 * @param {string} mode
 * @returns {{distanceM:number, durationS:number, geometry:number[][], steps:object[], mode:string}|null}
 */
export function normalizeRoutePayload(payload, mode) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.geometry) || payload.geometry.length < 2) return null;
  const geometry = payload.geometry
    .map((pair) => [Number(pair?.[0]), Number(pair?.[1])])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
  if (geometry.length < 2) return null;
  const steps = (Array.isArray(payload.steps) ? payload.steps : [])
    .filter((step) => step && typeof step.instruction === 'string' && Number.isFinite(step.lat) && Number.isFinite(step.lon))
    .map((step, index) => ({ ...step, index }));
  return {
    distanceM: Math.max(0, Number(payload.distanceM) || 0),
    durationS: Math.max(0, Number(payload.durationS) || 0),
    geometry,
    steps,
    mode,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function state() {
  return { enabled: _enabled, mode: _mode, armed: _armed, a: _a, b: _b, status: _status, error: _error, route: _route, lastUpdate: _lastUpdate };
}

function notifyRow() {
  try { _rowControlsListener?.(); } catch { /* listener is best-effort */ }
  _dataManager?.refreshLayerStats?.();
}

function syncRenderHold() {
  const shouldHold = _enabled && Boolean(_routeEntity);
  if (shouldHold && !_renderHeld) {
    holdContinuousRender('directions');
    _renderHeld = true;
  } else if (!shouldHold && _renderHeld) {
    releaseContinuousRender('directions');
    _renderHeld = false;
  }
}

function pickGround(screenPosition) {
  const scene = _viewer?.scene;
  let cartesian = null;
  if (scene?.pickPositionSupported && typeof scene.pickPosition === 'function') {
    try { cartesian = scene.pickPosition(screenPosition); } catch { cartesian = null; }
  }
  if (!isPickedWorldPosition(cartesian) && typeof _viewer?.camera?.pickEllipsoid === 'function') {
    try { cartesian = _viewer.camera.pickEllipsoid(screenPosition, Cesium.Ellipsoid.WGS84); } catch { cartesian = null; }
  }
  if (!isPickedWorldPosition(cartesian)) return null;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  if (!carto) return null;
  return { lat: Cesium.Math.toDegrees(carto.latitude), lon: Cesium.Math.toDegrees(carto.longitude) };
}

function markerEntity(letter, point, color) {
  return _viewer.entities.add({
    id: `directions:marker:${letter}`,
    position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat, 0),
    point: {
      pixelSize: 14,
      color,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: letter,
      font: 'bold 13px "JetBrains Mono", "SF Mono", monospace',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -20),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

function removeEntity(entity) {
  if (entity && _viewer && !_viewer.isDestroyed?.()) _viewer.entities.remove(entity);
}

function placeMarker(letter, point) {
  if (!_viewer) return;
  if (letter === 'a') {
    removeEntity(_markerA);
    _markerA = markerEntity('A', point, MARKER_A_COLOR);
  } else {
    removeEntity(_markerB);
    _markerB = markerEntity('B', point, MARKER_B_COLOR);
  }
}

function clearRouteGraphics() {
  _clearStepSelection();
  removeEntity(_routeEntity);
  _routeEntity = null;
  _stepPoints?.removeAll();
  syncRenderHold();
}

function drawRoute(route) {
  clearRouteGraphics();
  if (!_viewer) return;
  ensureFlowFabricRegistered();
  const positions = Cesium.Cartesian3.fromDegreesArray(route.geometry.flat());
  _routeEntity = _viewer.entities.add({
    id: 'directions:route',
    polyline: {
      positions,
      width: 9,
      material: new FlowMaterialProperty(DIRECTIONS_ROUTE_COLOR),
      clampToGround: true,
      // BOTH: drape on 3D tiles when they are up and on terrain when they are
      // not, so the keyless globe shows the route too.
      classificationType: Cesium.ClassificationType.BOTH,
    },
  });
  // One dot per decision; A and B already mark departure and arrival.
  route.steps.forEach((step, index) => {
    if (index === 0 || index === route.steps.length - 1) return;
    _stepPoints.add({
      id: `directions:step:${index}`,
      position: Cesium.Cartesian3.fromDegrees(step.lon, step.lat, 2),
      color: STEP_COLOR,
      pixelSize: STEP_PIXEL_SIZE,
      outlineColor: STEP_OUTLINE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
  });
  syncRenderHold();
  restoreSpriteOrder(_viewer);
  governorRequestRender('directions-route');
}

async function requestRoute() {
  if (!_a || !_b || !_enabled) return;
  _routeAbort?.abort();
  const controller = new AbortController();
  _routeAbort = controller;
  const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  _routeSeq += 1;
  const seq = _routeSeq;
  const mode = _mode;
  _status = 'routing';
  _error = null;
  notifyRow();
  try {
    const response = await fetch(directionsRequestUrl(mode, _a, _b), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (response.status === 429) throw new Error('Routing is rate limited — try again in a moment');
    const payload = await response.json();
    if (seq !== _routeSeq || !_enabled) return;
    const route = normalizeRoutePayload(payload, mode);
    if (!route) {
      _route = null;
      clearRouteGraphics();
      _status = 'error';
      _error = payload?.error === 'no route found' ? 'No route found between A and B' : (payload?.error ? `Routing failed: ${payload.error}` : 'No route found between A and B');
      return;
    }
    _route = route;
    _status = 'ready';
    _lastUpdate = Date.now();
    drawRoute(route);
  } catch (error) {
    if (seq !== _routeSeq || !_enabled) return;
    _route = null;
    clearRouteGraphics();
    _status = 'error';
    _error = error?.name === 'AbortError' ? 'Routing timed out' : (error?.message || 'Routing unavailable');
  } finally {
    clearTimeout(timer);
    if (_routeAbort === controller) _routeAbort = null;
    if (seq === _routeSeq) notifyRow();
    governorRequestRender('directions-route');
  }
}

function clearAll() {
  _routeAbort?.abort();
  _routeAbort = null;
  _routeSeq += 1;
  _armed = null;
  _a = null;
  _b = null;
  _route = null;
  _status = 'idle';
  _error = null;
  removeEntity(_markerA);
  removeEntity(_markerB);
  _markerA = null;
  _markerB = null;
  clearRouteGraphics();
  governorRequestRender('directions-clear');
}

function flyCurrentRoute() {
  if (!_route || !_viewer) return false;
  initCameraVerbs(_viewer);
  const result = flyRoute([{
    type: 'route',
    label: 'Directions',
    path: _route.geometry.map(([lon, lat]) => ({ lon, lat, height: 0 })),
  }], { speed: 'normal' });
  if (result?.ok !== true) console.warn('[Data:Directions] fly refused:', result?.error || result);
  return result?.ok === true;
}

// --- Step selection ---

function _clearStepSelection() {
  if (_selectedStep !== null && _stepPoints) {
    const point = findStepPoint(_selectedStep);
    if (point) point.pixelSize = STEP_PIXEL_SIZE;
  }
  _selectedStep = null;
  _overlayHost.clearSource(DIRECTIONS_STEP_OVERLAY_SOURCE_ID);
}

function findStepPoint(index) {
  if (!_stepPoints) return null;
  const id = `directions:step:${index}`;
  for (let i = 0; i < _stepPoints.length; i += 1) {
    const point = _stepPoints.get(i);
    if (point.id === id) return point;
  }
  return null;
}

function _selectStep(index) {
  _clearStepSelection();
  if (!_route || !Number.isInteger(index) || !_route.steps[index]) return;
  const point = findStepPoint(index);
  if (!point) return;
  _selectedStep = index;
  point.pixelSize = STEP_SELECTED_PIXEL_SIZE;
  const entry = createDirectionsStepOverlayEntry(index, Cesium.Cartesian3.clone(point.position), directionsStepCopy(_route.steps, index));
  if (entry) _overlayHost.setEntries(DIRECTIONS_STEP_OVERLAY_SOURCE_ID, [entry], DIRECTIONS_STEP_OVERLAY_SOURCE_OPTIONS);
  governorRequestRender('directions-select');
}

function stepIndexFromPick(picked) {
  const candidates = [picked?.primitive?.id, picked?.id];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const match = /^directions:step:(\d+)$/.exec(candidate);
    if (match) return Number(match[1]);
  }
  return null;
}

function _onKeyDown(event) {
  if (event.key !== 'Escape') return;
  if (_armed) {
    _armed = null;
    notifyRow();
  } else if (_selectedStep !== null) {
    _clearStepSelection();
  }
}

function _installClickHandler(viewer) {
  if (_clickHandler) return;
  _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!_enabled) return;
    if (_armed) {
      const point = pickGround(click.position);
      if (!point) return;
      const which = _armed;
      _armed = null;
      if (which === 'a') _a = point; else _b = point;
      placeMarker(which, point);
      if (_a && _b) void requestRoute();
      else notifyRow();
      governorRequestRender('directions-place');
      return;
    }
    let picked = null;
    try { picked = viewer.scene.pick(click.position); } catch { picked = null; }
    const index = stepIndexFromPick(picked);
    if (index !== null) {
      _selectStep(index);
      return;
    }
    if (_selectedStep !== null) _clearStepSelection();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  document.addEventListener('keydown', _onKeyDown);
}

function _removeClickHandler() {
  if (_clickHandler) {
    _clickHandler.destroy();
    _clickHandler = null;
  }
  document.removeEventListener('keydown', _onKeyDown);
}

// ---------------------------------------------------------------------------
// Layer module
// ---------------------------------------------------------------------------

const directionsLayer = {
  id: 'directions',
  name: 'Directions',
  icon: '🧭',
  source: 'OSM routing',
  updateInterval: 0,

  /**
   * Create the maneuver-dot collection. Called once at bootstrap.
   * @param {Cesium.Viewer} viewer
   */
  init(viewer) {
    _viewer = viewer;
    _stepPoints = new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT });
    viewer.scene.primitives.add(_stepPoints);
    registerSpriteCollection('directions', _stepPoints);
    _stepPoints.show = false;
    _enabled = false;
    _mode = DEFAULT_DIRECTIONS_MODE;
    _armed = null;
    _a = null;
    _b = null;
    _route = null;
    _status = 'idle';
    _error = null;
    _overlayHost.setVisible(DIRECTIONS_STEP_OVERLAY_SOURCE_ID, false);
    restoreSpriteOrder(viewer);
    console.log('[Data:Directions] Initialized');
  },

  /**
   * Show the row chips and listen for placement clicks.
   * @param {Cesium.Viewer} viewer
   */
  enable(viewer) {
    _enabled = true;
    _stepPoints.show = true;
    _overlayHost.setVisible(DIRECTIONS_STEP_OVERLAY_SOURCE_ID, true);
    _installClickHandler(viewer);
    registerPickOwner('directions', (pickedId) => typeof pickedId === 'string' && pickedId.startsWith('directions:'));
    syncRenderHold();
    restoreSpriteOrder(viewer);
  },

  /**
   * Remove the route, markers and listeners.
   * @param {Cesium.Viewer} viewer
   */
  disable(viewer) {
    _enabled = false;
    clearAll();
    _overlayHost.setVisible(DIRECTIONS_STEP_OVERLAY_SOURCE_ID, false);
    _removeClickHandler();
    unregisterPickOwner('directions');
    if (_stepPoints) _stepPoints.show = false;
    syncRenderHold();
    void viewer;
  },

  /** Nothing to poll: routes are requested on placement and mode change. */
  async update() {},

  /**
   * Chip and programmatic writes. `mode` is state; `arm` is state (which
   * endpoint the next globe click places); `swap`, `fly` and `clear` are
   * one-shot commands that leave no param behind.
   * @param {object} params
   * @returns {boolean} false when the patch names an unknown mode.
   */
  setParams(params = {}) {
    const patch = normalizeDirectionsParams(params);
    if (!patch) return false;
    if (patch.clear) clearAll();
    if (patch.mode !== undefined && patch.mode !== _mode) {
      _mode = patch.mode;
      if (_a && _b && _enabled) void requestRoute();
    }
    if (patch.arm !== undefined) {
      _armed = patch.arm;
      if (_armed) _clearStepSelection();
    }
    if (patch.swap && _a && _b) {
      [_a, _b] = [_b, _a];
      placeMarker('a', _a);
      placeMarker('b', _b);
      if (_enabled) void requestRoute();
    }
    if (patch.fly) flyCurrentRoute();
    notifyRow();
    governorRequestRender('directions-params');
    return true;
  },

  getParams() {
    return { mode: _mode };
  },

  getRowControls() {
    return directionsRowControls(state());
  },

  /**
   * Install the manager's row re-render callback (placement and routing land
   * outside any manager tick).
   * @param {(() => void)|null} listener
   */
  setRowControlsListener(listener) {
    _rowControlsListener = typeof listener === 'function' ? listener : null;
  },

  getStats() {
    return directionsStats(state());
  },

  /**
   * Keep a manager handle so placement and routing can repaint the row.
   * @param {object} dataManager DataLayerManager instance.
   */
  attachDataManager(dataManager) {
    _dataManager = dataManager;
  },

  /**
   * Tear down entirely.
   * @param {Cesium.Viewer} viewer
   */
  destroy(viewer) {
    if (_enabled) this.disable(viewer);
    if (_stepPoints) {
      viewer.scene.primitives.remove(_stepPoints);
      _stepPoints = null;
    }
    _overlayHost.clearSource(DIRECTIONS_STEP_OVERLAY_SOURCE_ID);
    _viewer = null;
  },
};

/** Test seam: swap the shared overlay host. */
export function _setDirectionsOverlayHostForTest(host) {
  _overlayHost = host || DEFAULT_OVERLAY_HOST;
}

export default directionsLayer;
