/**
 * Activations layer — live POTA / SOTA / WWFF / BOTA activations as globe
 * markers, coloured by program and fading with age.
 *
 * Rows come from the same-origin broker at `/api/hamrig/activations`
 * (POTA and SOTA fetched directly by the broker, WWFF/BOTA via HamRig; see
 * DATA_SOURCES.md). The browser never talks to the upstream feeds itself.
 *
 * Module state mirrors the Web Receivers layer: a Cesium data source of
 * points with cluster styling, a click/hover owner registration through the
 * shared pick registry (only while presentation is allowed), and a small
 * pub/sub whose frozen snapshots feed the ham-radio panel and voice tools.
 * All pure logic (validation, filters, age styling, spiral offsets, search)
 * lives in `./hamActivationsLogic.js` so it can be unit-tested without Cesium.
 */

import * as Cesium from 'cesium';
import { isOwnedByOtherLayer, registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import {
  ACTIVATION_BAND_FILTERS,
  ACTIVATION_PROGRAMS,
  ACTIVATION_PROGRAM_LABELS,
  DEFAULT_ACTIVATION_FILTER,
  activationAgeStyle,
  activationDetail,
  activationLabel,
  activationMatchesFilter,
  dedupeActivations,
  filterActivations,
  frameRadiusM,
  freezeActivation,
  isFreshActivation,
  isValidActivation,
  nearestActivations,
  normalizeActivationFilter,
  programColor,
  resolveActivation,
  spreadCoincidentPositions,
  summarizeActivations,
  trimActivationItems,
} from './hamActivationsLogic.js';

export const HAM_ACTIVATIONS_LAYER_ID = 'ham-activations';
const ENDPOINT = '/api/hamrig/activations';
const PREFIX = 'ham-activation:';
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_LIMIT = 400;
const FLY_ALTITUDE_M = 600_000;
const SNAPSHOT_ITEM_LIMIT = 200;
const HOVER_THROTTLE_MS = 60;
const GLOBE_INTERACTION_MAX_DISTANCE_M = 30_000_000;
const OUTLINE_COLOR = '#06131a';
const LABEL_FONT = '12px "JetBrains Mono", monospace';

let _viewer = null;
let _dataSource = null;
let _removeClusterListener = null;
let _clickHandler = null;
let _enabled = false;
let _managerPresentation = null;
let _loading = false;
let _error = null;
let _stale = false;
let _degraded = false;
let _disabledPrograms = Object.freeze([]);
let _sourceErrors = Object.freeze({});
let _updatedAt = null;
let _activations = Object.freeze([]);
let _byId = new Map();
let _renderById = new Map();
let _selectedId = null;
let _selectedEntity = null;
let _hoverId = null;
let _hoverEntity = null;
let _hoverPending = null;
let _hoverTimer = null;
let _filter = { programs: new Set(DEFAULT_ACTIVATION_FILTER.programs), band: DEFAULT_ACTIVATION_FILTER.band };
let _abort = null;
let _requestGeneration = 0;
let _loadPromise = null;
let _hasLoaded = false;
const _listeners = new Set();

function nowMs() {
  return Date.now();
}

function emitState() {
  const state = getHamActivationsUIState();
  for (const listener of _listeners) {
    try {
      listener(state);
    } catch (error) {
      console.warn('[ham-activations] listener failed', error);
    }
  }
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  try {
    listener(getHamActivationsUIState());
  } catch (error) {
    console.warn('[ham-activations] listener failed', error);
  }
  return () => _listeners.delete(listener);
}

function visibleActivations() {
  return filterActivations(_activations, _filter);
}

/** Frozen snapshot consumed by the panel and the voice tools. */
export function getHamActivationsUIState() {
  const selected = _selectedId ? _byId.get(_selectedId) || null : null;
  const visible = visibleActivations();
  const summary = summarizeActivations(_activations);
  return Object.freeze({
    enabled: _enabled,
    loading: _loading,
    error: _error,
    stale: _stale,
    degraded: _degraded,
    disabledPrograms: _disabledPrograms,
    updatedAt: _updatedAt,
    count: _activations.length,
    filteredCount: visible.length,
    selectedId: _selectedId,
    selected,
    hoverId: _hoverId,
    filter: Object.freeze({ programs: Object.freeze([..._filter.programs]), band: _filter.band }),
    filters: Object.freeze({
      programs: Object.freeze(ACTIVATION_PROGRAMS.map((program) => Object.freeze({
        id: program,
        label: ACTIVATION_PROGRAM_LABELS[program],
        color: programColor(program),
        count: summary.byProgram[program] || 0,
      }))),
      bands: ACTIVATION_BAND_FILTERS,
    }),
    counts: Object.freeze({ byProgram: Object.freeze(summary.byProgram), byBand: Object.freeze(summary.byBand) }),
    sourceErrors: _sourceErrors,
    items: Object.freeze(trimActivationItems(visible, SNAPSHOT_ITEM_LIMIT)),
  });
}

function presentationAllowed() {
  if (!_managerPresentation) return _enabled;
  return _managerPresentation.enabled && _managerPresentation.lifecycleState === 'enabled' && !_managerPresentation.uncertain;
}

function syncPresentation() {
  const visible = presentationAllowed();
  if (_dataSource) _dataSource.show = visible;
  if (_selectedEntity) _selectedEntity.show = visible && Boolean(_selectedId);
  if (_hoverEntity) _hoverEntity.show = visible && Boolean(_hoverId) && _hoverId !== _selectedId;
  if (visible && _viewer && !_clickHandler) installInteraction();
  if (!visible) removeInteraction();
}

function displayPosition(activation) {
  const entry = _renderById.get(activation.id);
  const lat = entry?.lat ?? activation.lat;
  const lon = entry?.lon ?? activation.lon;
  return Cesium.Cartesian3.fromDegrees(lon, lat, 30);
}

function markerColor(activation, style) {
  return Cesium.Color.fromCssColorString(programColor(activation.program)).withAlpha(style.alpha);
}

function restyleMarkers(now = nowMs()) {
  for (const { activation, entity } of _renderById.values()) {
    const style = activationAgeStyle(activation.timeIso, now);
    entity.point.color = markerColor(activation, style);
    entity.point.pixelSize = style.pixelSize;
    entity.show = activationMatchesFilter(activation, _filter);
  }
  updateSelectionEntity();
  updateHoverEntity();
}

function reconcile(activations, now = nowMs()) {
  _activations = Object.freeze([...activations]);
  _byId = new Map(activations.map((activation) => [activation.id, activation]));
  if (_selectedId && !_byId.has(_selectedId)) _selectedId = null;
  if (_hoverId && !_byId.has(_hoverId)) _hoverId = null;
  if (_dataSource) _dataSource.entities.removeAll();
  _renderById.clear();
  const positions = spreadCoincidentPositions(activations);
  for (const activation of activations) {
    const spot = positions.get(activation.id) || { lat: activation.lat, lon: activation.lon, offset: false };
    const entry = { activation, entity: null, lat: spot.lat, lon: spot.lon, offset: spot.offset };
    if (_dataSource) {
      const style = activationAgeStyle(activation.timeIso, now);
      entry.entity = _dataSource.entities.add({
        id: `${PREFIX}${activation.id}`,
        position: Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, 30),
        show: activationMatchesFilter(activation, _filter),
        point: {
          pixelSize: style.pixelSize,
          color: markerColor(activation, style),
          outlineColor: Cesium.Color.fromCssColorString(OUTLINE_COLOR),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(100_000, 1.2, 12_000_000, 1),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M),
        },
      });
    }
    _renderById.set(activation.id, entry);
  }
  updateSelectionEntity();
  updateHoverEntity();
}

function labelGraphics(text, pixelOffsetY) {
  return {
    text,
    font: LABEL_FONT,
    fillColor: Cesium.Color.WHITE,
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    pixelOffset: new Cesium.Cartesian2(0, pixelOffsetY),
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    showBackground: true,
    backgroundColor: Cesium.Color.fromCssColorString(OUTLINE_COLOR).withAlpha(0.75),
  };
}

function updateSelectionEntity() {
  if (!_viewer) return;
  const activation = _selectedId ? _byId.get(_selectedId) : null;
  if (!activation) {
    if (_selectedEntity) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    return;
  }
  const position = displayPosition(activation);
  const text = `${activationLabel(activation)}\n${activationDetail(activation, nowMs())}`;
  if (!_selectedEntity) {
    _selectedEntity = _viewer.entities.add({
      id: `${PREFIX}selected`,
      position,
      point: {
        pixelSize: 22,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: Cesium.Color.fromCssColorString(programColor(activation.program)),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: labelGraphics(text, -22),
    });
  } else {
    _selectedEntity.position = position;
    _selectedEntity.label.text = text;
    _selectedEntity.point.outlineColor = Cesium.Color.fromCssColorString(programColor(activation.program));
  }
  _selectedEntity.show = presentationAllowed();
}

function updateHoverEntity() {
  if (!_viewer) return;
  const activation = _hoverId && _hoverId !== _selectedId ? _byId.get(_hoverId) : null;
  if (!activation || !activationMatchesFilter(activation, _filter)) {
    if (_hoverEntity) _viewer.entities.remove(_hoverEntity);
    _hoverEntity = null;
    return;
  }
  const position = displayPosition(activation);
  const text = activationLabel(activation);
  if (!_hoverEntity) {
    _hoverEntity = _viewer.entities.add({
      id: `${PREFIX}hover`,
      position,
      label: labelGraphics(text, -14),
    });
  } else {
    _hoverEntity.position = position;
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
    const programs = new Map();
    for (const entity of clusteredEntities) {
      const activation = _renderById.get(String(entity.id || '').slice(PREFIX.length))?.activation;
      if (activation) programs.set(activation.program, (programs.get(activation.program) || 0) + 1);
    }
    const dominant = [...programs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'POTA';
    cluster.point.id = clusteredEntities;
    cluster.billboard.id = clusteredEntities;
    cluster.label.show = false;
    cluster.label.text = '';
    cluster.point.show = true;
    cluster.point.pixelSize = Math.min(26, 12 + Math.log2(clusteredEntities.length) * 1.6);
    cluster.point.color = Cesium.Color.fromCssColorString(programColor(dominant)).withAlpha(0.85);
    cluster.point.outlineColor = Cesium.Color.BLACK;
    cluster.point.outlineWidth = 2;
    cluster.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    cluster.point.distanceDisplayCondition = new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M);
  });
}

function activationIdFromPick(picked) {
  const id = resolvePickId(picked);
  if (Array.isArray(id)) {
    const first = id.find((entity) => String(entity?.id || '').startsWith(PREFIX));
    return first ? String(first.id).slice(PREFIX.length) : null;
  }
  const text = String(id || '');
  if (!text.startsWith(PREFIX) || text === `${PREFIX}selected` || text === `${PREFIX}hover`) return null;
  return text.slice(PREFIX.length);
}

function pickedActivationAt(position) {
  const scene = _viewer?.scene;
  if (!scene || !position) return null;
  let picked = null;
  try {
    picked = scene.pick(position);
  } catch {
    return null;
  }
  if (isOwnedByOtherLayer(HAM_ACTIVATIONS_LAYER_ID, resolvePickId(picked))) return null;
  const id = activationIdFromPick(picked);
  return id && _byId.has(id) ? id : null;
}

function setHover(id) {
  if (id === _hoverId) return;
  _hoverId = id;
  updateHoverEntity();
}

function flushHover() {
  _hoverTimer = null;
  const position = _hoverPending;
  _hoverPending = null;
  if (!position || !presentationAllowed()) {
    setHover(null);
    return;
  }
  setHover(pickedActivationAt(position));
}

function installInteraction() {
  if (!_viewer || _clickHandler) return;
  registerPickOwner(HAM_ACTIVATIONS_LAYER_ID, (id) => typeof id === 'string' && id.startsWith(PREFIX));
  _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!presentationAllowed()) return;
    const id = pickedActivationAt(click.position);
    if (!id) return;
    selectHamActivation(id, { origin: 'user' });
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('gev:ham-activation-selected', { detail: { activationId: id } }));
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  _clickHandler.setInputAction((movement) => {
    _hoverPending = movement?.endPosition ? Cesium.Cartesian2.clone(movement.endPosition) : null;
    if (_hoverTimer) return;
    _hoverTimer = setTimeout(flushHover, HOVER_THROTTLE_MS);
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

function removeInteraction() {
  unregisterPickOwner(HAM_ACTIVATIONS_LAYER_ID);
  _clickHandler?.destroy();
  _clickHandler = null;
  if (_hoverTimer) clearTimeout(_hoverTimer);
  _hoverTimer = null;
  _hoverPending = null;
  setHover(null);
}

function lookupActivation(idOrQuery) {
  if (idOrQuery === null || idOrQuery === undefined) return null;
  const text = String(idOrQuery).trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const [id, activation] of _byId) {
    if (id.toLowerCase() === lower) return activation;
  }
  return resolveActivation(_activations, text);
}

/** Select an activation by id or callsign; optionally fly the camera to it. */
export function selectHamActivation(idOrQuery, { flyTo = false, origin = 'programmatic' } = {}) {
  const activation = lookupActivation(idOrQuery);
  if (!activation) {
    _selectedId = null;
    updateSelectionEntity();
    updateHoverEntity();
    emitState();
    return null;
  }
  _selectedId = activation.id;
  updateSelectionEntity();
  updateHoverEntity();
  if (flyTo && _viewer) flyToHamActivation(activation);
  emitState();
  return activation;
}

/** Look up one activation by id, callsign, reference or words without changing state. */
export function resolveHamActivation(query) {
  return lookupActivation(query);
}

/** Fly to one activation at a regional altitude (600 km per the contract). */
export function flyToHamActivation(activation, { altitudeM = FLY_ALTITUDE_M } = {}) {
  if (!_viewer || !activation) return false;
  const target = typeof activation === 'string' ? lookupActivation(activation) : activation;
  if (!target || !Number.isFinite(target.lat) || !Number.isFinite(target.lon)) return false;
  _viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(target.lon, target.lat, altitudeM),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
    duration: 2.2,
  });
  return true;
}

/** Frame several activations (all visible ones when `ids` is omitted). */
export function frameHamActivations(ids = null, { padding = 1.6 } = {}) {
  if (!_viewer) return false;
  const targets = Array.isArray(ids) && ids.length
    ? ids.map((id) => lookupActivation(id)).filter(Boolean)
    : visibleActivations();
  const points = targets.map((activation) => displayPosition(activation));
  if (!points.length) return false;
  const sphere = Cesium.BoundingSphere.fromPoints(points);
  sphere.radius = frameRadiusM(sphere.radius, { padding });
  _viewer.camera.flyToBoundingSphere(sphere, {
    duration: 2.4,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-60), sphere.radius * 2.6),
  });
  return true;
}

/** Nearest visible activations to a point: `[{ activation, distanceKm }]`. */
export function nearestHamActivations(lat, lon, n = 5) {
  return nearestActivations(visibleActivations(), lat, lon, n);
}

/** Change the panel filter (`{ programs, band }`, partial updates allowed). */
export function setHamActivationsFilter(next = {}) {
  _filter = normalizeActivationFilter(next, _filter);
  restyleMarkers();
  emitState();
  return getHamActivationsUIState().filter;
}

function endpointUrl() {
  const programs = ACTIVATION_PROGRAMS.map((program) => program.toLowerCase()).join(',');
  return `${ENDPOINT}?programs=${programs}&limit=${FETCH_LIMIT}`;
}

async function fetchActivations(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(endpointUrl(), { signal: controller.signal, headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `Activations feed returned ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function cleanSourceErrors(errors) {
  if (!errors || typeof errors !== 'object') return Object.freeze({});
  const cleaned = {};
  for (const program of ACTIVATION_PROGRAMS) {
    const message = errors[program] ?? errors[program.toLowerCase()];
    if (message) cleaned[program] = String(message).slice(0, 200);
  }
  return Object.freeze(cleaned);
}

/**
 * Load (or reload) the activations. Never rejects: upstream failures are
 * captured into `error`/`stale` state so the manager keeps the layer alive.
 */
async function loadActivations({ signal = null } = {}) {
  if (_loadPromise) return _loadPromise;
  const generation = ++_requestGeneration;
  _abort?.abort();
  _abort = new AbortController();
  const abortSignal = _abort.signal;
  const onExternalAbort = () => _abort?.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  _loading = true;
  _error = null;
  emitState();
  _loadPromise = (async () => {
    try {
      const body = await fetchActivations(abortSignal);
      if (generation !== _requestGeneration) return;
      const now = nowMs();
      const rows = Array.isArray(body?.activations) ? body.activations : [];
      const fresh = dedupeActivations(
        rows.filter(isValidActivation).map(freezeActivation).filter((activation) => isFreshActivation(activation, now)),
      );
      reconcile(fresh, now);
      _hasLoaded = true;
      _updatedAt = typeof body?.updatedAt === 'string' ? body.updatedAt : new Date(now).toISOString();
      _sourceErrors = cleanSourceErrors(body?.errors);
      _disabledPrograms = Object.freeze(Object.keys(_sourceErrors).filter((program) => /^disabled by configuration/i.test(_sourceErrors[program])));
      const failedPrograms = Object.keys(_sourceErrors).filter((program) => !_disabledPrograms.includes(program));
      _degraded = failedPrograms.length > 0;
      _stale = false;
      _error = (!fresh.length && failedPrograms.length >= ACTIVATION_PROGRAMS.length)
        ? `Activation feeds unavailable (${failedPrograms.join(', ')})`
        : null;
    } catch (error) {
      if (generation !== _requestGeneration) return;
      if (error?.name === 'AbortError') return;
      _error = error?.message || 'Activations feed unavailable';
      _stale = _activations.length > 0;
      restyleMarkers();
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
      if (generation === _requestGeneration) {
        _loading = false;
        _abort = null;
        emitState();
      }
      _loadPromise = null;
    }
  })();
  return _loadPromise;
}

/** Resolve once the first load has completed (used by voice tools). */
async function ensureLoaded() {
  if (_hasLoaded || _activations.length) return _activations;
  await loadActivations();
  return _activations;
}

/** Activations layer lifecycle implementation. */
export const hamActivationsLayer = {
  id: HAM_ACTIVATIONS_LAYER_ID,
  name: 'Activations',
  icon: '⛰',
  source: 'POTA / SOTA / WWFF / BOTA via HamRig',
  updateInterval: 60 * 1000,

  init(viewer) {
    _viewer = viewer;
    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('Ham activations');
      viewer.dataSources.add(_dataSource);
      installClusterStyling();
    }
    _dataSource.show = false;
  },

  enable() {
    _enabled = true;
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
    _requestGeneration += 1;
    _abort?.abort();
    _abort = null;
    _loading = false;
    _loadPromise = null;
    removeInteraction();
    if (_dataSource) _dataSource.show = false;
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    if (_hoverEntity && _viewer) _viewer.entities.remove(_hoverEntity);
    _hoverEntity = null;
    emitState();
  },

  async update(_viewerArg, { signal = null } = {}) {
    if (!_enabled) return;
    try {
      await loadActivations({ signal });
    } catch (error) {
      // loadActivations never throws; this is belt and braces so the manager
      // never sees a rejected update from this layer.
      _error = error?.message || 'Activations feed unavailable';
      _stale = _activations.length > 0;
      _loading = false;
      emitState();
    }
  },

  destroy() {
    this.disable();
    _removeClusterListener?.();
    _removeClusterListener = null;
    if (_dataSource && _viewer) _viewer.dataSources.remove(_dataSource, true);
    _dataSource = null;
    _activations = Object.freeze([]);
    _byId = new Map();
    _renderById.clear();
    _selectedId = null;
    _hoverId = null;
    _filter = { programs: new Set(DEFAULT_ACTIVATION_FILTER.programs), band: DEFAULT_ACTIVATION_FILTER.band };
    _error = null;
    _stale = false;
    _degraded = false;
    _sourceErrors = Object.freeze({});
    _updatedAt = null;
    _hasLoaded = false;
    _managerPresentation = null;
    _viewer = null;
    emitState();
    _listeners.clear();
  },

  getStats() {
    const summary = summarizeActivations(_activations);
    return {
      count: _activations.length,
      filtered: visibleActivations().length,
      selected: _selectedId,
      stale: _stale,
      degraded: _degraded,
    disabledPrograms: _disabledPrograms,
      loading: _loading,
      error: _error,
      lastUpdate: _updatedAt ? Date.parse(_updatedAt) : null,
      byProgram: summary.byProgram,
    };
  },

  subscribe,
  getUIState: getHamActivationsUIState,
  getActivations: () => _activations,
  getActivation: (id) => lookupActivation(id),
  ensureLoaded,
  setFilter: setHamActivationsFilter,
  select: selectHamActivation,
  resolve: resolveHamActivation,
  frame: frameHamActivations,
  nearest: nearestHamActivations,
  flyTo: flyToHamActivation,
};

export default hamActivationsLayer;
