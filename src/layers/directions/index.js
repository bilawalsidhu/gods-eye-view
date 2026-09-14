/**
 * @module layers/directions
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
  formatRouteDistance,
  formatRouteDuration,
} from '../../data/routeSteps.js';

/**
 * Shared application services, handed over by the wiring module
 * (`src/data/directions.js`) before anything runs. Injecting them is what
 * keeps this layer's own dependency list to Cesium and the pure step
 * formatter, so it can be a package boundary of its own.
 * @type {{render: object, sprites: object, picking: object, scenePick: object,
 *   overlays: object, annotations: object, camera: object, ground: object,
 *   input: object}|null}
 */
let services = null;

/**
 * Install the shared services this layer runs on. Called once at import time
 * by the wiring module; there is no second caller.
 * @param {object} next Service bundle.
 */
export function setDirectionsServices(next) {
  services = next || null;
}

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

/** Pointer-ownership id while a globe click is placing an endpoint. */
export const DIRECTIONS_POINTER_OWNER = 'directions';

/**
 * How long to keep re-reading the shared ground floor for a maneuver dot whose
 * cell has not answered yet. The terrain proxy behind that floor can take tens
 * of seconds on a cold cache, so this is a wall-clock budget comfortably past
 * it rather than a handful of quick retries — a dot that resolves late still
 * appears. Reroute, CLEAR, disable and destroy all cancel it.
 */
export const STEP_ANCHOR_DEADLINE_MS = 90_000;
/** Gap between the first re-reads (ms); it widens after the first few. */
export const STEP_ANCHOR_RETRY_MS = 400;
/** Gap once the quick re-reads have not settled it (ms). */
export const STEP_ANCHOR_SLOW_RETRY_MS = 2000;
/** Re-reads at the quick gap before backing off. */
export const STEP_ANCHOR_FAST_ATTEMPTS = 5;
/** How often the row repaints the highlighted step while FLY is running (ms). */
export const FLIGHT_PROGRESS_MS = 250;

/**
 * Where the maneuver card is drawn. Defaults to the shared world-overlay host;
 * tests swap it. Resolved on use, not at import, because the services arrive
 * after this module is evaluated.
 */
const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: (...args) => services.overlays.setOverlayEntries(...args),
  setVisible: (...args) => services.overlays.setOverlaySourceVisible(...args),
  clearSource: (...args) => services.overlays.clearOverlaySource(...args),
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
/** Set when arming failed because another tool holds the pointer. */
let _pointerBlocked = false;
/**
 * What `claimPointer` handed back for the claim this layer currently holds, or
 * null. Held rather than re-derived so the release names THIS claim: a claim
 * that has already been superseded cannot free its successor's.
 */
let _pointerClaim = null;
/** Pending release of that claim, once the click being handled is over. */
let _releaseTimer = null;
/** Id of the route flight THIS layer started, while it is still running. */
let _flightId = 0;
let _flightTimer = null;
/** Step the camera is on during FLY, or null. */
let _flightStep = null;
let _anchorTimer = null;
let _anchorAttempts = 0;
let _anchorStartedAt = 0;
/**
 * Camera seams handed over by the UI shell: the one navigation-authority
 * facade every camera owner goes through, plus the shared ground-floor
 * read/warm the route dolly uses so it does not fly a mountain at sea level.
 */
let _cameraServices = null;

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
  if (params.step !== undefined) {
    out.step =
      Number.isInteger(params.step) && params.step >= 0 ? params.step : null;
  }
  return out;
}

/**
 * Row chips for a given state. Pure so the chip logic is testable without a DOM.
 * @param {{mode:string, armed:null|'a'|'b', a:object|null, b:object|null, status:string, route:object|null}} state
 * @returns {{chips: object[], legend: object[]}}
 */
export function directionsRowControls(state) {
  const { mode, armed, a, b, status, route, selectedStep, flightStep } = state;
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
    label: armed === 'a' ? 'CLICK MAP' : a ? 'A ✓' : 'SET A',
    active: armed === 'a',
    state: armed === 'a' ? 'active' : 'idle',
    title:
      armed === 'a'
        ? 'Click a spot on the globe to place A (click again to cancel)'
        : 'Then click the globe to place the start',
    params: { arm: armed === 'a' ? null : 'a' },
  });
  chips.push({
    id: 'set-b',
    label: armed === 'b' ? 'CLICK MAP' : b ? 'B ✓' : 'SET B',
    active: armed === 'b',
    state: armed === 'b' ? 'active' : 'idle',
    title:
      armed === 'b'
        ? 'Click a spot on the globe to place B (click again to cancel)'
        : 'Then click the globe to place the destination',
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
  const flying = Number.isInteger(flightStep);
  chips.push({
    id: 'fly',
    label: routing ? 'FLY ···' : flying ? 'FLYING' : 'FLY',
    disabled: !route || routing,
    busy: routing || flying,
    active: flying,
    state: routing || flying ? 'loading' : 'idle',
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
  return {
    chips,
    legend: [],
    list: directionsStepList({
      route,
      selectedStep: selectedStep ?? null,
      flightStep: flightStep ?? null,
    }),
  };
}

/**
 * Which maneuvers get a dot on the globe: every one except departure and
 * arrival, which the A and B markers already stand for.
 * @param {object[]} steps
 * @returns {number[]} Step indices.
 */
export function stepMarkerIndices(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const out = [];
  for (let index = 1; index < list.length - 1; index += 1) out.push(index);
  return out;
}

/**
 * Render height for a maneuver dot.
 *
 * A dot fixed at a couple of metres ellipsoidal is at sea level, which in
 * Denver (ground ~1.6 km) puts it a kilometre and a half under the city: on an
 * oblique view it sits visibly off its own junction. So the dot reads the same
 * shared ground floor every other anchored point in the app reads
 * (`cachedGroundFloor` — the rendered mesh cell on the photoreal stack, the
 * Re:Earth DEM cell on the keyless terrain stacks) and lifts clear of it.
 * Until that cell is warm there is no honest height, and the caller keeps the
 * dot hidden rather than drawing it somewhere wrong.
 * @param {number|null} floorM Ellipsoidal ground for the cell, or null.
 * @returns {number|null} Ellipsoidal render height, or null while unknown.
 */
export function stepMarkerHeightM(floorM, liftM) {
  return Number.isFinite(floorM) ? floorM + liftM : null;
}

/**
 * How long to wait before re-reading the ground floor again, or null when the
 * budget is spent. Quick at first, because most cells answer immediately from
 * a warm cache; slower afterwards, because what is left is a network round
 * trip. Pure.
 * @param {number} attempt Re-reads already made (0 for the first wait).
 * @param {number} elapsedMs Milliseconds since anchoring started.
 * @returns {number|null} Delay in ms, or null to stop.
 */
export function stepAnchorDelayMs(attempt, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs >= STEP_ANCHOR_DEADLINE_MS)
    return null;
  const delay =
    attempt < STEP_ANCHOR_FAST_ATTEMPTS
      ? STEP_ANCHOR_RETRY_MS
      : STEP_ANCHOR_SLOW_RETRY_MS;
  return Math.min(delay, STEP_ANCHOR_DEADLINE_MS - elapsedMs);
}

/**
 * The ordered turn-by-turn list for the layer row. Pure.
 * @param {{route: object|null, selectedStep: number|null, flightStep: number|null}} state
 * @returns {{ariaLabel: string, items: object[]}|null}
 */
export function directionsStepList({
  route,
  selectedStep = null,
  flightStep = null,
}) {
  const steps = route?.steps;
  if (!Array.isArray(steps) || !steps.length) return null;
  const active = Number.isInteger(flightStep) ? flightStep : selectedStep;
  const items = steps.map((step, index) => ({
    id: `step-${index}`,
    ordinal: index + 1,
    lead: formatRouteDistance(step.distanceM) || '—',
    text: step.instruction,
    active: index === active,
    current: Number.isInteger(flightStep) && index === flightStep,
    params: { step: index },
  }));
  if (route.stepsTruncated) {
    // The arrival step is missing, so the list must not end as if the reader
    // had arrived. A plain, unclickable last line says where it really stops.
    items.push({
      id: 'step-truncated',
      ordinal: items.length + 1,
      lead: '',
      text: `Only the first ${steps.length} turns of this route are shown`,
      active: false,
      current: false,
      disabled: true,
    });
  }
  return { ariaLabel: 'Turn-by-turn directions', items };
}

/**
 * Which maneuver the camera is on, given how far along the route it has flown.
 * Steps carry the length of the leg that FOLLOWS them, so the step in force is
 * the last one whose cumulative start is at or behind the camera. Pure.
 * @param {object[]} steps
 * @param {number} traveledM Metres flown from the start of the route.
 * @returns {number|null}
 */
export function stepIndexAtDistance(steps, traveledM) {
  if (!Array.isArray(steps) || !steps.length) return null;
  if (!Number.isFinite(traveledM) || traveledM < 0) return 0;
  let start = 0;
  for (let index = 0; index < steps.length; index += 1) {
    const end = start + Math.max(0, Number(steps[index]?.distanceM) || 0);
    if (traveledM < end) return index;
    start = end;
  }
  return steps.length - 1;
}

/**
 * Stats for the Data Layers row. Pure.
 * @param {{enabled:boolean, mode:string, a:object|null, b:object|null, status:string, error:string|null, route:object|null, lastUpdate:number|null, armed:null|'a'|'b'}} state
 * @returns {object}
 */
export function directionsStats(state) {
  const {
    mode,
    a,
    b,
    status,
    error,
    route,
    lastUpdate,
    armed,
    pointerBlocked,
  } = state;
  const source = 'OSM routing';
  if (pointerBlocked) {
    return {
      count: route?.steps.length || 0,
      lastUpdate,
      error: 'Another map tool is using clicks — close it, then SET A again',
      status: 'empty',
      source,
    };
  }
  if (status === 'routing') {
    return {
      count: 0,
      lastUpdate,
      error: null,
      loading: true,
      loadingLabel: 'Routing…',
      source,
    };
  }
  if (status === 'error') {
    return {
      count: 0,
      lastUpdate,
      error: error || 'No route found',
      status: 'empty',
      source,
    };
  }
  // The manager prints `loadingLabel` as the row's detail line whenever it is
  // set (not only while loading), so the route summary and the placement
  // guidance ride on it; `coverage` carries the same text for stats readers.
  if (route) {
    const word = DIRECTIONS_MODES[mode]?.word || mode;
    const summary =
      `${formatRouteDistance(route.distanceM)} · ${formatRouteDuration(route.durationS)} · ${word}` +
      (route.stepsTruncated ? ` · first ${route.steps.length} turns` : '');
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
  return {
    count: 0,
    lastUpdate,
    error: null,
    status: 'idle',
    source,
    coverage,
    loadingLabel: coverage,
  };
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
  details.push(
    `Step ${index + 1} of ${steps.length}${leg.length ? ` · then ${leg.join(' · ')}` : ''}`,
  );
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
  if (
    !payload ||
    payload.ok !== true ||
    !Array.isArray(payload.geometry) ||
    payload.geometry.length < 2
  )
    return null;
  const geometry = payload.geometry
    .map((pair) => [Number(pair?.[0]), Number(pair?.[1])])
    .filter(
      ([lon, lat]) =>
        Number.isFinite(lon) &&
        Number.isFinite(lat) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180,
    );
  if (geometry.length < 2) return null;
  const steps = (Array.isArray(payload.steps) ? payload.steps : [])
    .filter(
      (step) =>
        step &&
        typeof step.instruction === 'string' &&
        Number.isFinite(step.lat) &&
        Number.isFinite(step.lon),
    )
    .map((step, index) => ({ ...step, index }));
  return {
    distanceM: Math.max(0, Number(payload.distanceM) || 0),
    durationS: Math.max(0, Number(payload.durationS) || 0),
    geometry,
    steps,
    // A route with more maneuvers than the proxy will serve is cut off, and
    // the cut is shown rather than passed off as the whole route.
    stepsTruncated: payload.stepsTruncated === true,
    mode,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function state() {
  return {
    enabled: _enabled,
    mode: _mode,
    armed: _armed,
    a: _a,
    b: _b,
    status: _status,
    error: _error,
    route: _route,
    lastUpdate: _lastUpdate,
    selectedStep: _selectedStep,
    flightStep: _flightStep,
    pointerBlocked: _pointerBlocked,
  };
}

function notifyRow() {
  try {
    _rowControlsListener?.();
  } catch {
    /* listener is best-effort */
  }
  _dataManager?.refreshLayerStats?.();
}

function syncRenderHold() {
  const shouldHold = _enabled && Boolean(_routeEntity);
  if (shouldHold && !_renderHeld) {
    services.render.holdContinuousRender('directions');
    _renderHeld = true;
  } else if (!shouldHold && _renderHeld) {
    services.render.releaseContinuousRender('directions');
    _renderHeld = false;
  }
}

function pickGround(screenPosition) {
  const scene = _viewer?.scene;
  let cartesian = null;
  if (
    scene?.pickPositionSupported &&
    typeof scene.pickPosition === 'function'
  ) {
    try {
      cartesian = scene.pickPosition(screenPosition);
    } catch {
      cartesian = null;
    }
  }
  if (
    !services.scenePick.isPickedWorldPosition(cartesian) &&
    typeof _viewer?.camera?.pickEllipsoid === 'function'
  ) {
    try {
      cartesian = _viewer.camera.pickEllipsoid(
        screenPosition,
        Cesium.Ellipsoid.WGS84,
      );
    } catch {
      cartesian = null;
    }
  }
  if (!services.scenePick.isPickedWorldPosition(cartesian)) return null;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  if (!carto) return null;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
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
  if (entity && _viewer && !_viewer.isDestroyed?.())
    _viewer.entities.remove(entity);
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
  stopStepAnchoring();
  removeEntity(_routeEntity);
  _routeEntity = null;
  _stepPoints?.removeAll();
  syncRenderHold();
}

function stopStepAnchoring() {
  if (_anchorTimer) clearTimeout(_anchorTimer);
  _anchorTimer = null;
  _anchorAttempts = 0;
  _anchorStartedAt = 0;
}

/**
 * Put every maneuver dot on the ground at its junction, and re-read the shared
 * floor while its cells are still warming. A dot whose cell has not answered
 * yet stays hidden: an unplaced dot is better than one drawn a kilometre below
 * the city it belongs to.
 */
function anchorStepPoints() {
  _anchorTimer = null;
  if (!_stepPoints || !_route || !_enabled) return;
  const steps = _route.steps;
  const pending = [];
  let unresolved = 0;
  for (const index of stepMarkerIndices(steps)) {
    const step = steps[index];
    const point = findStepPoint(index);
    if (!point) continue;
    const height = stepMarkerHeightM(
      services.ground.cachedGroundFloor(step.lat, step.lon),
      services.ground.GROUND_FLOOR_LIFT_M,
    );
    if (height === null) {
      unresolved += 1;
      point.show = false;
      pending.push({ lat: step.lat, lon: step.lon });
      continue;
    }
    point.position = Cesium.Cartesian3.fromDegrees(step.lon, step.lat, height);
    point.show = true;
  }
  // A card already open on a step that has just been anchored moves with it.
  if (_selectedStep !== null) refreshStepCard(_selectedStep);
  services.render.governorRequestRender('directions-anchor');
  if (!unresolved) {
    _anchorAttempts = 0;
    _anchorStartedAt = 0;
    return;
  }
  services.ground.warmGroundFloor(pending);
  const delay = stepAnchorDelayMs(
    _anchorAttempts,
    Date.now() - _anchorStartedAt,
  );
  _anchorAttempts += 1;
  if (delay === null) return;
  _anchorTimer = setTimeout(anchorStepPoints, delay);
}

function drawRoute(route) {
  clearRouteGraphics();
  if (!_viewer) return;
  services.annotations.ensureFlowFabricRegistered();
  const positions = Cesium.Cartesian3.fromDegreesArray(route.geometry.flat());
  _routeEntity = _viewer.entities.add({
    id: 'directions:route',
    polyline: {
      positions,
      width: 9,
      material: new services.annotations.FlowMaterialProperty(
        DIRECTIONS_ROUTE_COLOR,
      ),
      clampToGround: true,
      // BOTH: drape on 3D tiles when they are up and on terrain when they are
      // not, so the keyless globe shows the route too.
      classificationType: Cesium.ClassificationType.BOTH,
    },
  });
  // One dot per decision; A and B already mark departure and arrival. The dots
  // start hidden and appear as anchorStepPoints resolves each ground cell.
  const cells = [];
  for (const index of stepMarkerIndices(route.steps)) {
    const step = route.steps[index];
    cells.push({ lat: step.lat, lon: step.lon });
    _stepPoints.add({
      id: `directions:step:${index}`,
      position: Cesium.Cartesian3.fromDegrees(step.lon, step.lat, 0),
      color: STEP_COLOR,
      pixelSize: STEP_PIXEL_SIZE,
      outlineColor: STEP_OUTLINE,
      outlineWidth: 2,
      show: false,
      // The shared ground floor is a coarse cell, and on the photoreal stack
      // the rendered mesh can stand above it. Keeping the dot always visible
      // is the same choice every other anchored sprite in the app makes.
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
  }
  services.ground.warmGroundFloor(cells);
  _anchorAttempts = 0;
  _anchorStartedAt = Date.now();
  anchorStepPoints();
  syncRenderHold();
  services.sprites.restoreSpriteOrder(_viewer);
  services.render.governorRequestRender('directions-route');
}

async function requestRoute() {
  if (!_a || !_b || !_enabled) return;
  // The route under an owned flight is about to be replaced, and a dolly
  // cannot be re-pointed mid-cut. Land it first (only if it is still ours).
  cancelOwnedFlight('directions-reroute');
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
    const payload = await response.json();
    if (response.status === 429) {
      throw new Error(
        typeof payload?.error === 'string' && payload.error
          ? `${payload.error} — try again in a moment`
          : 'Routing is rate limited — try again in a moment',
      );
    }
    if (seq !== _routeSeq || !_enabled) return;
    const route = normalizeRoutePayload(payload, mode);
    if (!route) {
      _route = null;
      clearRouteGraphics();
      _status = 'error';
      _error =
        payload?.error === 'no route found'
          ? 'No route found between A and B'
          : payload?.error
            ? `Routing failed: ${payload.error}`
            : 'No route found between A and B';
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
    // A fetch that never reaches the proxy rejects with the browser's own
    // wording ("Failed to fetch"), which tells a reader nothing. Say what
    // happened instead.
    _error =
      error?.name === 'AbortError'
        ? 'Routing timed out'
        : error?.name === 'TypeError'
          ? 'Routing unavailable — no response from the routing service'
          : error?.message || 'Routing unavailable';
  } finally {
    clearTimeout(timer);
    if (_routeAbort === controller) _routeAbort = null;
    if (seq === _routeSeq) notifyRow();
    services.render.governorRequestRender('directions-route');
  }
}

/** Stop arming, and give the pointer back if this layer holds it. */
function releaseClaim() {
  if (_releaseTimer) clearTimeout(_releaseTimer);
  _releaseTimer = null;
  if (_pointerClaim !== null) services.input.releasePointer(_pointerClaim);
  _pointerClaim = null;
}

/**
 * Give the pointer back, but only once the click that consumed it has finished
 * being dispatched.
 *
 * Every layer binds its own handler to the same canvas, and they all run
 * inside ONE browser event. Releasing the claim the instant this layer places
 * an endpoint hands the rest of that same click to every ambient handler
 * registered after this one — placing A on top of a bikeshare station also
 * deselected the station. A timer, not a microtask: a microtask checkpoint
 * runs between two DOM listeners, which is exactly the gap this closes.
 */
function releaseClaimAfterDispatch() {
  if (_pointerClaim === null || _releaseTimer) return;
  _releaseTimer = setTimeout(() => {
    _releaseTimer = null;
    releaseClaim();
  }, 0);
}

/**
 * Stop arming.
 * @param {{afterDispatch?: boolean}} [options] `afterDispatch` holds the
 *   pointer claim until the click being handled has finished dispatching.
 */
function disarm({ afterDispatch = false } = {}) {
  _armed = null;
  _pointerBlocked = false;
  if (afterDispatch) releaseClaimAfterDispatch();
  else releaseClaim();
}

/**
 * Place one endpoint at a picked ground point and reroute when both are set.
 *
 * The globe click handler is the only caller in the running app; it is
 * exported because a ScreenSpaceEventHandler needs a real canvas, and the
 * ownership timing this function decides is exactly what has to be tested.
 * @param {'a'|'b'} which Which endpoint to place.
 * @param {{lat: number, lon: number}} point Ground point in degrees.
 * @returns {boolean} Whether the endpoint was placed.
 */
export function placeDirectionsEndpoint(which, point) {
  if (which !== 'a' && which !== 'b') return false;
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon))
    return false;
  // The claim is held until this click has finished being dispatched, so the
  // ambient handlers that run after this one still see the pointer as taken.
  disarm({ afterDispatch: true });
  if (which === 'a') _a = point;
  else _b = point;
  placeMarker(which, point);
  if (_a && _b) void requestRoute();
  else notifyRow();
  services.render.governorRequestRender('directions-place');
  return true;
}

/**
 * Arm (or cancel) a globe click for one endpoint.
 *
 * Placement is a TOOL: it takes the pointer so no ambient layer also selects
 * whatever happened to be under the click. If another tool already holds it,
 * this refuses — nothing is armed and the row says why.
 * @param {null|'a'|'b'} which
 * @returns {boolean} Whether the layer is armed after this call.
 */
function setArmed(which) {
  if (!which) {
    disarm();
    return false;
  }
  const claim = services.input.claimPointer(DIRECTIONS_POINTER_OWNER);
  if (!claim) {
    _armed = null;
    _pointerBlocked = true;
    return false;
  }
  // The arbiter answers either `true` or a lease for this claim; keep whichever
  // it gave, and release with that, so the release names THIS claim.
  _pointerClaim = claim === true ? DIRECTIONS_POINTER_OWNER : claim;
  _pointerBlocked = false;
  _armed = which;
  _clearStepSelection();
  return true;
}

function clearAll() {
  _routeAbort?.abort();
  _routeAbort = null;
  _routeSeq += 1;
  cancelOwnedFlight('directions-clear');
  disarm();
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
  services.render.governorRequestRender('directions-clear');
}

/**
 * Stop the route flight THIS layer started — and only that one. The camera is
 * shared: by the time CLEAR is pressed the user may have grabbed it, voice may
 * have flown somewhere, or a tracked aircraft may own it. Cancelling by id
 * leaves every one of those alone.
 * @param {string} reason
 * @returns {boolean} Whether a flight of ours was stopped.
 */
function cancelOwnedFlight(reason) {
  stopFlightProgress();
  if (!_flightId) return false;
  const { wasActive } = services.camera.interruptCameraMotionIfActive(
    _flightId,
    reason,
  );
  _flightId = 0;
  _flightStep = null;
  return wasActive;
}

function stopFlightProgress() {
  if (_flightTimer) clearInterval(_flightTimer);
  _flightTimer = null;
}

/** Follow the owned flight so the list can highlight the step being flown. */
function trackFlightProgress() {
  stopFlightProgress();
  if (!_flightId) return;
  _flightTimer = setInterval(() => {
    const motion = services.camera.getActiveCameraMotion();
    if (!motion || motion.motionId !== _flightId) {
      // The flight finished, or something else took the camera. Either way it
      // is no longer ours to stop.
      _flightId = 0;
      _flightStep = null;
      stopFlightProgress();
      notifyRow();
      return;
    }
    const next = stepIndexAtDistance(_route?.steps, motion.traveledM);
    if (next !== _flightStep) {
      _flightStep = next;
      notifyRow();
    }
  }, FLIGHT_PROGRESS_MS);
}

function flyCurrentRoute() {
  if (!_route || !_viewer) return false;
  cancelOwnedFlight('directions-refly');
  services.camera.initCameraVerbs(_viewer);
  const seams = _cameraServices;
  const result = services.camera.flyRoute(
    [
      {
        type: 'route',
        label: 'Directions',
        path: _route.geometry.map(([lon, lat]) => ({ lon, lat, height: 0 })),
      },
    ],
    { speed: 'normal' },
    // The dolly reads the shared ground floor (and warms the corridor ahead of
    // itself) exactly as the voice route flight does; without it a mountain
    // corridor is flown at sea level.
    typeof seams?.floorFn === 'function' ? seams.floorFn : null,
    // One camera owner: the UI shell's immediate-navigation facade stamps the
    // navigation generation and releases whatever held the camera before the
    // flight starts. Without the shell (tests, a bare viewer) the flight still
    // runs, it just has nothing to take the camera from.
    typeof seams?.runNavigation === 'function' ? seams.runNavigation : null,
    typeof seams?.warmFn === 'function' ? seams.warmFn : null,
  );
  if (result?.ok !== true) {
    console.warn('[Data:Directions] fly refused:', result?.error || result);
    return false;
  }
  _flightId = result.motionId || 0;
  _flightStep = 0;
  trackFlightProgress();
  return true;
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

/**
 * Where a step's card should hang, or null while that is not yet known.
 *
 * Departure and arrival have no maneuver dot — the A and B markers stand for
 * them — and an intermediate dot exists only once its ground cell has
 * answered. So the anchor is resolved from the step's own coordinates against
 * the same shared floor, and a step whose cell is still cold has no anchor at
 * all rather than one at sea level.
 * @param {number} index Step index.
 * @returns {Cesium.Cartesian3|null}
 */
function stepAnchorPosition(index) {
  const step = _route?.steps?.[index];
  if (!step) return null;
  const point = findStepPoint(index);
  if (point?.show) return Cesium.Cartesian3.clone(point.position);
  const height = stepMarkerHeightM(
    services.ground.cachedGroundFloor(step.lat, step.lon),
    services.ground.GROUND_FLOOR_LIFT_M,
  );
  if (height === null) {
    services.ground.warmGroundFloor([{ lat: step.lat, lon: step.lon }]);
    return null;
  }
  return Cesium.Cartesian3.fromDegrees(step.lon, step.lat, height);
}

function refreshStepCard(index) {
  const position = stepAnchorPosition(index);
  if (!position) return false;
  const entry = createDirectionsStepOverlayEntry(
    index,
    position,
    directionsStepCopy(_route.steps, index),
  );
  if (!entry) return false;
  _overlayHost.setEntries(
    DIRECTIONS_STEP_OVERLAY_SOURCE_ID,
    [entry],
    DIRECTIONS_STEP_OVERLAY_SOURCE_OPTIONS,
  );
  return true;
}

/**
 * Open the card for one step. Every step in the list can be opened, including
 * departure and arrival; what a step needs is a resolved ground anchor, not a
 * dot primitive.
 * @param {number} index Step index.
 * @returns {boolean} Whether the card opened.
 */
function _selectStep(index) {
  _clearStepSelection();
  if (!_route || !Number.isInteger(index) || !_route.steps[index]) return false;
  if (!refreshStepCard(index)) {
    // The ground cell is still cold; the anchoring loop will not open a card
    // the reader did not ask for, so say nothing rather than draw it wrong.
    return false;
  }
  _selectedStep = index;
  const point = findStepPoint(index);
  if (point) point.pixelSize = STEP_SELECTED_PIXEL_SIZE;
  services.render.governorRequestRender('directions-select');
  return true;
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
    disarm();
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
    // Placement acts only while this layer actually HOLDS the pointer, and the
    // maneuver-dot selection below is an ambient handler like any other: it
    // yields the moment a tool (this one included) owns the click.
    if (_armed && services.input.isPointerOwnedBy(DIRECTIONS_POINTER_OWNER)) {
      const point = pickGround(click.position);
      if (!point) return;
      placeDirectionsEndpoint(_armed, point);
      return;
    }
    if (!services.input.isPointerFree()) return;
    let picked = null;
    try {
      picked = viewer.scene.pick(click.position);
    } catch {
      picked = null;
    }
    const index = stepIndexFromPick(picked);
    if (index !== null) {
      _selectStep(index);
      return;
    }
    if (_selectedStep !== null) _clearStepSelection();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  if (typeof document !== 'undefined')
    document.addEventListener('keydown', _onKeyDown);
}

function _removeClickHandler() {
  if (_clickHandler) {
    _clickHandler.destroy();
    _clickHandler = null;
  }
  // Teardown can outlive the document (page unload, and every headless test).
  if (typeof document !== 'undefined')
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
    _stepPoints = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    viewer.scene.primitives.add(_stepPoints);
    services.sprites.registerSpriteCollection('directions', _stepPoints);
    _stepPoints.show = false;
    _enabled = false;
    _mode = DEFAULT_DIRECTIONS_MODE;
    disarm();
    _a = null;
    _b = null;
    _route = null;
    _status = 'idle';
    _error = null;
    _flightStep = null;
    _overlayHost.setVisible(DIRECTIONS_STEP_OVERLAY_SOURCE_ID, false);
    services.sprites.restoreSpriteOrder(viewer);
    console.log('[Data:Directions] Initialized');
  },

  /**
   * Show the row chips and listen for placement clicks.
   * @param {Cesium.Viewer} viewer
   */
  enable(viewer) {
    _enabled = true;
    _pointerBlocked = false;
    _stepPoints.show = true;
    _overlayHost.setVisible(DIRECTIONS_STEP_OVERLAY_SOURCE_ID, true);
    _installClickHandler(viewer);
    services.picking.registerPickOwner(
      'directions',
      (pickedId) =>
        typeof pickedId === 'string' && pickedId.startsWith('directions:'),
    );
    syncRenderHold();
    services.sprites.restoreSpriteOrder(viewer);
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
    services.picking.unregisterPickOwner('directions');
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
    if (patch.arm !== undefined) setArmed(patch.arm);
    if (patch.swap && _a && _b) {
      [_a, _b] = [_b, _a];
      placeMarker('a', _a);
      placeMarker('b', _b);
      if (_enabled) void requestRoute();
    }
    if (patch.step !== undefined) {
      if (patch.step === null) _clearStepSelection();
      else _selectStep(patch.step);
    }
    if (patch.fly) flyCurrentRoute();
    notifyRow();
    services.render.governorRequestRender('directions-params');
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
   * Receive the UI shell's camera seams. FLY goes through `runNavigation` —
   * the same immediate-navigation facade voice destinations use — so the route
   * dolly is one more caller of the single camera owner rather than a second
   * one. `floorFn`/`warmFn` are the shared ground floor the dolly flies over.
   * @param {{runNavigation?: Function, floorFn?: Function, warmFn?: Function}|null} services
   */
  attachCameraServices(services) {
    _cameraServices = services || null;
  },

  /**
   * Tear down entirely.
   * @param {Cesium.Viewer} viewer
   */
  destroy(viewer) {
    if (_enabled) this.disable(viewer);
    // disable() has already run these, but destroy() must also be safe on a
    // layer that was never enabled: a claim or a flight left behind would
    // outlive the whole application.
    cancelOwnedFlight('directions-destroy');
    stopStepAnchoring();
    disarm();
    _cameraServices = null;
    _dataManager = null;
    _rowControlsListener = null;
    if (_stepPoints) {
      services.sprites.unregisterSpriteCollection('directions', _stepPoints);
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
