/**
 * Repeaters layer — FM and D-STAR repeaters from HamRig's repeater database,
 * loaded around wherever the user is looking.
 *
 * The directory is huge and only useful locally, so the layer is manual
 * (`updateInterval: 0`): it loads around the view centre when the camera
 * settles (`camera.moveEnd`, debounced 1.5 s) below a 1500 km height gate,
 * with the search radius derived from the visible span (≤ 300 km). Above the
 * gate the last result stays on the globe and the panel says so. The proxy
 * endpoint is the same-origin `/api/hamrig/repeaters`.
 *
 * Module state mirrors `./webReceivers.js`: a clustered CustomDataSource of
 * points (FM amber, D-STAR purple), a click owner registration held only
 * while presentation is allowed, hover/selection labels and a small pub/sub
 * for the panel. Pure helpers (fetch plan, radius, filter, labels, nearest)
 * live in `./hamRepeatersLogic.js`.
 */

import * as Cesium from 'cesium';
import { isOwnedByOtherLayer, registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import {
  DEFAULT_LIMIT,
  DEFAULT_RADIUS_KM,
  HEIGHT_GATE_M,
  LIST_LIMIT,
  MOVE_END_DEBOUNCE_MS,
  REPEATER_BAND_FILTERS,
  REPEATER_KIND_FILTERS,
  buildRepeatersUrl,
  cameraFetchPlan,
  clampRadiusKm,
  deriveViewCentre,
  describeArea,
  nearestRepeaters,
  normalizeRepeaterFilter,
  parseRepeatersResponse,
  repeaterColor,
  repeaterDetails,
  repeaterLabel,
  repeaterMatchesFilter,
  resolveRepeaterQuery,
  trimList,
  viewSpanKm,
  withDistanceFrom,
} from './hamRepeatersLogic.js';

export const HAM_REPEATERS_LAYER_ID = 'ham-repeaters';
const PREFIX = 'ham-repeater:';
const FETCH_TIMEOUT_MS = 20_000;
const GLOBE_INTERACTION_MAX_DISTANCE_M = 30_000_000;
const FLY_ALTITUDE_M = 120_000;
const HOVER_THROTTLE_MS = 80;
const OUTLINE_COLOR = '#06131a';
const LABEL_FONT = '12px "JetBrains Mono", monospace';

let _viewer = null;
let _dataSource = null;
let _removeClusterListener = null;
let _clickHandler = null;
let _removeMoveEnd = null;
let _debounceTimer = null;
let _enabled = false;
let _managerPresentation = null;
let _loading = false;
let _error = null;
let _stale = false;
let _updatedAt = null;
let _repeaters = Object.freeze([]);
let _byId = new Map();
const _renderById = new Map();
let _area = null;
let _gate = Object.freeze({ heightM: null, withinGate: false, gateM: HEIGHT_GATE_M });
let _lastLoad = null;
let _selectedId = null;
let _selectedEntity = null;
let _hoverId = null;
let _hoverEntity = null;
let _lastHoverPick = 0;
let _filter = normalizeRepeaterFilter();
let _abort = null;
let _requestGeneration = 0;
const _listeners = new Set();

function cssColor(hex, alpha = 1) {
  return Cesium.Color.fromCssColorString(hex || '#ffffff').withAlpha(alpha);
}

function toDegrees(radians) {
  return Cesium.Math.toDegrees(radians);
}

function emitState() {
  const state = getHamRepeatersUIState();
  for (const listener of _listeners) {
    try {
      listener(state);
    } catch (error) {
      console.warn('[ham-repeaters] listener failed', error);
    }
  }
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  try {
    listener(getHamRepeatersUIState());
  } catch (error) {
    console.warn('[ham-repeaters] listener failed', error);
  }
  return () => _listeners.delete(listener);
}

function presentationAllowed() {
  if (!_managerPresentation) return _enabled;
  return _managerPresentation.enabled && _managerPresentation.lifecycleState === 'enabled' && !_managerPresentation.uncertain;
}

function syncPresentation() {
  const visible = presentationAllowed();
  if (_dataSource) _dataSource.show = visible;
  if (_selectedEntity) _selectedEntity.show = visible && Boolean(_selectedId);
  if (_hoverEntity) _hoverEntity.show = visible && Boolean(_hoverId);
  if (visible && _viewer && !_clickHandler) installInteraction();
  if (!visible) removeInteraction();
}

function visibleRepeaters() {
  return _repeaters.filter((repeater) => repeaterMatchesFilter(repeater, _filter));
}

function markerPosition(repeater) {
  return Cesium.Cartesian3.fromDegrees(repeater.lon, repeater.lat, 30);
}

function markerColor(repeater) {
  const base = cssColor(repeaterColor(repeater.kind));
  const status = String(repeater.status || '').toLowerCase();
  if (status.includes('off') || status.includes('closed')) return base.withAlpha(0.35);
  return base.withAlpha(0.9);
}

function markerSize(repeater) {
  return _selectedId === repeater.id ? 14 : 10;
}

function labelGraphics(pixelOffsetY) {
  return {
    text: '',
    font: LABEL_FONT,
    fillColor: Cesium.Color.WHITE,
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    pixelOffset: new Cesium.Cartesian2(0, pixelOffsetY),
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    showBackground: true,
    backgroundColor: cssColor(OUTLINE_COLOR, 0.75),
  };
}

function restyleMarkers() {
  for (const { repeater, entity } of _renderById.values()) {
    entity.point.color = markerColor(repeater);
    entity.point.pixelSize = markerSize(repeater);
    entity.show = repeaterMatchesFilter(repeater, _filter);
  }
  updateSelectionEntity();
}

function reconcile(repeaters) {
  _repeaters = Object.freeze([...repeaters]);
  _byId = new Map(_repeaters.map((repeater) => [repeater.id, repeater]));
  if (_selectedId && !_byId.has(_selectedId)) _selectedId = null;
  if (_hoverId && !_byId.has(_hoverId)) setHover(null);
  if (_dataSource) _dataSource.entities.removeAll();
  _renderById.clear();
  if (!_dataSource) return;
  for (const repeater of _repeaters) {
    const position = markerPosition(repeater);
    const entity = _dataSource.entities.add({
      id: `${PREFIX}${repeater.id}`,
      position,
      show: repeaterMatchesFilter(repeater, _filter),
      point: {
        pixelSize: markerSize(repeater),
        color: markerColor(repeater),
        outlineColor: cssColor(OUTLINE_COLOR),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(50_000, 1.2, 3_000_000, 0.9),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M),
      },
    });
    _renderById.set(repeater.id, { repeater, entity, position });
  }
  updateSelectionEntity();
}

function updateSelectionEntity() {
  if (!_viewer) return;
  const repeater = _selectedId ? _byId.get(_selectedId) : null;
  if (!repeater) {
    if (_selectedEntity) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    return;
  }
  const position = markerPosition(repeater);
  const text = `${repeaterLabel(repeater)}\n${repeaterDetails(repeater)}`;
  if (!_selectedEntity) {
    _selectedEntity = _viewer.entities.add({
      id: `${PREFIX}selected`,
      position,
      point: {
        pixelSize: 22,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: { ...labelGraphics(-22), text },
    });
  } else {
    _selectedEntity.position = position;
    _selectedEntity.label.text = text;
  }
  _selectedEntity.show = presentationAllowed();
}

function setHover(id) {
  const next = id && id !== _selectedId ? id : null;
  if (next === _hoverId) return;
  _hoverId = next;
  if (!_viewer) return;
  const repeater = _hoverId ? _byId.get(_hoverId) : null;
  if (!repeater) {
    if (_hoverEntity) _hoverEntity.show = false;
    return;
  }
  const text = repeaterLabel(repeater);
  if (!_hoverEntity) {
    _hoverEntity = _viewer.entities.add({
      id: `${PREFIX}hover`,
      position: markerPosition(repeater),
      label: { ...labelGraphics(-16), text },
    });
  } else {
    _hoverEntity.position = markerPosition(repeater);
    _hoverEntity.label.text = text;
  }
  _hoverEntity.show = presentationAllowed();
}

function installClusterStyling() {
  if (!_dataSource || _removeClusterListener) return;
  const clustering = _dataSource.clustering;
  clustering.enabled = true;
  clustering.pixelRange = 34;
  clustering.minimumClusterSize = 3;
  clustering.clusterPoints = true;
  clustering.clusterLabels = false;
  clustering.clusterBillboards = false;
  _removeClusterListener = clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
    const kinds = new Map();
    for (const entity of clusteredEntities) {
      const repeater = _renderById.get(String(entity.id || '').slice(PREFIX.length))?.repeater;
      if (repeater) kinds.set(repeater.kind, (kinds.get(repeater.kind) || 0) + 1);
    }
    const dominant = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'FM';
    cluster.point.id = clusteredEntities;
    cluster.billboard.id = clusteredEntities;
    cluster.label.show = false;
    cluster.label.text = '';
    cluster.point.show = true;
    cluster.point.pixelSize = Math.min(26, 12 + Math.log2(clusteredEntities.length) * 1.6);
    cluster.point.color = cssColor(repeaterColor(dominant), 0.85);
    cluster.point.outlineColor = Cesium.Color.BLACK;
    cluster.point.outlineWidth = 2;
    cluster.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    cluster.point.distanceDisplayCondition = new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M);
  });
}

function repeaterIdFromPick(picked) {
  const id = resolvePickId(picked);
  if (Array.isArray(id)) {
    const first = id.find((entity) => String(entity?.id || '').startsWith(PREFIX));
    return first ? String(first.id).slice(PREFIX.length) : null;
  }
  const text = String(id || '');
  if (!text.startsWith(PREFIX)) return null;
  const rest = text.slice(PREFIX.length);
  return rest === 'selected' || rest === 'hover' ? null : rest;
}

function pickedRepeaterAt(position) {
  const scene = _viewer?.scene;
  if (!scene || !position) return null;
  const picked = scene.pick(position);
  if (isOwnedByOtherLayer(HAM_REPEATERS_LAYER_ID, resolvePickId(picked))) return null;
  const id = repeaterIdFromPick(picked);
  return id && _byId.has(id) ? id : null;
}

function installInteraction() {
  if (!_viewer || _clickHandler) return;
  registerPickOwner(HAM_REPEATERS_LAYER_ID, (id) => typeof id === 'string' && id.startsWith(PREFIX));
  _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!presentationAllowed()) return;
    const id = pickedRepeaterAt(click.position);
    if (!id) return;
    selectHamRepeater(id, { origin: 'user' });
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('gev:ham-repeater-selected', { detail: { repeaterId: id } }));
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  _clickHandler.setInputAction((movement) => {
    if (!presentationAllowed()) return;
    const now = Date.now();
    if (now - _lastHoverPick < HOVER_THROTTLE_MS) return;
    _lastHoverPick = now;
    setHover(pickedRepeaterAt(movement.endPosition));
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

function removeInteraction() {
  unregisterPickOwner(HAM_REPEATERS_LAYER_ID);
  _clickHandler?.destroy();
  _clickHandler = null;
  setHover(null);
}

// ─── Camera-driven loading ─────────────────────────────────────

/** Height, look-at centre and visible span of the current view, or null without a camera. */
function cameraView() {
  const camera = _viewer?.camera;
  const carto = camera?.positionCartographic;
  if (!carto) return null;
  const nadir = { lat: toDegrees(carto.latitude), lon: toDegrees(carto.longitude) };
  let hit = null;
  const canvas = _viewer.scene?.canvas;
  const width = canvas?.clientWidth || canvas?.width || 0;
  const height = canvas?.clientHeight || canvas?.height || 0;
  if (width > 0 && height > 0) {
    try {
      const cartesian = camera.pickEllipsoid(new Cesium.Cartesian2(width / 2, height / 2), Cesium.Ellipsoid.WGS84);
      if (cartesian) {
        const hitCarto = Cesium.Cartographic.fromCartesian(cartesian);
        hit = { lat: toDegrees(hitCarto.latitude), lon: toDegrees(hitCarto.longitude) };
      }
    } catch {
      hit = null;
    }
  }
  const centre = deriveViewCentre({ nadir, hit, heightM: carto.height });
  let spanKm = null;
  try {
    const rect = camera.computeViewRectangle(_viewer.scene?.globe?.ellipsoid || Cesium.Ellipsoid.WGS84);
    if (rect) {
      spanKm = viewSpanKm({
        south: toDegrees(rect.south), west: toDegrees(rect.west), north: toDegrees(rect.north), east: toDegrees(rect.east),
      })?.spanKm ?? null;
    }
  } catch {
    spanKm = null;
  }
  // No rectangle (sky/horizon look): the ground footprint scales with height.
  if (spanKm === null) spanKm = Math.max(30, (carto.height / 1000) * 1.2);
  return { heightM: carto.height, centre, spanKm };
}

function installCameraWatch() {
  if (!_viewer?.camera?.moveEnd || _removeMoveEnd) return;
  _removeMoveEnd = _viewer.camera.moveEnd.addEventListener(() => scheduleCameraLoad());
}

function removeCameraWatch() {
  if (_removeMoveEnd) _removeMoveEnd();
  _removeMoveEnd = null;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = null;
}

function scheduleCameraLoad() {
  if (!_enabled) return;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    void loadFromCamera({ origin: 'camera' });
  }, MOVE_END_DEBOUNCE_MS);
}

/** Load around the view when the camera plan says so. Never throws. */
async function loadFromCamera({ force = false, origin = 'camera', signal = null } = {}) {
  const view = cameraView();
  if (!view) {
    _gate = Object.freeze({ heightM: null, withinGate: false, gateM: HEIGHT_GATE_M });
    emitState();
    return { ok: false, fetched: false, reason: 'no-camera' };
  }
  const plan = cameraFetchPlan({ heightM: view.heightM, centre: view.centre, spanKm: view.spanKm, last: _area, force });
  const gateChanged = _gate.withinGate !== plan.withinGate;
  _gate = Object.freeze({ heightM: Math.round(view.heightM), withinGate: plan.withinGate, gateM: HEIGHT_GATE_M });
  if (!plan.fetch) {
    if (gateChanged) emitState();
    return { ok: true, fetched: false, reason: plan.reason, area: _area };
  }
  const result = await loadRepeatersAround(plan.lat, plan.lon, plan.radiusKm, { origin, reason: plan.reason, signal });
  return { ...result, fetched: result.ok, reason: plan.reason };
}

async function fetchJson(url, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `Repeater directory returned ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Load repeaters around a point. `options.band` / `options.kind` narrow the
 * upstream query AND set the panel filter so the globe and the list agree.
 * Resolves `{ ok, count, area, error }` — never throws; a failure lands in
 * `error`/`stale` and keeps the previous result on the globe.
 */
export async function loadRepeatersAround(lat, lon, radiusKm = DEFAULT_RADIUS_KM, options = {}) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return { ok: false, count: 0, error: 'A latitude and longitude are required' };
  }
  const radius = clampRadiusKm(radiusKm);
  if (options.band !== undefined || options.kind !== undefined) {
    _filter = normalizeRepeaterFilter({ kind: options.kind ?? _filter.kind, band: options.band ?? _filter.band }, _filter);
    restyleMarkers();
  }
  const origin = options.origin || 'programmatic';
  const generation = ++_requestGeneration;
  _abort?.abort();
  _abort = new AbortController();
  const outer = _abort;
  const onOuterAbort = () => outer.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  _loading = true;
  _error = null;
  emitState();
  try {
    const url = buildRepeatersUrl({
      lat: latitude, lon: longitude, radiusKm: radius, limit: options.limit ?? DEFAULT_LIMIT, band: _filter.band, kind: _filter.kind,
    });
    const body = await fetchJson(url, outer.signal);
    if (generation !== _requestGeneration) return { ok: false, count: 0, error: 'superseded' };
    const parsed = parseRepeatersResponse(body);
    const rows = withDistanceFrom(parsed.repeaters, { lat: latitude, lon: longitude })
      .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    reconcile(rows);
    _area = Object.freeze({ lat: latitude, lon: longitude, radiusKm: radius, at: Date.now(), band: _filter.band, kind: _filter.kind, failed: false });
    _lastLoad = Object.freeze({ at: new Date().toISOString(), origin, reason: options.reason || 'manual', count: rows.length });
    _updatedAt = parsed.updatedAt || new Date().toISOString();
    _stale = false;
    _error = null;
    return { ok: true, count: rows.length, area: _area };
  } catch (error) {
    if (generation !== _requestGeneration || error?.name === 'AbortError') return { ok: false, count: 0, error: 'cancelled' };
    _error = error?.message || 'Repeater directory unavailable';
    _stale = _repeaters.length > 0;
    _area = Object.freeze({ lat: latitude, lon: longitude, radiusKm: radius, at: Date.now(), band: _filter.band, kind: _filter.kind, failed: true });
    _lastLoad = Object.freeze({ at: new Date().toISOString(), origin, reason: options.reason || 'manual', count: 0, error: _error });
    return { ok: false, count: 0, error: _error, area: _area };
  } finally {
    options.signal?.removeEventListener('abort', onOuterAbort);
    if (generation === _requestGeneration) {
      _loading = false;
      _abort = null;
      emitState();
    }
  }
}

/** Load around the current view regardless of the gate (panel "LOAD HERE"). */
export function loadRepeatersHere(options = {}) {
  return loadFromCamera({ force: true, origin: options.origin || 'user', signal: options.signal || null });
}

/** Snapshot consumed by the panel and the voice tools (frozen). */
export function getHamRepeatersUIState() {
  const visible = visibleRepeaters();
  const selected = _selectedId ? _byId.get(_selectedId) || null : null;
  return Object.freeze({
    enabled: _enabled,
    loading: _loading,
    error: _error,
    stale: _stale,
    updatedAt: _updatedAt,
    count: _repeaters.length,
    filteredCount: visible.length,
    selectedId: _selectedId,
    selected,
    filter: { ..._filter },
    filters: { kinds: REPEATER_KIND_FILTERS, bands: REPEATER_BAND_FILTERS },
    items: Object.freeze(trimList(visible, LIST_LIMIT)),
    area: _area,
    areaLabel: describeArea(_area),
    gate: _gate,
    lastLoad: _lastLoad,
  });
}

/** Select a repeater by id or callsign; optionally fly to it. */
export function selectHamRepeater(query, { flyTo = false, origin = 'programmatic' } = {}) {
  const repeater = query ? resolveRepeaterQuery(query, _repeaters) : null;
  if (!repeater) {
    _selectedId = null;
    restyleMarkers();
    emitState();
    return null;
  }
  _selectedId = repeater.id;
  if (_hoverId === repeater.id) setHover(null);
  restyleMarkers();
  if (flyTo && _viewer) flyToHamRepeater(repeater);
  emitState();
  return repeater;
}

/** Fly to one repeater at a local altitude. */
export function flyToHamRepeater(repeater, { altitudeM = FLY_ALTITUDE_M } = {}) {
  if (!_viewer || !repeater) return false;
  _viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(repeater.lon, repeater.lat, altitudeM),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
    duration: 2.0,
  });
  return true;
}

/** Frame the currently visible repeaters. */
export function frameHamRepeaters({ padding = 1.5 } = {}) {
  if (!_viewer) return false;
  const points = visibleRepeaters().map(markerPosition);
  if (!points.length) return false;
  const sphere = Cesium.BoundingSphere.fromPoints(points);
  sphere.radius = Math.max(sphere.radius * padding, 20_000);
  _viewer.camera.flyToBoundingSphere(sphere, {
    duration: 2.2,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-60), sphere.radius * 2.6),
  });
  return true;
}

/** Change the panel filter (`{ kind:'all'|'FM'|'D-STAR', band:'all'|'6m'|'2m'|'1.25m'|'70cm' }`). */
export function setHamRepeatersFilter(next = {}) {
  _filter = normalizeRepeaterFilter(next, _filter);
  restyleMarkers();
  emitState();
}

/** Resolve an id or callsign (case-insensitive) to a loaded repeater, or null. */
export function resolveHamRepeater(query) {
  return resolveRepeaterQuery(query, _repeaters);
}

/** The `n` nearest loaded repeaters to a point (filter applied). */
export function nearestHamRepeaters(lat, lon, n = 5) {
  return nearestRepeaters(_repeaters, lat, lon, n, _filter);
}

/** Resolve once something has been loaded (forces a load around the view when empty). */
async function ensureLoaded() {
  if (!_repeaters.length) await loadFromCamera({ force: true, origin: 'programmatic' });
  return _repeaters;
}

/** Repeaters layer lifecycle implementation. */
export const hamRepeatersLayer = {
  id: HAM_REPEATERS_LAYER_ID,
  name: 'Repeaters',
  icon: '📻',
  source: 'HamRig repeater DB',
  updateInterval: 0,

  init(viewer) {
    _viewer = viewer;
    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('Ham repeaters');
      viewer.dataSources.add(_dataSource);
      installClusterStyling();
    }
    _dataSource.show = false;
  },

  enable() {
    _enabled = true;
    installCameraWatch();
    syncPresentation();
    emitState();
  },

  setLifecyclePresentation({ lifecycleState = null, enabled = false, uncertain = false } = {}) {
    const settled = enabled ? 'enabled' : 'disabled';
    _managerPresentation = {
      lifecycleState: ['enabling', 'enabled', 'disabling', 'disabled'].includes(lifecycleState) ? lifecycleState : settled,
      enabled: Boolean(enabled),
      uncertain: Boolean(uncertain),
    };
    syncPresentation();
    emitState();
  },

  disable() {
    _enabled = false;
    removeCameraWatch();
    _requestGeneration += 1;
    _abort?.abort();
    _abort = null;
    _loading = false;
    removeInteraction();
    if (_dataSource) _dataSource.show = false;
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    if (_hoverEntity && _viewer) _viewer.entities.remove(_hoverEntity);
    _hoverEntity = null;
    _hoverId = null;
    emitState();
  },

  /** The one manager-driven update: load around the view when below the gate. Never rejects. */
  async update(viewer, { signal = null } = {}) {
    if (!_enabled) return;
    try {
      await loadFromCamera({ origin: 'enable', signal });
    } catch (error) {
      _error = error?.message || 'Repeater directory unavailable';
      emitState();
    }
  },

  destroy() {
    this.disable();
    _removeClusterListener?.();
    _removeClusterListener = null;
    if (_dataSource && _viewer) _viewer.dataSources.remove(_dataSource, true);
    _dataSource = null;
    _repeaters = Object.freeze([]);
    _byId = new Map();
    _renderById.clear();
    _area = null;
    _gate = Object.freeze({ heightM: null, withinGate: false, gateM: HEIGHT_GATE_M });
    _lastLoad = null;
    _selectedId = null;
    _filter = normalizeRepeaterFilter();
    _error = null;
    _stale = false;
    _updatedAt = null;
    _managerPresentation = null;
    _viewer = null;
    emitState();
    _listeners.clear();
  },

  getStats() {
    return {
      count: _repeaters.length,
      filtered: visibleRepeaters().length,
      selected: _selectedId,
      withinGate: _gate.withinGate,
      area: _area ? { lat: _area.lat, lon: _area.lon, radiusKm: _area.radiusKm } : null,
      stale: _stale,
      loading: _loading,
      error: _error,
      lastUpdate: _updatedAt ? Date.parse(_updatedAt) : null,
    };
  },

  subscribe,
  getUIState: getHamRepeatersUIState,
  getRepeaters: () => _repeaters,
  getRepeater: (id) => (id ? _byId.get(String(id)) || null : null),
  ensureLoaded,
  loadAround: loadRepeatersAround,
  loadHere: loadRepeatersHere,
  setFilter: setHamRepeatersFilter,
  select: selectHamRepeater,
  resolve: resolveHamRepeater,
  nearest: nearestHamRepeaters,
  frame: frameHamRepeaters,
  flyTo: flyToHamRepeater,
};

export default hamRepeatersLayer;
