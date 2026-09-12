/**
 * DXpeditions layer — announced DX operations (NG3K ADXO, enriched with the
 * Club Log most-wanted rank by HamRig) as outlined globe markers at the
 * entity centroid.
 *
 * Rows come from the same-origin broker at `/api/hamrig/dxpeditions` (see
 * DATA_SOURCES.md); the browser never talks to NG3K or Club Log itself.
 *
 * Rendering: outlined point sized by most-wanted rank (rank ≤ 20 big and
 * pink, otherwise purple), upcoming operations dimmer; the callsign label is
 * permanent for active operations and shown on hover for the others. Several
 * operations often share one entity centroid, so piles are spread with the
 * deterministic spiral from the activations logic (≤ 60 km) to stay pickable.
 *
 * Module state mirrors the Web Receivers layer: a Cesium data source, a
 * click/hover owner registration through the shared pick registry (only
 * while presentation is allowed), and a pub/sub of frozen snapshots for the
 * ham-radio panel and the voice tools. All pure logic lives in
 * `./dxpeditionsLogic.js` so it can be unit-tested without Cesium.
 */

import * as Cesium from 'cesium';
import { isOwnedByOtherLayer, registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import {
  DEFAULT_DXPEDITION_FILTER,
  DXPEDITION_COLORS,
  DXPEDITION_STATUS_FILTERS,
  dxpeditionDetail,
  dxpeditionDisplayPositions,
  dxpeditionLabel,
  dxpeditionMatchesFilter,
  dxpeditionStyle,
  effectiveStatus,
  filterDxpeditions,
  dedupeDxpeditionsById,
  freezeDxpedition,
  isValidDxpedition,
  normalizeDxpeditionFilter,
  resolveDxpedition,
  sortDxpeditions,
  summarizeDxpeditions,
  trimDxpeditionItems,
} from './dxpeditionsLogic.js';
import { frameRadiusM } from './hamActivationsLogic.js';

export const DXPEDITIONS_LAYER_ID = 'dxpeditions';
const ENDPOINT = '/api/hamrig/dxpeditions';
const PREFIX = 'dxpedition:';
const FETCH_TIMEOUT_MS = 20_000;
const FLY_ALTITUDE_M = 1_500_000;
const SNAPSHOT_ITEM_LIMIT = 200;
const HOVER_THROTTLE_MS = 60;
const GLOBE_INTERACTION_MAX_DISTANCE_M = 30_000_000;
const BACKGROUND_COLOR = '#06131a';
const LABEL_FONT = '12px "JetBrains Mono", monospace';

let _viewer = null;
let _dataSource = null;
let _clickHandler = null;
let _enabled = false;
let _managerPresentation = null;
let _loading = false;
let _error = null;
let _stale = false;
let _updatedAt = null;
let _operations = Object.freeze([]);
let _byId = new Map();
let _renderById = new Map();
let _selectedId = null;
let _selectedEntity = null;
let _hoverId = null;
let _hoverEntity = null;
let _hoverPending = null;
let _hoverTimer = null;
let _filter = { ...DEFAULT_DXPEDITION_FILTER };
let _abort = null;
let _requestGeneration = 0;
let _loadPromise = null;
let _hasLoaded = false;
const _listeners = new Set();

function nowMs() {
  return Date.now();
}

function emitState() {
  const state = getDxpeditionsUIState();
  for (const listener of _listeners) {
    try {
      listener(state);
    } catch (error) {
      console.warn('[dxpeditions] listener failed', error);
    }
  }
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  try {
    listener(getDxpeditionsUIState());
  } catch (error) {
    console.warn('[dxpeditions] listener failed', error);
  }
  return () => _listeners.delete(listener);
}

function visibleOperations(now = nowMs()) {
  return filterDxpeditions(_operations, _filter, now);
}

/** Frozen snapshot consumed by the panel and the voice tools. */
export function getDxpeditionsUIState() {
  const now = nowMs();
  const selected = _selectedId ? _byId.get(_selectedId) || null : null;
  const visible = visibleOperations(now);
  const summary = summarizeDxpeditions(_operations, now);
  return Object.freeze({
    enabled: _enabled,
    loading: _loading,
    error: _error,
    stale: _stale,
    updatedAt: _updatedAt,
    count: _operations.length,
    filteredCount: visible.length,
    selectedId: _selectedId,
    selected,
    hoverId: _hoverId,
    filter: Object.freeze({ ..._filter }),
    filters: Object.freeze({ statuses: DXPEDITION_STATUS_FILTERS }),
    counts: Object.freeze(summary),
    items: Object.freeze(trimDxpeditionItems(visible, SNAPSHOT_ITEM_LIMIT, now)),
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

function displayPosition(op) {
  const entry = _renderById.get(op.id);
  const lat = entry?.lat ?? op.lat;
  const lon = entry?.lon ?? op.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return Cesium.Cartesian3.fromDegrees(lon, lat, 30);
}

function labelGraphics(text, pixelOffsetY, { alpha = 1 } = {}) {
  return {
    text,
    font: LABEL_FONT,
    fillColor: Cesium.Color.WHITE.withAlpha(alpha),
    outlineColor: Cesium.Color.BLACK.withAlpha(alpha),
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    pixelOffset: new Cesium.Cartesian2(0, pixelOffsetY),
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    showBackground: true,
    backgroundColor: Cesium.Color.fromCssColorString(BACKGROUND_COLOR).withAlpha(0.75 * alpha),
    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M),
  };
}

function applyStyle(entry, now) {
  const { op, entity } = entry;
  if (!entity) return;
  const style = dxpeditionStyle(op, { nowMs: now });
  const matches = dxpeditionMatchesFilter(op, _filter, now);
  entity.show = matches;
  entity.point.color = Cesium.Color.fromCssColorString(style.color).withAlpha(style.alpha);
  entity.point.outlineColor = Cesium.Color.fromCssColorString(style.outlineColor).withAlpha(style.alpha);
  entity.point.outlineWidth = style.outlineWidth;
  entity.point.pixelSize = style.pixelSize;
  if (entity.label) {
    entity.label.show = matches && style.labelAlways && op.id !== _selectedId;
    entity.label.text = dxpeditionLabel(op);
  }
  entry.status = style.status;
}

function restyleMarkers(now = nowMs()) {
  for (const entry of _renderById.values()) applyStyle(entry, now);
  updateSelectionEntity();
  updateHoverEntity();
}

function reconcile(operations, now = nowMs()) {
  _operations = Object.freeze([...operations]);
  _byId = new Map(operations.map((op) => [op.id, op]));
  if (_selectedId && !_byId.has(_selectedId)) _selectedId = null;
  if (_hoverId && !_byId.has(_hoverId)) _hoverId = null;
  if (_dataSource) _dataSource.entities.removeAll();
  _renderById.clear();
  const positions = dxpeditionDisplayPositions(operations);
  for (const op of operations) {
    const spot = positions.get(op.id) || null;
    const entry = { op, entity: null, lat: spot?.lat ?? op.lat, lon: spot?.lon ?? op.lon, offset: Boolean(spot?.offset), status: effectiveStatus(op, now) };
    if (_dataSource && spot) {
      const style = dxpeditionStyle(op, { nowMs: now });
      entry.entity = _dataSource.entities.add({
        id: `${PREFIX}${op.id}`,
        position: Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, 30),
        show: dxpeditionMatchesFilter(op, _filter, now),
        point: {
          pixelSize: style.pixelSize,
          color: Cesium.Color.fromCssColorString(style.color).withAlpha(style.alpha),
          outlineColor: Cesium.Color.fromCssColorString(style.outlineColor).withAlpha(style.alpha),
          outlineWidth: style.outlineWidth,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(100_000, 1.2, 12_000_000, 1),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M),
        },
        label: {
          ...labelGraphics(dxpeditionLabel(op), -12),
          show: style.labelAlways && op.id !== _selectedId,
        },
      });
    }
    _renderById.set(op.id, entry);
  }
  restyleMarkers(now);
}

function updateSelectionEntity() {
  if (!_viewer) return;
  const op = _selectedId ? _byId.get(_selectedId) : null;
  const position = op ? displayPosition(op) : null;
  if (!op || !position) {
    if (_selectedEntity) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    return;
  }
  const style = dxpeditionStyle(op, { nowMs: nowMs() });
  const text = `${dxpeditionLabel(op)}\n${dxpeditionDetail(op, nowMs())}`;
  if (!_selectedEntity) {
    _selectedEntity = _viewer.entities.add({
      id: `${PREFIX}selected`,
      position,
      point: {
        pixelSize: style.pixelSize + 12,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: Cesium.Color.fromCssColorString(style.color),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: labelGraphics(text, -(style.pixelSize + 14)),
    });
  } else {
    _selectedEntity.position = position;
    _selectedEntity.label.text = text;
    _selectedEntity.label.pixelOffset = new Cesium.Cartesian2(0, -(style.pixelSize + 14));
    _selectedEntity.point.pixelSize = style.pixelSize + 12;
    _selectedEntity.point.outlineColor = Cesium.Color.fromCssColorString(style.color);
  }
  _selectedEntity.show = presentationAllowed();
}

function updateHoverEntity() {
  if (!_viewer) return;
  const op = _hoverId && _hoverId !== _selectedId ? _byId.get(_hoverId) : null;
  const entry = op ? _renderById.get(op.id) : null;
  const position = op ? displayPosition(op) : null;
  // Active operations already carry a permanent label; hover adds the detail line only.
  if (!op || !position || !dxpeditionMatchesFilter(op, _filter, nowMs())) {
    if (_hoverEntity) _viewer.entities.remove(_hoverEntity);
    _hoverEntity = null;
    return;
  }
  const labelled = entry?.entity?.label?.show === true || entry?.entity?.label?.show?.getValue?.() === true;
  const text = labelled ? dxpeditionDetail(op, nowMs()) : `${dxpeditionLabel(op)}\n${dxpeditionDetail(op, nowMs())}`;
  if (!_hoverEntity) {
    _hoverEntity = _viewer.entities.add({
      id: `${PREFIX}hover`,
      position,
      label: labelGraphics(text, labelled ? -30 : -14),
    });
  } else {
    _hoverEntity.position = position;
    _hoverEntity.label.text = text;
    _hoverEntity.label.pixelOffset = new Cesium.Cartesian2(0, labelled ? -30 : -14);
  }
  _hoverEntity.show = presentationAllowed();
}

function operationIdFromPick(picked) {
  // Cluster points carry the clustered entity array as their raw id;
  // resolvePickId coerces that to null, so inspect the raw pick first.
  const raw = picked?.id ?? picked?.primitive?.id;
  if (Array.isArray(raw)) {
    const first = raw.find((entity) => String(entity?.id || '').startsWith(PREFIX));
    return first ? String(first.id).slice(PREFIX.length) : null;
  }
  const text = String(resolvePickId(picked) || '');
  if (!text.startsWith(PREFIX) || text === `${PREFIX}selected` || text === `${PREFIX}hover`) return null;
  return text.slice(PREFIX.length);
}

function pickedOperationAt(position) {
  const scene = _viewer?.scene;
  if (!scene || !position) return null;
  let picked = null;
  try {
    picked = scene.pick(position);
  } catch {
    return null;
  }
  if (isOwnedByOtherLayer(DXPEDITIONS_LAYER_ID, resolvePickId(picked))) return null;
  const id = operationIdFromPick(picked);
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
  setHover(pickedOperationAt(position));
}

function installInteraction() {
  if (!_viewer || _clickHandler) return;
  registerPickOwner(DXPEDITIONS_LAYER_ID, (id) => typeof id === 'string' && id.startsWith(PREFIX));
  _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!presentationAllowed()) return;
    const id = pickedOperationAt(click.position);
    if (!id) return;
    selectDxpedition(id, { origin: 'user' });
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('gev:dxpedition-selected', { detail: { operationId: id } }));
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  _clickHandler.setInputAction((movement) => {
    _hoverPending = movement?.endPosition ? Cesium.Cartesian2.clone(movement.endPosition) : null;
    if (_hoverTimer) return;
    _hoverTimer = setTimeout(flushHover, HOVER_THROTTLE_MS);
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

function removeInteraction() {
  unregisterPickOwner(DXPEDITIONS_LAYER_ID);
  _clickHandler?.destroy();
  _clickHandler = null;
  if (_hoverTimer) clearTimeout(_hoverTimer);
  _hoverTimer = null;
  _hoverPending = null;
  setHover(null);
}

function lookupOperation(idOrQuery) {
  if (idOrQuery === null || idOrQuery === undefined) return null;
  const text = String(idOrQuery).trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const [id, op] of _byId) {
    if (id.toLowerCase() === lower) return op;
  }
  return resolveDxpedition(_operations, text, nowMs());
}

/** Select an operation by id or callsign; optionally fly the camera to it (1500 km). */
export function selectDxpedition(idOrQuery, { flyTo = false, origin = 'programmatic' } = {}) {
  const op = lookupOperation(idOrQuery);
  if (!op) {
    _selectedId = null;
    restyleMarkers();
    emitState();
    return null;
  }
  _selectedId = op.id;
  restyleMarkers();
  if (flyTo && _viewer) flyToDxpedition(op);
  emitState();
  return op;
}

/** Look up one operation by id, callsign, prefix, entity or words without changing state. */
export function resolveDxpeditionQuery(query) {
  return lookupOperation(query);
}

/** Fly to one operation at a continental altitude (1500 km per the contract). */
export function flyToDxpedition(op, { altitudeM = FLY_ALTITUDE_M } = {}) {
  if (!_viewer || !op) return false;
  const target = typeof op === 'string' ? lookupOperation(op) : op;
  if (!target || !Number.isFinite(target.lat) || !Number.isFinite(target.lon)) return false;
  _viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(target.lon, target.lat, altitudeM),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
    duration: 2.2,
  });
  return true;
}

/** Frame several operations (all visible located ones when `ids` is omitted). */
export function frameDxpeditions(ids = null, { padding = 1.6 } = {}) {
  if (!_viewer) return false;
  const targets = Array.isArray(ids) && ids.length
    ? ids.map((id) => lookupOperation(id)).filter(Boolean)
    : visibleOperations();
  const points = targets.map((op) => displayPosition(op)).filter(Boolean);
  if (!points.length) return false;
  const sphere = Cesium.BoundingSphere.fromPoints(points);
  sphere.radius = frameRadiusM(sphere.radius, { padding, minM: 400_000 });
  _viewer.camera.flyToBoundingSphere(sphere, {
    duration: 2.4,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-60), sphere.radius * 2.6),
  });
  return true;
}

/** Change the panel filter (`{ status, mostWantedOnly }`, partial updates allowed). */
export function setDxpeditionsFilter(next = {}) {
  _filter = normalizeDxpeditionFilter(next, _filter);
  restyleMarkers();
  emitState();
  return getDxpeditionsUIState().filter;
}

async function fetchOperations(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(ENDPOINT, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `DXpedition feed returned ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Load (or reload) the operations. Never rejects: upstream failures are
 * captured into `error`/`stale` state so the manager keeps the layer alive.
 */
async function loadOperations({ signal = null } = {}) {
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
      const body = await fetchOperations(abortSignal);
      if (generation !== _requestGeneration) return;
      const now = nowMs();
      const rows = Array.isArray(body?.operations) ? body.operations : [];
      const operations = sortDxpeditions(dedupeDxpeditionsById(rows.filter(isValidDxpedition).map(freezeDxpedition)), now);
      reconcile(operations, now);
      _hasLoaded = true;
      _updatedAt = typeof body?.updatedAt === 'string' ? body.updatedAt : new Date(now).toISOString();
      _stale = false;
      _error = null;
    } catch (error) {
      if (generation !== _requestGeneration) return;
      if (error?.name === 'AbortError') return;
      _error = error?.message || 'DXpedition feed unavailable';
      _stale = _operations.length > 0;
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
  if (_hasLoaded || _operations.length) return _operations;
  await loadOperations();
  return _operations;
}

/** DXpeditions layer lifecycle implementation. */
export const dxpeditionsLayer = {
  id: DXPEDITIONS_LAYER_ID,
  name: 'DXpeditions',
  icon: '🏝',
  source: 'NG3K ADXO / Club Log via HamRig',
  updateInterval: 30 * 60 * 1000,

  init(viewer) {
    _viewer = viewer;
    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('DXpeditions');
      viewer.dataSources.add(_dataSource);
      // No clustering: a few dozen markers at most, and shared centroids are
      // already spread by the spiral so every marker stays pickable.
      _dataSource.clustering.enabled = false;
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
      await loadOperations({ signal });
    } catch (error) {
      // loadOperations never throws; belt and braces so the manager never
      // sees a rejected update from this layer.
      _error = error?.message || 'DXpedition feed unavailable';
      _stale = _operations.length > 0;
      _loading = false;
      emitState();
    }
  },

  destroy() {
    this.disable();
    if (_dataSource && _viewer) _viewer.dataSources.remove(_dataSource, true);
    _dataSource = null;
    _operations = Object.freeze([]);
    _byId = new Map();
    _renderById.clear();
    _selectedId = null;
    _hoverId = null;
    _filter = { ...DEFAULT_DXPEDITION_FILTER };
    _error = null;
    _stale = false;
    _updatedAt = null;
    _hasLoaded = false;
    _managerPresentation = null;
    _viewer = null;
    emitState();
    _listeners.clear();
  },

  getStats() {
    const summary = summarizeDxpeditions(_operations, nowMs());
    return {
      count: _operations.length,
      filtered: visibleOperations().length,
      selected: _selectedId,
      stale: _stale,
      loading: _loading,
      error: _error,
      lastUpdate: _updatedAt ? Date.parse(_updatedAt) : null,
      active: summary.active,
      upcoming: summary.upcoming,
      mostWanted: summary.mostWanted,
    };
  },

  subscribe,
  getUIState: getDxpeditionsUIState,
  getOperations: () => _operations,
  getOperation: (id) => lookupOperation(id),
  ensureLoaded,
  setFilter: setDxpeditionsFilter,
  select: selectDxpedition,
  resolve: resolveDxpeditionQuery,
  frame: frameDxpeditions,
  flyTo: flyToDxpedition,
  colors: DXPEDITION_COLORS,
};

export default dxpeditionsLayer;
