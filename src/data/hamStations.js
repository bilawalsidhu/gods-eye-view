/**
 * Ham Stations layer — callsign lookups on the globe plus the operator's own
 * station context when the HamRig proxy is logged in.
 *
 *   • lookup(callsign) asks `/api/hamrig/station/:call` (QRZ/HamDB-derived via
 *     HamRig, cty.dat fallback) and drops a cyan marker: filled when the
 *     position is exact, a hollow ring when it is a grid square, call area or
 *     entity centroid. The last 50 lookups stay on the globe.
 *   • "my station" (only when `/api/hamrig/status.authenticated`): worked DXCC
 *     entities (green worked / red needed), worked grid squares scaled by
 *     log QSOs and the rotator beam as a ±12° wedge out to 4000 km, polled
 *     every 10 s while the layer is enabled.
 *
 * `updateInterval: 0` — the manager only arms the 1 s stats ticker and runs
 * the initial `update()`, which loads the status and my-station overlays.
 * Module state mirrors `webReceivers.js` (data source, pick owner, pub/sub).
 */

import * as Cesium from 'cesium';
import { isOwnedByOtherLayer, registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import { HAMRIG_MY_STATION_CREDIT, registerDynamicCredit } from './dataCredits.js';
import {
  DEFAULT_MY_STATION_OVERLAYS,
  GRID_COLOR,
  ROTATOR_COLOR,
  ROTATOR_POLL_MS,
  dxccCounts,
  dxccMarkerStyle,
  extractRows,
  findStation,
  frameRadiusM,
  gridMarkerSize,
  normalizeCallsign,
  normalizeMyStationOverlays,
  precisionLabel,
  pushHistory,
  rotatorLabel,
  rotatorWedge,
  sanitizeDxccEntities,
  sanitizeRotators,
  sanitizeStation,
  sanitizeWorkedGrids,
  stationFlyAltitudeM,
  stationLookupPath,
  stationMarkerStyle,
  stationSummaryLine,
} from './hamStationsLogic.js';

export const HAM_STATIONS_LAYER_ID = 'ham-stations';
const PREFIX = 'ham-station:';
const STATUS_ENDPOINT = '/api/hamrig/status';
const DXCC_ENDPOINT = '/api/hamrig/my/dxcc-status';
const GRIDS_ENDPOINT = '/api/hamrig/my/worked-grids';
const ROTATORS_ENDPOINT = '/api/hamrig/my/rotators';
const FETCH_TIMEOUT_MS = 20_000;
const GLOBE_INTERACTION_MAX_DISTANCE_M = 30_000_000;
const ITEM_LIMIT = 200;

let _viewer = null;
let _dataSource = null;
let _clickHandler = null;
let _enabled = false;
let _managerPresentation = null;
let _loading = false;
let _stale = false;
let _updatedAt = null;
let _errors = Object.freeze({});
let _status = null;
let _stations = Object.freeze([]);
let _byCall = new Map();
let _stationEntities = new Map();
let _selectedId = null;
let _selectedDetail = null;
let _lastLookup = null;
let _lookupPending = null;
let _lookupAbort = null;
let _myOverlays = DEFAULT_MY_STATION_OVERLAYS;
let _dxcc = Object.freeze([]);
let _grids = Object.freeze([]);
let _rotators = Object.freeze([]);
let _dxccEntities = [];
let _gridEntities = [];
let _rotatorEntities = [];
let _rotatorTimer = null;
let _rotatorAbort = null;
let _abort = null;
let _requestGeneration = 0;
let _loadPromise = null;
const _listeners = new Set();

function cleanText(value, maxLength = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cssColor(css, alpha = 1) {
  try {
    return Cesium.Color.fromCssColorString(css).withAlpha(alpha);
  } catch {
    return Cesium.Color.WHITE.withAlpha(alpha);
  }
}

// ---------------------------------------------------------------------------
// Pub/sub + snapshot
// ---------------------------------------------------------------------------

function emitState() {
  const state = getHamStationsUIState();
  for (const listener of _listeners) {
    try {
      listener(state);
    } catch (error) {
      console.warn('[ham-stations] listener failed', error);
    }
  }
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  try {
    listener(getHamStationsUIState());
  } catch (error) {
    console.warn('[ham-stations] listener failed', error);
  }
  return () => _listeners.delete(listener);
}

function combinedError() {
  const messages = Object.entries(_errors).filter(([, message]) => message).map(([key, message]) => `${key}: ${message}`);
  return messages.length ? messages.join(' · ') : null;
}

function authenticated() {
  return Boolean(_status?.authenticated);
}

/** Frozen snapshot consumed by the panel and the voice tools. */
export function getHamStationsUIState() {
  const selected = _selectedId ? _byCall.get(_selectedId) || null : null;
  return Object.freeze({
    enabled: _enabled,
    loading: _loading,
    error: combinedError(),
    errors: { ..._errors },
    stale: _stale,
    updatedAt: _updatedAt,
    count: _stations.length,
    selectedId: _selectedId,
    selected,
    selectedSummary: selected ? stationSummaryLine(selected) : '',
    selectedDetail: _selectedDetail,
    filter: { ..._myOverlays },
    myOverlays: { ..._myOverlays },
    items: Object.freeze(_stations.slice(0, ITEM_LIMIT)),
    lastLookup: _lastLookup,
    lookupPending: _lookupPending,
    authenticated: authenticated(),
    status: _status,
    myStation: Object.freeze({
      available: authenticated(),
      dxcc: dxccCounts(_dxcc),
      gridCount: _grids.length,
      rotators: Object.freeze(_rotators.map((rotator) => ({ ...rotator, label: rotatorLabel(rotator) }))),
    }),
  });
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function presentationAllowed() {
  if (!_managerPresentation) return _enabled;
  return _managerPresentation.enabled && _managerPresentation.lifecycleState === 'enabled' && !_managerPresentation.uncertain;
}

function syncPresentation() {
  const visible = presentationAllowed();
  if (_dataSource) _dataSource.show = visible;
  if (visible && _viewer && !_clickHandler) installInteraction();
  if (!visible) removeInteraction();
  applyMyOverlayVisibility();
}

function applyMyOverlayVisibility() {
  for (const entity of _dxccEntities) entity.show = _myOverlays.dxcc;
  for (const entity of _gridEntities) entity.show = _myOverlays.grids;
  for (const entity of _rotatorEntities) entity.show = _myOverlays.rotator;
}

// ---------------------------------------------------------------------------
// Lookup markers
// ---------------------------------------------------------------------------

function stationPosition(station) {
  return Cesium.Cartesian3.fromDegrees(station.lon, station.lat, 30);
}

function styleStation(station, entity) {
  const style = stationMarkerStyle(station, { selected: station.callsign === _selectedId });
  entity.point.color = cssColor(style.css, style.alpha);
  entity.point.outlineColor = cssColor(style.outlineCss, 1);
  entity.point.outlineWidth = style.outlineWidth;
  entity.point.pixelSize = style.pixelSize;
  const selected = station.callsign === _selectedId;
  const detail = [station.name, station.country].filter(Boolean).join(' · ');
  entity.label.text = selected && detail ? `${station.callsign}\n${detail}` : station.callsign;
  entity.label.showBackground = selected;
}

function renderStations() {
  if (!_dataSource) return;
  const keep = new Set(_stations.map((station) => station.callsign));
  for (const [callsign, row] of _stationEntities) {
    if (!keep.has(callsign)) {
      _dataSource.entities.remove(row.entity);
      _stationEntities.delete(callsign);
    }
  }
  for (const station of _stations) {
    const existing = _stationEntities.get(station.callsign);
    if (existing) {
      existing.station = station;
      existing.entity.position = stationPosition(station);
      styleStation(station, existing.entity);
      continue;
    }
    const entity = _dataSource.entities.add({
      id: `${PREFIX}station:${station.callsign}`,
      position: stationPosition(station),
      point: {
        pixelSize: 11,
        color: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(100_000, 1.2, 12_000_000, 1),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M),
      },
      label: {
        text: station.callsign,
        font: '12px "JetBrains Mono", monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -14),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: false,
        backgroundColor: cssColor('#06131a', 0.75),
      },
    });
    styleStation(station, entity);
    _stationEntities.set(station.callsign, { station, entity });
  }
}

function restyleStations() {
  for (const { station, entity } of _stationEntities.values()) styleStation(station, entity);
}

function flyToStation(station) {
  if (!_viewer || !station) return false;
  _viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(station.lon, station.lat, stationFlyAltitudeM(station.precision)),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
    duration: 2.2,
  });
  return true;
}

/** Select a looked-up station by callsign (case-insensitive); optionally fly to it. */
export function selectStation(callsign, { flyTo = false, origin = 'programmatic' } = {}) {
  const station = callsign ? findStation(_stations, callsign) : null;
  _selectedId = station ? station.callsign : null;
  if (station) _selectedDetail = null;
  restyleStations();
  if (station && flyTo) flyToStation(station);
  emitState();
  if (station && typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('gev:ham-station-selected', { detail: { callsign: station.callsign, origin } }));
  }
  return station;
}

/** Find a station in the history by callsign/id or a name substring. */
export function resolveStation(query) {
  return findStation(_stations, query);
}

/** Frame every station in the history. */
export function frameStations({ padding = 1.6 } = {}) {
  if (!_viewer || !_stations.length) return false;
  const points = _stations.map((station) => stationPosition(station));
  const sphere = Cesium.BoundingSphere.fromPoints(points);
  sphere.radius = frameRadiusM(_stations, { padding }) ?? Math.max(sphere.radius * padding, 60_000);
  _viewer.camera.flyToBoundingSphere(sphere, {
    duration: 2.4,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-60), sphere.radius * 2.6),
  });
  return true;
}

/** Forget the lookup history (keeps my-station overlays). */
export function clearStations() {
  _stations = Object.freeze([]);
  _byCall = new Map();
  _selectedId = null;
  renderStations();
  emitState();
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

async function fetchJson(url, signal, { allow404 = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => null);
    if (response.status === 404 && allow404) return null;
    if (!response.ok) {
      const error = new Error(body?.error || `HamRig proxy returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Look up a callsign, add it to the history and select it. Resolves to the
 * Station (frozen) or null when nothing — not even cty.dat — matched. Never
 * rejects: failures land in `lastLookup.error`.
 */
export async function lookupStation(callsign, { flyTo = false, origin = 'programmatic' } = {}) {
  const call = normalizeCallsign(callsign);
  if (!call) {
    _lastLookup = Object.freeze({ callsign: cleanText(callsign, 40), ok: false, error: 'Enter a callsign (3–15 letters, digits, / or -)', at: new Date().toISOString(), station: null });
    emitState();
    return null;
  }
  _lookupAbort?.abort();
  const controller = new AbortController();
  _lookupAbort = controller;
  _lookupPending = call;
  emitState();
  let station = null;
  let error = null;
  try {
    const body = await fetchJson(stationLookupPath(call), controller.signal, { allow404: true });
    if (controller.signal.aborted) return null;
    station = body ? sanitizeStation(body.station ?? body) : null;
    if (!station) error = body ? 'Station has no usable position' : 'Callsign not found';
  } catch (caught) {
    if (controller.signal.aborted || caught?.name === 'AbortError') return null;
    error = caught?.message || 'Station lookup failed';
  } finally {
    if (_lookupAbort === controller) {
      _lookupAbort = null;
      _lookupPending = null;
    }
  }
  _lastLookup = Object.freeze({ callsign: call, ok: Boolean(station), error, at: new Date().toISOString(), station, precisionLabel: station ? precisionLabel(station.precision) : null });
  if (station) {
    _stations = pushHistory(_stations, station);
    _byCall = new Map(_stations.map((row) => [row.callsign, row]));
    _updatedAt = new Date().toISOString();
    renderStations();
    selectStation(station.callsign, { flyTo, origin });
  } else {
    emitState();
  }
  return station;
}

// ---------------------------------------------------------------------------
// My station
// ---------------------------------------------------------------------------

function clearEntities(list) {
  if (_dataSource) for (const entity of list) _dataSource.entities.remove(entity);
  return [];
}

function renderDxcc() {
  if (!_dataSource) return;
  if (_dxcc.length && _viewer) registerDynamicCredit(_viewer, HAMRIG_MY_STATION_CREDIT);
  _dxccEntities = clearEntities(_dxccEntities);
  for (const entity of _dxcc) {
    const style = dxccMarkerStyle(entity);
    _dxccEntities.push(_dataSource.entities.add({
      id: `${PREFIX}dxcc:${entity.id}`,
      position: Cesium.Cartesian3.fromDegrees(entity.lon, entity.lat, 30),
      show: _myOverlays.dxcc,
      point: {
        pixelSize: style.pixelSize,
        color: cssColor(style.css, style.alpha),
        outlineColor: cssColor('#06131a', 1),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M),
      },
    }));
  }
}

function renderGrids() {
  if (!_dataSource) return;
  if (_grids.length && _viewer) registerDynamicCredit(_viewer, HAMRIG_MY_STATION_CREDIT);
  _gridEntities = clearEntities(_gridEntities);
  for (const grid of _grids) {
    _gridEntities.push(_dataSource.entities.add({
      id: `${PREFIX}grid:${grid.grid}`,
      position: Cesium.Cartesian3.fromDegrees(grid.lon, grid.lat, 30),
      show: _myOverlays.grids,
      point: {
        pixelSize: gridMarkerSize(grid.qsos),
        color: cssColor(GRID_COLOR, 0.7),
        outlineColor: cssColor('#06131a', 1),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M),
      },
    }));
  }
}

function renderRotators() {
  if (!_dataSource) return;
  if (_rotators.length && _viewer) registerDynamicCredit(_viewer, HAMRIG_MY_STATION_CREDIT);
  _rotatorEntities = clearEntities(_rotatorEntities);
  for (const rotator of _rotators) {
    const ring = rotatorWedge(rotator, rotator.azimuth);
    if (!ring) continue;
    const beamAlpha = rotator.online === false ? 0.12 : 0.28;
    _rotatorEntities.push(_dataSource.entities.add({
      id: `${PREFIX}rotator:${rotator.id}:beam`,
      show: _myOverlays.rotator,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(ring.flatMap((p) => [p.lon, p.lat]))),
        material: cssColor(ROTATOR_COLOR, beamAlpha),
        arcType: Cesium.ArcType.GEODESIC,
      },
    }));
    _rotatorEntities.push(_dataSource.entities.add({
      id: `${PREFIX}rotator:${rotator.id}`,
      position: Cesium.Cartesian3.fromDegrees(rotator.lon, rotator.lat, 30),
      show: _myOverlays.rotator,
      point: {
        pixelSize: rotator.isMoving ? 12 : 9,
        color: cssColor(ROTATOR_COLOR, rotator.online === false ? 0.4 : 0.95),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: rotatorLabel(rotator),
        font: '11px "JetBrains Mono", monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, 16),
        verticalOrigin: Cesium.VerticalOrigin.TOP,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 15_000_000),
      },
    }));
  }
}

async function fetchStatus(signal) {
  const body = await fetchJson(STATUS_ENDPOINT, signal);
  _status = Object.freeze({
    enabled: body?.enabled !== false,
    configured: Boolean(body?.configured),
    baseUrl: cleanText(body?.baseUrl, 200) || null,
    authenticated: Boolean(body?.authenticated),
    homeGrid: cleanText(body?.homeGrid, 10).toUpperCase() || null,
    features: body?.features && typeof body.features === 'object' ? { ...body.features } : {},
  });
}

const MY_FETCHERS = {
  async dxcc(signal) {
    const body = await fetchJson(DXCC_ENDPOINT, signal);
    _dxcc = Object.freeze(sanitizeDxccEntities(extractRows(body, ['entities', 'dxcc', 'rows'])));
    renderDxcc();
  },
  async grids(signal) {
    const body = await fetchJson(GRIDS_ENDPOINT, signal);
    _grids = Object.freeze(sanitizeWorkedGrids(extractRows(body, ['grids', 'rows'])));
    renderGrids();
  },
  async rotators(signal) {
    const body = await fetchJson(ROTATORS_ENDPOINT, signal);
    _rotators = Object.freeze(sanitizeRotators(extractRows(body, ['rotators', 'rows'])));
    renderRotators();
  },
};

async function refreshOne(key, signal = null) {
  try {
    await MY_FETCHERS[key](signal);
    _errors = Object.freeze({ ..._errors, [key]: null });
    return true;
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return false;
    // 403 = login not configured; that is a state, not an error worth shouting about
    _errors = Object.freeze({ ..._errors, [key]: error?.status === 403 ? null : (error?.message || `${key} unavailable`) });
    return false;
  } finally {
    emitState();
  }
}

async function pollRotators() {
  if (!_enabled || !authenticated() || !_myOverlays.rotator) return;
  if (_rotatorAbort) return; // a poll is still in flight
  const controller = new AbortController();
  _rotatorAbort = controller;
  try {
    await refreshOne('rotators', controller.signal);
  } finally {
    if (_rotatorAbort === controller) _rotatorAbort = null;
  }
}

function startRotatorPolling() {
  if (_rotatorTimer) return;
  _rotatorTimer = setInterval(() => {
    void pollRotators();
  }, ROTATOR_POLL_MS);
}

function stopRotatorPolling() {
  if (_rotatorTimer) clearInterval(_rotatorTimer);
  _rotatorTimer = null;
  _rotatorAbort?.abort();
  _rotatorAbort = null;
}

/** Load status + my-station overlays; one failure never blanks the others. */
async function loadMyStation() {
  if (_loadPromise) return _loadPromise;
  const generation = ++_requestGeneration;
  _abort?.abort();
  _abort = new AbortController();
  const { signal } = _abort;
  _loading = true;
  emitState();
  _loadPromise = (async () => {
    try {
      try {
        await fetchStatus(signal);
        _errors = Object.freeze({ ..._errors, status: null });
      } catch (error) {
        if (signal.aborted || error?.name === 'AbortError') return;
        _errors = Object.freeze({ ..._errors, status: error?.message || 'HamRig status unavailable' });
        _status = _status || Object.freeze({ enabled: false, configured: false, baseUrl: null, authenticated: false, homeGrid: null, features: {} });
      }
      if (generation !== _requestGeneration || signal.aborted) return;
      if (authenticated()) {
        const jobs = [];
        if (_myOverlays.dxcc) jobs.push(refreshOne('dxcc', signal));
        if (_myOverlays.grids) jobs.push(refreshOne('grids', signal));
        if (_myOverlays.rotator) jobs.push(refreshOne('rotators', signal));
        const results = await Promise.allSettled(jobs);
        if (generation !== _requestGeneration || signal.aborted) return;
        const anyFailed = results.some((result) => result.status !== 'fulfilled' || result.value !== true);
        _stale = anyFailed && Boolean(_dxcc.length || _grids.length || _rotators.length);
      } else {
        _dxcc = Object.freeze([]);
        _grids = Object.freeze([]);
        _rotators = Object.freeze([]);
        _dxccEntities = clearEntities(_dxccEntities);
        _gridEntities = clearEntities(_gridEntities);
        _rotatorEntities = clearEntities(_rotatorEntities);
        _stale = false;
      }
      _updatedAt = new Date().toISOString();
    } catch (error) {
      if (generation !== _requestGeneration || error?.name === 'AbortError') return;
      _errors = Object.freeze({ ..._errors, status: error?.message || 'My-station data unavailable' });
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

/** Toggle my-station overlays; switching one on fetches it when it has no data yet. */
export function setMyStationOverlays(partial = {}) {
  const previous = _myOverlays;
  _myOverlays = normalizeMyStationOverlays(_myOverlays, partial);
  applyMyOverlayVisibility();
  if (_enabled && authenticated()) {
    if (_myOverlays.dxcc && !previous.dxcc && !_dxcc.length) void refreshOne('dxcc');
    if (_myOverlays.grids && !previous.grids && !_grids.length) void refreshOne('grids');
    if (_myOverlays.rotator && !previous.rotator) void pollRotators();
  }
  emitState();
  return _myOverlays;
}

/** Resolve once the status (and my-station data, when logged in) has loaded. */
async function ensureLoaded() {
  if (!_status) await loadMyStation();
  return _stations;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function classifyPick(picked) {
  const id = resolvePickId(picked);
  const text = String(id || '');
  if (!text.startsWith(PREFIX)) return null;
  const rest = text.slice(PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  return { kind: rest.slice(0, colon), key: rest.slice(colon + 1) };
}

function installInteraction() {
  if (!_viewer || _clickHandler) return;
  registerPickOwner(HAM_STATIONS_LAYER_ID, (id) => typeof id === 'string' && id.startsWith(PREFIX));
  _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!presentationAllowed()) return;
    const scene = _viewer?.scene;
    if (!scene || !click?.position) return;
    const picked = scene.pick(click.position);
    if (isOwnedByOtherLayer(HAM_STATIONS_LAYER_ID, resolvePickId(picked))) return;
    const hit = classifyPick(picked);
    if (!hit) return;
    if (hit.kind === 'station') {
      if (_byCall.has(hit.key)) selectStation(hit.key, { origin: 'user' });
      return;
    }
    if (hit.kind === 'dxcc') {
      const entity = _dxcc.find((row) => row.id === hit.key);
      if (entity) _selectedDetail = Object.freeze({ kind: 'dxcc', ...entity, label: `${entity.name} · ${entity.worked ? 'worked' : 'needed'}` });
    } else if (hit.kind === 'grid') {
      const grid = _grids.find((row) => row.grid === hit.key);
      if (grid) _selectedDetail = Object.freeze({ kind: 'grid', ...grid, label: `${grid.grid} · ${grid.qsos} QSO${grid.qsos === 1 ? '' : 's'}` });
    } else if (hit.kind === 'rotator') {
      const id = hit.key.replace(/:beam$/, '');
      const rotator = _rotators.find((row) => row.id === id);
      if (rotator) _selectedDetail = Object.freeze({ kind: 'rotator', ...rotator, label: rotatorLabel(rotator) });
    }
    emitState();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function removeInteraction() {
  unregisterPickOwner(HAM_STATIONS_LAYER_ID);
  _clickHandler?.destroy();
  _clickHandler = null;
}

// ---------------------------------------------------------------------------
// Layer object
// ---------------------------------------------------------------------------

/** Ham Stations layer lifecycle implementation. */
export const hamStationsLayer = {
  id: HAM_STATIONS_LAYER_ID,
  name: 'Ham Stations',
  icon: '👤',
  source: 'HamRig · QRZ/HamDB · cty.dat',
  updateInterval: 0,

  init(viewer) {
    _viewer = viewer;
    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('Ham stations');
      viewer.dataSources.add(_dataSource);
    }
    _dataSource.show = false;
  },

  enable() {
    _enabled = true;
    syncPresentation();
    startRotatorPolling();
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
    _lookupAbort?.abort();
    _lookupAbort = null;
    _lookupPending = null;
    _loading = false;
    _loadPromise = null;
    stopRotatorPolling();
    removeInteraction();
    if (_dataSource) _dataSource.show = false;
    emitState();
  },

  async update() {
    if (!_enabled) return true;
    try {
      await loadMyStation();
    } catch (error) {
      _errors = Object.freeze({ ..._errors, status: error?.message || 'Ham stations update failed' });
      _stale = true;
      emitState();
    }
    return true;
  },

  destroy() {
    this.disable();
    if (_dataSource && _viewer) _viewer.dataSources.remove(_dataSource, true);
    _dataSource = null;
    _stationEntities.clear();
    _dxccEntities = [];
    _gridEntities = [];
    _rotatorEntities = [];
    _stations = Object.freeze([]);
    _byCall = new Map();
    _selectedId = null;
    _selectedDetail = null;
    _lastLookup = null;
    _status = null;
    _dxcc = Object.freeze([]);
    _grids = Object.freeze([]);
    _rotators = Object.freeze([]);
    _myOverlays = DEFAULT_MY_STATION_OVERLAYS;
    _errors = Object.freeze({});
    _stale = false;
    _updatedAt = null;
    _managerPresentation = null;
    _viewer = null;
    emitState();
    _listeners.clear();
  },

  getStats() {
    return {
      count: _stations.length,
      selected: _selectedId,
      authenticated: authenticated(),
      dxcc: dxccCounts(_dxcc),
      grids: _grids.length,
      rotators: _rotators.length,
      stale: _stale,
      loading: _loading || Boolean(_lookupPending),
      error: combinedError(),
      lastUpdate: _updatedAt ? Date.parse(_updatedAt) : null,
    };
  },

  subscribe,
  getUIState: getHamStationsUIState,
  ensureLoaded,
  lookup: lookupStation,
  getStations: () => _stations,
  getStation: (callsign) => findStation(_stations, callsign),
  getLastLookup: () => _lastLookup,
  getStatus: () => _status,
  selectStation,
  select: selectStation,
  resolveStation,
  resolve: resolveStation,
  frame: frameStations,
  flyTo: (callsign) => flyToStation(findStation(_stations, callsign)),
  clearHistory: clearStations,
  getMyStation: () => Object.freeze({ authenticated: authenticated(), dxcc: _dxcc, grids: _grids, rotators: _rotators, overlays: _myOverlays }),
  setMyStationOverlays,
  refreshMyStation: () => loadMyStation(),
};

export default hamStationsLayer;
