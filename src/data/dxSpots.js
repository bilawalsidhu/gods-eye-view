/**
 * DX Spots layer — live DX-cluster spots (HamRig) as globe markers.
 *
 * Rows come from the same-origin HamRig proxy (`/api/hamrig/spots`); each
 * spot is a DX station heard by a spotter. The DX marker sits at the best
 * position the server knows (exact → grid → call area → entity centroid),
 * coloured by band and fading with age; guesses (entity/area precision) are
 * hollow rings and piles on one centroid are spread on a deterministic
 * spiral so every spot stays pickable. A great-circle arc joins DX and
 * spotter for the selected spot and the newest 25 (dashed when either end
 * is a guess). Selecting a spot pre-warms PSKReporter reception for the DX
 * and asks the proxy for precise positions (`POST /api/hamrig/locate`).
 *
 * "Tune near spotter" hands the spot to the Web Receivers layer: the
 * receiver is chosen next to whoever HEARD the DX (reception reports or the
 * spotter) — never next to the DX itself — and the dock opens through the
 * same `gev:web-receiver-tune` event the voice tools use.
 *
 * Module state mirrors `webReceivers.js`: a Cesium data source of points,
 * cluster styling, a click owner registration, and a small pub/sub for the UI.
 */

import * as Cesium from 'cesium';
import { isOwnedByOtherLayer, registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import { chooseReceiverForSpot } from './dxSpotTuning.js';
import { webReceiversLayer, WEB_RECEIVERS_LAYER_ID } from './webReceivers.js';
import {
  BAND_OPTIONS,
  CONTINENT_OPTIONS,
  DEFAULT_FILTER,
  DX_LOCATE_ENDPOINT,
  ITEM_LIMIT,
  MINUTES_OPTIONS,
  MODE_OPTIONS,
  arcSegments,
  arcSpots,
  arcStyle,
  filterSpots,
  frameRadiusKm,
  locateRequestBody,
  markerStyle,
  mergeLocations,
  normalizeFilter,
  pileOffsets,
  pruneOld,
  receptionPollPlan,
  receptionQuery,
  receptionWarmingUp,
  resolveSpotQuery,
  spotDetailLabel,
  spotLabel,
  spotsFromPayload,
  spotsQuery,
  summarizeSpot,
  trimList,
} from './dxSpotsLogic.js';

export const DX_SPOTS_LAYER_ID = 'dx-spots';
const PREFIX = 'dx-spot:';
const ARC_PREFIX = `${PREFIX}arc:`;
const SELECTED_ID = `${PREFIX}selected`;
const FETCH_TIMEOUT_MS = 20_000;
const GLOBE_INTERACTION_MAX_DISTANCE_M = 30_000_000;
const FLY_TO_ALTITUDE_M = 600_000;
const HOVER_THROTTLE_MS = 80;
const RECEPTION_CACHE_MS = 20_000;
const OUTLINE_DARK = '#06131a';

let _viewer = null;
let _dataManager = null;
let _dataSource = null;
let _removeClusterListener = null;
let _clickHandler = null;
let _enabled = false;
let _managerPresentation = null;
let _loading = false;
let _error = null;
let _stale = false;
let _live = false;
let _updatedAt = null;
let _spots = Object.freeze([]);
let _byId = new Map();
let _renderById = new Map();
let _arcEntities = [];
let _selectedId = null;
let _selectedEntity = null;
let _hoverId = null;
let _hoverAt = 0;
let _filter = DEFAULT_FILTER;
let _lastTune = null;
let _lastRefine = null;
let _abort = null;
let _requestGeneration = 0;
let _loadPromise = null;
const _receptionByCall = new Map();
const _refineInFlight = new Map();
const _listeners = new Set();

function nowIso() {
  return new Date().toISOString();
}

function emitState() {
  const state = getDxSpotsUIState();
  for (const listener of _listeners) {
    try {
      listener(state);
    } catch (error) {
      console.warn('[dx-spots] listener failed', error);
    }
  }
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  try {
    listener(getDxSpotsUIState());
  } catch (error) {
    console.warn('[dx-spots] listener failed', error);
  }
  return () => _listeners.delete(listener);
}

function visibleSpots(nowMs = Date.now()) {
  return filterSpots(_spots, _filter, nowMs);
}

/** Frozen snapshot consumed by the panel and the voice tools. */
export function getDxSpotsUIState() {
  const now = Date.now();
  const visible = visibleSpots(now);
  const selected = _selectedId ? _byId.get(_selectedId) || null : null;
  return Object.freeze({
    enabled: _enabled,
    loading: _loading,
    error: _error,
    stale: _stale,
    live: _live,
    updatedAt: _updatedAt,
    count: _spots.length,
    filteredCount: visible.length,
    selectedId: _selectedId,
    selected,
    selectedSummary: selected ? summarizeSpot(selected, now) : null,
    filter: { ..._filter },
    filters: Object.freeze({
      bands: BAND_OPTIONS,
      modes: MODE_OPTIONS,
      minutes: MINUTES_OPTIONS,
      continents: CONTINENT_OPTIONS,
    }),
    items: Object.freeze(trimList(visible, ITEM_LIMIT)),
    lastTune: _lastTune,
    lastRefine: _lastRefine,
    receptionCalls: Object.freeze([..._receptionByCall.keys()]),
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
  if (visible && _viewer && !_clickHandler) installInteraction();
  if (!visible) removeInteraction();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function cssColor(hex, alpha = 1) {
  return Cesium.Color.fromCssColorString(hex).withAlpha(alpha);
}

function positionOf(row) {
  return Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 30);
}

function applyMarkerStyle(entity, spot, nowMs) {
  const style = markerStyle(spot, nowMs);
  const point = entity.point;
  if (style.hollow) {
    point.color = Cesium.Color.TRANSPARENT;
    point.outlineColor = cssColor(style.color, style.alpha);
    point.outlineWidth = 2;
    point.pixelSize = style.pixelSize + 3;
  } else {
    point.color = cssColor(style.color, style.alpha);
    point.outlineColor = cssColor(OUTLINE_DARK, Math.min(1, style.alpha + 0.2));
    point.outlineWidth = 1;
    point.pixelSize = style.pixelSize;
  }
}

function labelGraphics(text, offsetY = -14) {
  return {
    text,
    font: '12px "JetBrains Mono", monospace',
    fillColor: Cesium.Color.WHITE,
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    pixelOffset: new Cesium.Cartesian2(0, offsetY),
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    showBackground: true,
    backgroundColor: cssColor(OUTLINE_DARK, 0.75),
    show: false,
  };
}

function restyleMarkers() {
  const now = Date.now();
  for (const { spot, entity } of _renderById.values()) {
    applyMarkerStyle(entity, spot, now);
    entity.show = filterSpots([spot], _filter, now).length > 0;
    entity.label.show = _hoverId === spot.id && _selectedId !== spot.id;
  }
  rebuildArcs();
  updateSelectionEntity();
}

function clearArcs() {
  if (_dataSource) {
    for (const entity of _arcEntities) _dataSource.entities.remove(entity);
  }
  _arcEntities = [];
}

function rebuildArcs() {
  clearArcs();
  if (!_dataSource) return;
  const now = Date.now();
  const spots = arcSpots(visibleSpots(now), _selectedId, { arcs: _filter.arcs });
  for (const spot of spots) {
    const style = arcStyle(spot);
    const selected = spot.id === _selectedId;
    const color = cssColor(style.color, selected ? 0.95 : 0.55);
    const material = style.dashed
      ? new Cesium.PolylineDashMaterialProperty({ color, dashLength: 12 })
      : color;
    arcSegments(spot).forEach((segment, index) => {
      if (segment.length < 2) return;
      const positions = Cesium.Cartesian3.fromDegreesArrayHeights(segment.flatMap((point) => [point.lon, point.lat, 30]));
      const entity = _dataSource.entities.add({
        id: `${ARC_PREFIX}${spot.id}:${index}`,
        polyline: {
          positions,
          width: selected ? style.width + 1 : style.width,
          material,
          arcType: Cesium.ArcType.NONE,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M),
        },
      });
      _arcEntities.push(entity);
    });
  }
}

function reconcile(spots) {
  _spots = Object.freeze([...spots]);
  _byId = new Map(spots.map((spot) => [spot.id, spot]));
  if (_selectedId && !_byId.has(_selectedId)) _selectedId = null;
  if (_hoverId && !_byId.has(_hoverId)) _hoverId = null;
  if (_dataSource) _dataSource.entities.removeAll();
  _renderById.clear();
  _arcEntities = [];
  if (!_dataSource) return;
  const now = Date.now();
  const positions = pileOffsets(spots);
  for (const spot of spots) {
    const row = positions.get(spot.id);
    if (!row) continue;
    const position = positionOf(row);
    const entity = _dataSource.entities.add({
      id: `${PREFIX}${spot.id}`,
      position,
      show: filterSpots([spot], _filter, now).length > 0,
      point: {
        pixelSize: 8,
        color: Cesium.Color.WHITE,
        outlineColor: cssColor(OUTLINE_DARK),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(100_000, 1.2, 12_000_000, 1),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M),
      },
      label: labelGraphics(spotLabel(spot)),
    });
    applyMarkerStyle(entity, spot, now);
    _renderById.set(spot.id, { spot, entity, position, render: row });
  }
  rebuildArcs();
  updateSelectionEntity();
}

function selectedPosition(spot) {
  const rendered = _renderById.get(spot.id);
  if (rendered) return rendered.position;
  return spot.dxLoc ? positionOf(spot.dxLoc) : null;
}

function updateSelectionEntity() {
  if (!_viewer) return;
  const spot = _selectedId ? _byId.get(_selectedId) : null;
  const position = spot ? selectedPosition(spot) : null;
  if (!spot || !position) {
    if (_selectedEntity) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    return;
  }
  const text = spotDetailLabel(spot, Date.now());
  if (!_selectedEntity) {
    _selectedEntity = _viewer.entities.add({
      id: SELECTED_ID,
      position,
      point: {
        pixelSize: 22,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: Cesium.Color.fromCssColorString('#ffffff'),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: { ...labelGraphics(text, -22), show: true },
    });
  } else {
    _selectedEntity.position = position;
    _selectedEntity.label.text = text;
  }
  _selectedEntity.show = presentationAllowed();
}

function installClusterStyling() {
  if (!_dataSource || _removeClusterListener) return;
  const clustering = _dataSource.clustering;
  clustering.enabled = true;
  clustering.pixelRange = 22;
  clustering.minimumClusterSize = 4;
  clustering.clusterPoints = true;
  clustering.clusterLabels = false;
  clustering.clusterBillboards = false;
  _removeClusterListener = clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
    const bands = new Map();
    for (const entity of clusteredEntities) {
      const spot = _renderById.get(String(entity.id || '').slice(PREFIX.length))?.spot;
      if (spot) bands.set(spot.band, (bands.get(spot.band) || 0) + 1);
    }
    const dominant = [...bands.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    cluster.point.id = clusteredEntities;
    cluster.billboard.id = clusteredEntities;
    cluster.label.show = false;
    cluster.label.text = '';
    cluster.point.show = true;
    cluster.point.pixelSize = Math.min(24, 11 + Math.log2(clusteredEntities.length) * 1.6);
    cluster.point.color = cssColor(markerStyle({ band: dominant }, 0).color, 0.85);
    cluster.point.outlineColor = Cesium.Color.BLACK;
    cluster.point.outlineWidth = 2;
    cluster.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    cluster.point.distanceDisplayCondition = new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M);
  });
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function spotIdFromEntityId(text) {
  if (!text.startsWith(PREFIX) || text === SELECTED_ID) return null;
  if (text.startsWith(ARC_PREFIX)) {
    const rest = text.slice(ARC_PREFIX.length);
    const cut = rest.lastIndexOf(':');
    return cut > 0 ? rest.slice(0, cut) : rest;
  }
  return text.slice(PREFIX.length);
}

function spotIdFromPick(picked) {
  const raw = picked?.id;
  if (Array.isArray(raw)) {
    const first = raw.find((entity) => String(entity?.id || '').startsWith(PREFIX));
    return first ? spotIdFromEntityId(String(first.id)) : null;
  }
  const id = resolvePickId(picked);
  return id ? spotIdFromEntityId(String(id)) : null;
}

function pickedSpotAt(position) {
  const scene = _viewer?.scene;
  if (!scene || !position) return null;
  const picked = scene.pick(position);
  if (isOwnedByOtherLayer(DX_SPOTS_LAYER_ID, resolvePickId(picked))) return null;
  const id = spotIdFromPick(picked);
  return id && _byId.has(id) ? id : null;
}

function setHover(id) {
  if (id === _hoverId) return;
  const previous = _hoverId ? _renderById.get(_hoverId) : null;
  if (previous) previous.entity.label.show = false;
  _hoverId = id;
  const next = id ? _renderById.get(id) : null;
  if (next && id !== _selectedId) next.entity.label.show = true;
}

function installInteraction() {
  if (!_viewer || _clickHandler) return;
  registerPickOwner(DX_SPOTS_LAYER_ID, (id) => typeof id === 'string' && id.startsWith(PREFIX));
  _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!presentationAllowed()) return;
    const id = pickedSpotAt(click.position);
    if (!id) return;
    selectSpot(id, { origin: 'user' });
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('gev:dx-spot-selected', { detail: { spotId: id } }));
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  _clickHandler.setInputAction((movement) => {
    if (!presentationAllowed()) return;
    const now = Date.now();
    if (now - _hoverAt < HOVER_THROTTLE_MS) return;
    _hoverAt = now;
    setHover(pickedSpotAt(movement.endPosition));
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

function removeInteraction() {
  unregisterPickOwner(DX_SPOTS_LAYER_ID);
  _clickHandler?.destroy();
  _clickHandler = null;
  setHover(null);
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async function fetchJson(url, { signal, method = 'GET', body = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const init = { method, signal: controller.signal, headers: { Accept: 'application/json' } };
    if (body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(json?.error || `HamRig proxy returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return json;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function loadSpots() {
  if (_loadPromise) return _loadPromise;
  const generation = ++_requestGeneration;
  _abort?.abort();
  _abort = new AbortController();
  _loading = true;
  emitState();
  _loadPromise = (async () => {
    try {
      const body = await fetchJson(spotsQuery(), { signal: _abort.signal });
      if (generation !== _requestGeneration) return;
      const spots = pruneOld(spotsFromPayload(body), Date.now());
      reconcile(spots);
      _updatedAt = typeof body?.updatedAt === 'string' ? body.updatedAt : nowIso();
      _live = Boolean(body?.live);
      _stale = !_live;
      _error = spots.length ? null : 'No DX spots in the last hour';
    } catch (error) {
      if (generation !== _requestGeneration) return;
      if (error?.name === 'AbortError') return;
      _error = error?.message || 'DX spots unavailable';
      _stale = true;
      if (_spots.length) reconcile(pruneOld(_spots, Date.now()));
    } finally {
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

/** Resolve once spots have loaded at least once (used by voice tools). */
async function ensureLoaded() {
  if (_spots.length) return _spots;
  await loadSpots();
  return _spots;
}

/** Reception for a DX call (cached 20 s). Never throws; null on failure. */
async function fetchReception(call, { signal, force = false } = {}) {
  const key = String(call || '').toUpperCase();
  if (!key) return null;
  const cached = _receptionByCall.get(key);
  if (!force && cached && Date.now() - cached.at < RECEPTION_CACHE_MS) return cached.reception;
  try {
    const reception = await fetchJson(receptionQuery(key), { signal });
    _receptionByCall.set(key, { at: Date.now(), reception });
    return reception;
  } catch (error) {
    if (error?.name !== 'AbortError') console.warn('[dx-spots] reception fetch failed', error?.message || error);
    return cached?.reception ?? null;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Reception with the optional re-poll plan (3× over 30 s while PSKReporter is warming up). */
async function fetchReceptionWithPlan(call, { waitForReception = false, signal } = {}) {
  const plan = receptionPollPlan(waitForReception);
  let reception = await fetchReception(call, { signal });
  for (let attempt = 1; attempt < plan.attempts && receptionWarmingUp(reception) && !signal?.aborted; attempt += 1) {
    await sleep(plan.intervalMs, signal);
    if (signal?.aborted) break;
    reception = await fetchReception(call, { signal, force: true });
  }
  return reception;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Fly to one spot's DX position at 600 km. */
export function flyToSpot(spot, { altitudeM = FLY_TO_ALTITUDE_M } = {}) {
  if (!_viewer || !spot?.dxLoc) return false;
  const rendered = _renderById.get(spot.id)?.render || spot.dxLoc;
  _viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(rendered.lon, rendered.lat, altitudeM),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
    duration: 2.2,
  });
  return true;
}

/**
 * Re-locate the DX and spotter of one spot precisely (`POST /api/hamrig/locate`)
 * and move its entities. Resolves `{ ok, spotId, changed, error }`; never rejects.
 */
export async function refinePositions(spotId, { signal } = {}) {
  const spot = spotId ? _byId.get(String(spotId)) : null;
  if (!spot) return { ok: false, spotId: spotId ?? null, changed: false, error: 'Spot not found' };
  if (_refineInFlight.has(spot.id)) return _refineInFlight.get(spot.id);
  const task = (async () => {
    try {
      const body = await fetchJson(DX_LOCATE_ENDPOINT, { method: 'POST', body: locateRequestBody(spot), signal });
      const located = body?.located && typeof body.located === 'object' ? body.located : {};
      const { spots, changedIds } = mergeLocations(_spots, located);
      const changed = changedIds.length > 0;
      if (changed) {
        const keepSelected = _selectedId;
        reconcile(spots);
        _selectedId = keepSelected && _byId.has(keepSelected) ? keepSelected : null;
        updateSelectionEntity();
      }
      const refreshed = _byId.get(spot.id) || spot;
      _lastRefine = Object.freeze({
        spotId: spot.id,
        at: nowIso(),
        changed,
        dxPrecision: refreshed.dxLoc?.precision ?? null,
        spotterPrecision: refreshed.spotterLoc?.precision ?? null,
      });
      emitState();
      return { ok: true, spotId: spot.id, changed, spot: refreshed, error: null };
    } catch (error) {
      if (error?.name !== 'AbortError') console.warn('[dx-spots] locate failed', error?.message || error);
      return { ok: false, spotId: spot.id, changed: false, error: error?.message || 'Locate failed' };
    } finally {
      _refineInFlight.delete(spot.id);
    }
  })();
  _refineInFlight.set(spot.id, task);
  return task;
}

/**
 * Select a spot by id; optionally fly to it. Also pre-warms PSKReporter
 * reception for the DX and asks for precise positions in the background.
 */
export function selectSpot(id, { flyTo = false, origin = 'programmatic' } = {}) {
  const spot = id ? _byId.get(String(id)) || resolveSpot(id) : null;
  if (!spot) {
    _selectedId = null;
    updateSelectionEntity();
    rebuildArcs();
    emitState();
    return null;
  }
  _selectedId = spot.id;
  setHover(null);
  const rendered = _renderById.get(spot.id);
  if (rendered) rendered.entity.label.show = false;
  updateSelectionEntity();
  rebuildArcs();
  if (flyTo && _viewer) flyToSpot(spot);
  emitState();
  void fetchReception(spot.dx);
  void refinePositions(spot.id);
  return spot;
}

/** Look up one spot by id (case-insensitive), DX callsign, spotter or comment text. */
export function resolveSpot(query) {
  const text = String(query ?? '').trim();
  if (!text) return null;
  return _byId.get(text) || resolveSpotQuery(_spots, text);
}

/** Change the panel filter (partial; unknown values are ignored). */
export function setDxSpotsFilter(next = {}) {
  _filter = normalizeFilter(next, _filter);
  restyleMarkers();
  emitState();
  return { ..._filter };
}

/** Frame the visible spots (or a list of ids) in one camera move. */
export function frameSpots(ids = null) {
  if (!_viewer) return false;
  const spots = Array.isArray(ids)
    ? ids.map((id) => _byId.get(String(id))).filter(Boolean)
    : visibleSpots();
  const points = spots.map((spot) => _renderById.get(spot.id)?.render || spot.dxLoc).filter(Boolean);
  const frame = frameRadiusKm(points);
  if (!frame) return false;
  const sphere = new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(frame.center.lon, frame.center.lat, 0), frame.radiusKm * 1000);
  _viewer.camera.flyToBoundingSphere(sphere, {
    duration: 2.4,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-60), sphere.radius * 2.6),
  });
  return true;
}

/** Attach the data manager (used to switch the Web Receivers layer on for tuning). */
export function setDataManager(dataManager) {
  _dataManager = dataManager || null;
}

async function ensureWebReceivers({ origin, signal }) {
  const dm = _dataManager;
  if (dm?.layers?.has?.(WEB_RECEIVERS_LAYER_ID)) {
    const enabledNow = typeof dm.isEffectivelyEnabled === 'function' ? dm.isEffectivelyEnabled(WEB_RECEIVERS_LAYER_ID) : dm.isEnabled?.(WEB_RECEIVERS_LAYER_ID);
    if (!enabledNow) {
      const options = { origin };
      if (signal) options.signal = signal;
      await dm.setEnabled(WEB_RECEIVERS_LAYER_ID, true, options);
    }
  }
  await webReceiversLayer.ensureLoaded();
  return webReceiversLayer.getReceivers();
}

/**
 * Tune a web receiver near whoever heard this spot. Ensures the Web Receivers
 * layer is on and loaded, fetches reception evidence, chooses a receiver
 * (`chooseReceiverForSpot`), tunes and selects it, and opens the dock through
 * `gev:web-receiver-tune`. Resolves `{ ok, receiver, distanceKm, evidence,
 * anchor, reason, precision, ... }`; never rejects.
 */
export async function tuneNearSpotter(spotId = null, { origin = 'user', waitForReception = false, signal = null } = {}) {
  const requested = spotId !== null && spotId !== undefined && String(spotId).trim() !== '';
  const spot = requested
    ? (_byId.get(String(spotId)) || resolveSpot(spotId) || null)
    : (_selectedId ? _byId.get(_selectedId) || null : null);
  const base = { ok: false, receiver: null, distanceKm: null, evidence: null, anchor: null, reason: '', precision: null, mode: null, url: null, spot: null, candidates: [] };
  if (!spot) return { ...base, reason: requested ? 'Spot not found' : 'No spot selected' };
  const now = Date.now();
  const spotSummary = summarizeSpot(spot, now);
  try {
    if (_selectedId !== spot.id) {
      _selectedId = spot.id;
      updateSelectionEntity();
      rebuildArcs();
      emitState();
    }
    const receivers = await ensureWebReceivers({ origin, signal });
    if (signal?.aborted) return { ...base, spot: spotSummary, reason: 'Cancelled' };
    const reception = await fetchReceptionWithPlan(spot.dx, { waitForReception, signal });
    if (signal?.aborted) return { ...base, spot: spotSummary, reason: 'Cancelled' };
    const current = _byId.get(spot.id) || spot;
    const choice = chooseReceiverForSpot({ spot: current, receivers, reception, nowMs: Date.now() });
    const precision = choice.best?.precision ?? current.spotterLoc?.precision ?? null;
    if (!choice.best) {
      _lastTune = Object.freeze({ ok: false, spotId: current.id, dx: current.dx, at: nowIso(), reason: choice.reason, evidence: null, precision });
      emitState();
      return { ...base, spot: spotSummary, reason: choice.reason, precision, mode: choice.mode, receptionWarmingUp: receptionWarmingUp(reception) };
    }
    const { receiver, distanceKm, evidence, anchor, reason } = choice.best;
    const tune = webReceiversLayer.tune({ receiverId: receiver.id, hz: current.freqHz, mode: choice.mode });
    if (!tune?.ok) {
      const failure = tune?.error || 'Receiver could not be tuned';
      _lastTune = Object.freeze({ ok: false, spotId: current.id, dx: current.dx, at: nowIso(), reason: failure, evidence, precision, receiverId: receiver.id });
      emitState();
      return { ...base, spot: spotSummary, receiver, distanceKm, evidence, anchor, precision, mode: choice.mode, reason: `${failure}; ${reason}`, candidates: choice.candidates };
    }
    webReceiversLayer.selectReceiver(receiver.id, { flyTo: true, origin });
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('gev:web-receiver-tune', { detail: { receiverId: receiver.id, url: tune.url, openIn: 'dock', origin } }));
    }
    _lastTune = Object.freeze({
      ok: true,
      spotId: current.id,
      dx: current.dx,
      at: nowIso(),
      receiverId: receiver.id,
      receiverName: receiver.name,
      hz: current.freqHz,
      mode: choice.mode,
      url: tune.url,
      distanceKm,
      evidence,
      precision,
      reason,
      anchor,
    });
    emitState();
    return {
      ok: true,
      receiver,
      distanceKm,
      evidence,
      anchor,
      reason,
      precision,
      mode: choice.mode,
      url: tune.url,
      hz: current.freqHz,
      frequencyLabel: tune.frequencyLabel,
      spot: spotSummary,
      candidates: choice.candidates,
      receptionWarmingUp: receptionWarmingUp(reception),
    };
  } catch (error) {
    const cancelled = signal?.aborted || error?.name === 'AbortError';
    const reason = cancelled ? 'Cancelled' : (error?.message || 'Tuning failed');
    if (!cancelled) console.warn('[dx-spots] tuneNearSpotter failed', error);
    _lastTune = Object.freeze({ ok: false, spotId: spot.id, dx: spot.dx, at: nowIso(), reason, evidence: null, precision: spot.spotterLoc?.precision ?? null });
    emitState();
    return { ...base, spot: spotSummary, reason, precision: spot.spotterLoc?.precision ?? null };
  }
}

/** DX Spots layer lifecycle implementation. */
export const dxSpotsLayer = {
  id: DX_SPOTS_LAYER_ID,
  name: 'DX Spots',
  icon: '⚡',
  source: 'HamRig DX cluster',
  updateInterval: 30 * 1000,

  init(viewer, deps = null) {
    _viewer = viewer;
    if (deps?.dataManager) _dataManager = deps.dataManager;
    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('DX spots');
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
    emitState();
  },

  async update() {
    if (!_enabled) return;
    try {
      await loadSpots();
      if (_enabled && !_loading) restyleMarkers();
    } catch (error) {
      _error = error?.message || 'DX spots unavailable';
      _stale = true;
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
    _spots = Object.freeze([]);
    _byId = new Map();
    _renderById.clear();
    _arcEntities = [];
    _selectedId = null;
    _hoverId = null;
    _filter = DEFAULT_FILTER;
    _lastTune = null;
    _lastRefine = null;
    _error = null;
    _stale = false;
    _live = false;
    _updatedAt = null;
    _receptionByCall.clear();
    _refineInFlight.clear();
    _managerPresentation = null;
    _viewer = null;
    _dataManager = null;
    emitState();
    _listeners.clear();
  },

  getStats() {
    return {
      count: _spots.length,
      filtered: visibleSpots().length,
      selected: _selectedId,
      stale: _stale,
      live: _live,
      loading: _loading,
      error: _error,
      lastUpdate: _updatedAt ? Date.parse(_updatedAt) : null,
    };
  },

  subscribe,
  getUIState: getDxSpotsUIState,
  getSpots: () => _spots,
  getSpot: (id) => (id ? _byId.get(String(id)) || null : null),
  getVisibleSpots: () => Object.freeze(visibleSpots()),
  getReception: (call) => _receptionByCall.get(String(call || '').toUpperCase())?.reception ?? null,
  fetchReception,
  ensureLoaded,
  setFilter: setDxSpotsFilter,
  selectSpot,
  resolveSpot,
  frameSpots,
  flyTo: flyToSpot,
  refinePositions,
  tuneNearSpotter,
  setDataManager,
};

export default dxSpotsLayer;
