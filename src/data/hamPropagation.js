/**
 * Propagation layer — HF propagation context for radio amateurs on the globe:
 *
 *   • grayline  — sunrise/sunset terminator (90°) and nautical-twilight ring
 *                 (102°) polylines, a translucent night hemisphere and the
 *                 subsolar sun marker, recomputed locally every 60 s
 *   • aurora    — NOAA SWPC OVATION probability oval (a 30–90 min forecast)
 *                 as a PointPrimitiveCollection at ~100 km altitude
 *   • ionosondes — GIRO/KC2G stations with their MUF(3000)F2, grey when stale
 *   • voacap    — VOACAP point-to-area reliability from a transmitter grid as
 *                 translucent rectangle cells (opt-in, costs an upstream run)
 *
 * All data comes from the same-origin HamRig proxy (`/api/hamrig/*`). Every
 * overlay fetch is independent: one upstream failure degrades that overlay
 * only and is reported through `errors`, never thrown out of `update()`.
 *
 * Module state mirrors `webReceivers.js`: a Cesium data source, a click owner
 * registration while presentation is allowed, and a small pub/sub for the UI.
 */

import * as Cesium from 'cesium';
import { isOwnedByOtherLayer, registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import { bandColor, terminatorRing } from './hamRadioShared.js';
import {
  DEFAULT_OVERLAYS,
  VOACAP_FREQUENCIES,
  auroraColor,
  auroraPointSize,
  bandConditionRows,
  buildVoacapQuery,
  defaultTxGrid,
  filterAuroraPoints,
  graylineGeometry,
  ionosondeColor,
  ionosondeFreshness,
  ionosondeLabel,
  normalizeOverlays,
  normalizeVoacapState,
  sanitizeIonosondes,
  summaryReadout,
  voacapCells,
  voacapCameraHeightM,
  voacapQueryString,
} from './hamPropagationLogic.js';

export { VOACAP_FREQUENCIES };

export const HAM_PROPAGATION_LAYER_ID = 'ham-propagation';
const PREFIX = 'ham-propagation:';
const STATUS_ENDPOINT = '/api/hamrig/status';
const SUMMARY_ENDPOINT = '/api/hamrig/propagation';
const AURORA_ENDPOINT = '/api/hamrig/aurora';
const VOACAP_ENDPOINT = '/api/hamrig/voacap';
const IONOSONDES_ENDPOINT = '/api/hamrig/ionosondes';
const FETCH_TIMEOUT_MS = 20_000;
const GRAYLINE_INTERVAL_MS = 60_000;
const OVERLAY_HEIGHT_M = 30_000;
const AURORA_HEIGHT_M = 100_000;
const IONOSONDE_FLY_ALTITUDE_M = 1_500_000;
const ITEM_LIMIT = 200;
const AURORA_ID = `${PREFIX}aurora`;

let _viewer = null;
let _dataSource = null;
let _auroraCollection = null;
let _clickHandler = null;
let _enabled = false;
let _managerPresentation = null;
let _loading = false;
let _stale = false;
let _updatedAt = null;
let _errors = Object.freeze({});
let _summary = null;
let _aurora = null;
let _ionosondes = Object.freeze([]);
let _ionoById = new Map();
let _ionoEntities = new Map();
let _selectedId = null;
let _overlays = DEFAULT_OVERLAYS;
let _voacap = normalizeVoacapState({}, {});
let _voacapResult = null;
let _voacapCells = Object.freeze([]);
let _voacapEntities = [];
let _voacapKey = null;
let _homeGrid = null;
let _statusChecked = false;
let _grayline = null;
let _graylineEntities = [];
let _graylineTimer = null;
let _auroraLabelEntity = null;
let _abort = null;
let _voacapAbort = null;
let _requestGeneration = 0;
let _loadPromise = null;
const _listeners = new Set();

function cleanText(value, maxLength = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  const state = getHamPropagationUIState();
  for (const listener of _listeners) {
    try {
      listener(state);
    } catch (error) {
      console.warn('[ham-propagation] listener failed', error);
    }
  }
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  try {
    listener(getHamPropagationUIState());
  } catch (error) {
    console.warn('[ham-propagation] listener failed', error);
  }
  return () => _listeners.delete(listener);
}

function combinedError() {
  const messages = Object.entries(_errors).filter(([, message]) => message).map(([key, message]) => `${key}: ${message}`);
  return messages.length ? messages.join(' · ') : null;
}

/** Frozen snapshot consumed by the panel and the voice tools. */
export function getHamPropagationUIState() {
  const selected = _selectedId ? _ionoById.get(_selectedId) || null : null;
  const items = _ionosondes.slice(0, ITEM_LIMIT);
  return Object.freeze({
    enabled: _enabled,
    loading: _loading,
    error: combinedError(),
    errors: { ..._errors },
    stale: _stale,
    updatedAt: _updatedAt,
    count: _ionosondes.length + (_aurora?.points.length ?? 0) + _voacapCells.length,
    selectedId: _selectedId,
    selected,
    filter: { ..._overlays },
    overlays: { ..._overlays },
    items: Object.freeze(items),
    ionosondeCount: _ionosondes.length,
    summary: _summary,
    readout: summaryReadout(_summary),
    bandConditions: Object.freeze(bandConditionRows(_summary)),
    aurora: _aurora
      ? Object.freeze({
        count: _aurora.points.length,
        current: _aurora.current,
        level: _aurora.level,
        forecastIso: _aurora.forecastIso,
        observationIso: _aurora.observationIso,
        maxProbability: _aurora.maxProbability,
      })
      : null,
    voacap: Object.freeze({
      ..._voacap,
      cellCount: _voacapCells.length,
      txLat: _voacapResult?.txLat ?? null,
      txLon: _voacapResult?.txLon ?? null,
      utcHour: _voacapResult?.utcHour ?? null,
      ssn: _voacapResult?.ssn ?? null,
      fetchedAt: _voacapResult?.fetchedAt ?? null,
    }),
    grayline: _grayline ? Object.freeze({ sun: _grayline.sun, computedAt: _grayline.computedAt }) : null,
    homeGrid: _homeGrid,
    frequencies: VOACAP_FREQUENCIES,
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
  if (_auroraCollection) _auroraCollection.show = visible && _overlays.aurora;
  if (visible && _viewer && !_clickHandler) installInteraction();
  if (!visible) removeInteraction();
  applyOverlayVisibility();
}

function applyOverlayVisibility() {
  for (const entity of _graylineEntities) entity.show = _overlays.grayline;
  for (const { entity } of _ionoEntities.values()) entity.show = _overlays.ionosondes;
  for (const entity of _voacapEntities) entity.show = _overlays.voacap;
  if (_auroraCollection) _auroraCollection.show = presentationAllowed() && _overlays.aurora;
  if (_auroraLabelEntity) _auroraLabelEntity.show = _overlays.aurora;
}

function viewCentre() {
  const camera = _viewer?.camera;
  const scene = _viewer?.scene;
  if (!camera) return null;
  let cartographic = null;
  const canvas = scene?.canvas;
  if (canvas && typeof camera.pickEllipsoid === 'function') {
    const centre = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const position = camera.pickEllipsoid(centre, scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84);
    if (position) cartographic = Cesium.Cartographic.fromCartesian(position);
  }
  cartographic ||= camera.positionCartographic || null;
  if (!cartographic) return null;
  return { lat: Cesium.Math.toDegrees(cartographic.latitude), lon: Cesium.Math.toDegrees(cartographic.longitude) };
}

// ---------------------------------------------------------------------------
// Grayline
// ---------------------------------------------------------------------------

function clearGrayline() {
  if (_dataSource) for (const entity of _graylineEntities) _dataSource.entities.remove(entity);
  _graylineEntities = [];
}

function flatDegrees(points) {
  const out = [];
  for (const point of points) out.push(point.lon, point.lat, OVERLAY_HEIGHT_M);
  return out;
}

/** Recompute the terminator rings, night hemisphere and sun marker for "now". */
function renderGrayline(nowMs = Date.now()) {
  if (!_dataSource) return;
  clearGrayline();
  const geometry = graylineGeometry(nowMs, { terminatorRingFn: terminatorRing });
  _grayline = geometry;
  if (!geometry) return;
  const add = (options) => {
    const entity = _dataSource.entities.add(options);
    entity.show = _overlays.grayline;
    _graylineEntities.push(entity);
    return entity;
  };
  geometry.night.forEach((ring, index) => {
    if (ring.length < 3) return;
    add({
      id: `${PREFIX}grayline:night:${index}`,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(ring.flatMap((p) => [p.lon, p.lat]))),
        material: cssColor('#020617', 0.3),
        height: OVERLAY_HEIGHT_M,
        arcType: Cesium.ArcType.GEODESIC,
      },
    });
  });
  geometry.twilight.forEach((segment, index) => {
    if (segment.length < 2) return;
    add({
      id: `${PREFIX}grayline:twilight:${index}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(flatDegrees(segment)),
        width: 1.5,
        arcType: Cesium.ArcType.GEODESIC,
        material: new Cesium.PolylineDashMaterialProperty({ color: cssColor('#60a5fa', 0.8), dashLength: 12 }),
      },
    });
  });
  geometry.terminator.forEach((segment, index) => {
    if (segment.length < 2) return;
    add({
      id: `${PREFIX}grayline:terminator:${index}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(flatDegrees(segment)),
        width: 2.5,
        arcType: Cesium.ArcType.GEODESIC,
        material: cssColor('#fbbf24', 0.9),
      },
    });
  });
  add({
    id: `${PREFIX}grayline:sun`,
    position: Cesium.Cartesian3.fromDegrees(geometry.sun.lon, geometry.sun.lat, OVERLAY_HEIGHT_M),
    point: {
      pixelSize: 14,
      color: cssColor('#fde047', 0.95),
      outlineColor: cssColor('#f59e0b', 1),
      outlineWidth: 3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: 'Sun',
      font: '11px "JetBrains Mono", monospace',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -16),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

function startGraylineTicker() {
  if (_graylineTimer) return;
  _graylineTimer = setInterval(() => {
    if (!_enabled) return;
    try {
      renderGrayline();
      emitState();
    } catch (error) {
      console.warn('[ham-propagation] grayline recompute failed', error);
    }
  }, GRAYLINE_INTERVAL_MS);
}

function stopGraylineTicker() {
  if (_graylineTimer) clearInterval(_graylineTimer);
  _graylineTimer = null;
}

// ---------------------------------------------------------------------------
// Aurora
// ---------------------------------------------------------------------------

function renderAurora() {
  if (!_auroraCollection) return;
  _auroraCollection.removeAll();
  if (_auroraLabelEntity && _dataSource) _dataSource.entities.remove(_auroraLabelEntity);
  _auroraLabelEntity = null;
  if (!_aurora) return;
  let peak = null;
  for (const point of _aurora.points) {
    const color = auroraColor(point.value);
    if (!color) continue;
    _auroraCollection.add({
      id: AURORA_ID,
      position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat, AURORA_HEIGHT_M),
      color: new Cesium.Color(color.r, color.g, color.b, color.a),
      pixelSize: auroraPointSize(point.value),
      scaleByDistance: new Cesium.NearFarScalar(2_000_000, 1.6, 20_000_000, 0.8),
    });
    if (!peak || point.value > peak.value) peak = point;
  }
  if (peak && _dataSource) {
    const when = _aurora.forecastIso ? new Date(_aurora.forecastIso) : null;
    const stamp = when && !Number.isNaN(when.getTime())
      ? `${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')} UTC`
      : 'forecast';
    _auroraLabelEntity = _dataSource.entities.add({
      id: `${PREFIX}aurora:label`,
      position: Cesium.Cartesian3.fromDegrees(peak.lon, peak.lat, AURORA_HEIGHT_M),
      show: _overlays.aurora,
      label: {
        text: `Aurora forecast ${stamp} · peak ${Math.round(peak.value)} %`,
        font: '11px "JetBrains Mono", monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -12),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        showBackground: true,
        backgroundColor: cssColor('#06131a', 0.75),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 30_000_000),
      },
    });
  }
  _auroraCollection.show = presentationAllowed() && _overlays.aurora;
}

// ---------------------------------------------------------------------------
// Ionosondes
// ---------------------------------------------------------------------------

function ionosondePosition(station) {
  return Cesium.Cartesian3.fromDegrees(station.lon, station.lat, 30);
}

function styleIonosonde(station, entity) {
  const selected = station.code === _selectedId;
  entity.point.color = cssColor(ionosondeColor(station, bandColor), station.stale ? 0.55 : 0.95);
  entity.point.pixelSize = selected ? 14 : 9;
  entity.point.outlineColor = selected ? Cesium.Color.WHITE : cssColor('#06131a', 1);
  entity.point.outlineWidth = selected ? 2 : 1;
  entity.label.text = ionosondeLabel(station);
  entity.label.fillColor = station.stale ? cssColor('#9aa4b2', 1) : Cesium.Color.WHITE;
  entity.show = _overlays.ionosondes;
}

function renderIonosondes() {
  if (!_dataSource) return;
  for (const { entity } of _ionoEntities.values()) _dataSource.entities.remove(entity);
  _ionoEntities.clear();
  for (const station of _ionosondes) {
    const entity = _dataSource.entities.add({
      id: `${PREFIX}iono:${station.code}`,
      position: ionosondePosition(station),
      point: {
        pixelSize: 9,
        color: Cesium.Color.WHITE,
        outlineColor: cssColor('#06131a', 1),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(100_000, 1.2, 12_000_000, 1),
      },
      label: {
        text: '',
        font: '11px "JetBrains Mono", monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -12),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        translucencyByDistance: new Cesium.NearFarScalar(3_000_000, 1, 25_000_000, 0.55),
      },
    });
    styleIonosonde(station, entity);
    _ionoEntities.set(station.code, { station, entity });
  }
}

function restyleIonosondes() {
  for (const { station, entity } of _ionoEntities.values()) styleIonosonde(station, entity);
}

function ageIonosondes(nowMs = Date.now()) {
  _ionosondes = Object.freeze(_ionosondes.map((station) => ({ ...station, ...ionosondeFreshness(station, nowMs) })));
  _ionoById = new Map(_ionosondes.map((station) => [station.code, station]));
  for (const station of _ionosondes) {
    const row = _ionoEntities.get(station.code);
    if (row) row.station = station;
  }
  restyleIonosondes();
}

/** Select an ionosonde by station code (case-insensitive); optionally fly to it. */
export function selectIonosonde(code, { flyTo = false, origin = 'programmatic' } = {}) {
  const station = code ? _ionoById.get(String(code).trim().toUpperCase()) || null : null;
  _selectedId = station ? station.code : null;
  restyleIonosondes();
  if (station && flyTo && _viewer) {
    _viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(station.lon, station.lat, IONOSONDE_FLY_ALTITUDE_M),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-75), roll: 0 },
      duration: 2.2,
    });
  }
  emitState();
  if (station && typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('gev:ham-propagation-selected', { detail: { code: station.code, origin } }));
  }
  return station;
}

/** Find an ionosonde by code or by a name substring. */
export function resolveIonosonde(query) {
  const text = cleanText(query, 80).toUpperCase();
  if (!text) return null;
  if (_ionoById.has(text)) return _ionoById.get(text);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = _ionosondes.filter((station) => {
    const haystack = `${station.name} ${station.code}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  hits.sort((a, b) => (a.stale === b.stale ? a.name.length - b.name.length : a.stale ? 1 : -1));
  return hits[0] || null;
}

// ---------------------------------------------------------------------------
// VOACAP
// ---------------------------------------------------------------------------

function renderVoacap() {
  if (!_dataSource) return;
  for (const entity of _voacapEntities) _dataSource.entities.remove(entity);
  _voacapEntities = [];
  for (const cell of _voacapCells) {
    if (cell.east - cell.west <= 0 || cell.north - cell.south <= 0) continue;
    const entity = _dataSource.entities.add({
      id: `${PREFIX}voacap:${cell.id}`,
      show: _overlays.voacap,
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(cell.west, cell.south, cell.east, cell.north),
        material: cssColor(cell.css, cell.alpha),
        height: OVERLAY_HEIGHT_M,
      },
    });
    _voacapEntities.push(entity);
  }
}

function ensureTxGrid() {
  if (_voacap.txGrid) return _voacap.txGrid;
  const grid = defaultTxGrid({ homeGrid: _homeGrid, viewCentre: viewCentre() });
  if (grid) _voacap = normalizeVoacapState(_voacap, { grid });
  return _voacap.txGrid;
}

async function refreshVoacap({ force = false } = {}) {
  ensureTxGrid();
  const query = buildVoacapQuery(_voacap);
  if (!query) {
    _errors = Object.freeze({ ..._errors, voacap: 'VOACAP needs a transmitter grid (set one or move the view)' });
    emitState();
    return;
  }
  const key = voacapQueryString(query);
  if (!force && key === _voacapKey && _voacapResult) return;
  _voacapAbort?.abort();
  const controller = new AbortController();
  _voacapAbort = controller;
  try {
    const body = await fetchJson(`${VOACAP_ENDPOINT}?${key}`, controller.signal);
    if (controller.signal.aborted) return;
    const points = Array.isArray(body?.points) ? body.points : [];
    _voacapResult = Object.freeze({
      txLat: finiteNumber(body?.txLat),
      txLon: finiteNumber(body?.txLon),
      frequencyMhz: finiteNumber(body?.frequencyMhz),
      utcHour: finiteNumber(body?.utcHour),
      ssn: finiteNumber(body?.ssn),
      pointCount: points.length,
      fetchedAt: typeof body?.generatedAt === 'string' ? body.generatedAt : new Date().toISOString(),
    });
    _voacapCells = Object.freeze(voacapCells(points, { resolution: query.resolution }));
    _voacapKey = key;
    _errors = Object.freeze({ ..._errors, voacap: null });
    renderVoacap();
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') return;
    _errors = Object.freeze({ ..._errors, voacap: error?.message || 'VOACAP unavailable' });
  } finally {
    if (_voacapAbort === controller) _voacapAbort = null;
    emitState();
  }
}

/** Change the VOACAP transmitter grid / frequency / hour; refetches when the overlay is on. */
export function setVoacap(patch = {}) {
  const next = normalizeVoacapState(_voacap, patch);
  const changed = JSON.stringify(next) !== JSON.stringify(_voacap);
  _voacap = next;
  emitState();
  if (changed && _enabled && _overlays.voacap) void refreshVoacap();
  return _voacap;
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

/** Toggle overlays; newly switched-on overlays without data are fetched right away. */
export function setOverlays(partial = {}) {
  const previous = _overlays;
  _overlays = normalizeOverlays(_overlays, partial);
  applyOverlayVisibility();
  if (_enabled) {
    if (_overlays.grayline && !_graylineEntities.length) renderGrayline();
    if (_overlays.aurora && !previous.aurora && !_aurora) void refreshOne('aurora');
    if (_overlays.ionosondes && !previous.ionosondes && !_ionosondes.length) void refreshOne('ionosondes');
    if (_overlays.voacap && !previous.voacap) void refreshVoacap();
  }
  emitState();
  return _overlays;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function ionoCodeFromPick(picked) {
  const id = resolvePickId(picked);
  const text = String(id || '');
  const marker = `${PREFIX}iono:`;
  return text.startsWith(marker) ? text.slice(marker.length) : null;
}

function installInteraction() {
  if (!_viewer || _clickHandler) return;
  registerPickOwner(HAM_PROPAGATION_LAYER_ID, (id) => typeof id === 'string' && id.startsWith(PREFIX));
  _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!presentationAllowed()) return;
    const scene = _viewer?.scene;
    if (!scene || !click?.position) return;
    const picked = scene.pick(click.position);
    if (isOwnedByOtherLayer(HAM_PROPAGATION_LAYER_ID, resolvePickId(picked))) return;
    const code = ionoCodeFromPick(picked);
    if (code && _ionoById.has(code)) selectIonosonde(code, { origin: 'user' });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function removeInteraction() {
  unregisterPickOwner(HAM_PROPAGATION_LAYER_ID);
  _clickHandler?.destroy();
  _clickHandler = null;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchJson(url, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `HamRig proxy returned ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function ensureStatus(signal) {
  if (_statusChecked) return;
  try {
    const body = await fetchJson(STATUS_ENDPOINT, signal);
    _homeGrid = typeof body?.homeGrid === 'string' && body.homeGrid ? body.homeGrid.toUpperCase() : null;
    _statusChecked = true;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // status is a convenience (home grid) — never fatal
    _homeGrid = null;
  }
}

const FETCHERS = {
  async summary(signal) {
    const grid = ensureTxGrid() || _homeGrid;
    const url = grid ? `${SUMMARY_ENDPOINT}?grid=${encodeURIComponent(grid)}` : SUMMARY_ENDPOINT;
    const body = await fetchJson(url, signal);
    if (!body || typeof body !== 'object') throw new Error('Propagation summary was empty');
    _summary = Object.freeze({
      solar: { ...(body.solar || {}) },
      bands: { ...(body.bands || {}) },
      dayNight: { ...(body.dayNight || {}) },
      ionosonde: body.ionosonde && typeof body.ionosonde === 'object' ? body.ionosonde : { nearest: null, essn: null },
      updatedIso: typeof body.updatedIso === 'string' ? body.updatedIso : null,
      sources: Array.isArray(body.sources) ? body.sources.map((entry) => cleanText(entry, 80)) : [],
      generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : null,
    });
  },
  async aurora(signal) {
    const body = await fetchJson(AURORA_ENDPOINT, signal);
    const points = filterAuroraPoints(body?.points);
    _aurora = Object.freeze({
      points: Object.freeze(points),
      current: finiteNumber(body?.current),
      level: cleanText(body?.level, 40) || null,
      observationIso: typeof body?.observationIso === 'string' ? body.observationIso : null,
      forecastIso: typeof body?.forecastIso === 'string' ? body.forecastIso : null,
      maxProbability: points.reduce((max, point) => Math.max(max, point.value), 0),
    });
    renderAurora();
  },
  async ionosondes(signal) {
    const body = await fetchJson(IONOSONDES_ENDPOINT, signal);
    const rows = sanitizeIonosondes(Array.isArray(body?.stations) ? body.stations : Array.isArray(body) ? body : []);
    const nowMs = Date.now();
    _ionosondes = Object.freeze(rows.map((station) => ({ ...station, ...ionosondeFreshness(station, nowMs) })));
    _ionoById = new Map(_ionosondes.map((station) => [station.code, station]));
    if (_selectedId && !_ionoById.has(_selectedId)) _selectedId = null;
    renderIonosondes();
  },
};

async function refreshOne(key, signal = null) {
  try {
    await FETCHERS[key](signal);
    _errors = Object.freeze({ ..._errors, [key]: null });
    return true;
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return false;
    _errors = Object.freeze({ ..._errors, [key]: error?.message || `${key} unavailable` });
    return false;
  } finally {
    emitState();
  }
}

async function refreshAll() {
  if (_loadPromise) return _loadPromise;
  const generation = ++_requestGeneration;
  _abort?.abort();
  _abort = new AbortController();
  const { signal } = _abort;
  _loading = true;
  emitState();
  _loadPromise = (async () => {
    try {
      await ensureStatus(signal);
      if (generation !== _requestGeneration || signal.aborted) return;
      if (_overlays.grayline) renderGrayline();
      const jobs = [refreshOne('summary', signal)];
      if (_overlays.aurora) jobs.push(refreshOne('aurora', signal));
      if (_overlays.ionosondes) jobs.push(refreshOne('ionosondes', signal));
      if (_overlays.voacap) jobs.push(refreshVoacap({ force: true }).then(() => !_errors.voacap));
      const results = await Promise.allSettled(jobs);
      if (generation !== _requestGeneration || signal.aborted) return;
      const anyOk = results.some((result) => result.status === 'fulfilled' && result.value === true);
      const anyFailed = results.some((result) => result.status !== 'fulfilled' || result.value !== true);
      if (anyOk) _updatedAt = new Date().toISOString();
      _stale = anyFailed && Boolean(_summary || _aurora || _ionosondes.length);
    } catch (error) {
      if (generation !== _requestGeneration || error?.name === 'AbortError') return;
      _errors = Object.freeze({ ..._errors, summary: error?.message || 'Propagation data unavailable' });
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

/** Resolve once the summary has loaded (used by voice tools). */
async function ensureLoaded() {
  if (_summary) return _summary;
  await refreshAll();
  return _summary;
}

/** Fly to a whole-globe view centred on the VOACAP transmitter (or the sun). */
export function frameVoacap() {
  if (!_viewer) return false;
  const lat = _voacapResult?.txLat ?? _grayline?.sun?.lat ?? 30;
  const lon = _voacapResult?.txLon ?? _grayline?.sun?.lon ?? 0;
  _viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, voacapCameraHeightM()),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    duration: 2.4,
  });
  return true;
}

/** Fly to a polar view that shows the aurora oval; northern hemisphere by default. */
export function frameAurora({ hemisphere = 'north' } = {}) {
  if (!_viewer) return false;
  const north = hemisphere !== 'south';
  const lon = _grayline?.antisolar?.lon ?? 0;
  _viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, north ? 75 : -75, 12_000_000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-88), roll: 0 },
    duration: 2.4,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Layer object
// ---------------------------------------------------------------------------

/** Propagation layer lifecycle implementation. */
export const hamPropagationLayer = {
  id: HAM_PROPAGATION_LAYER_ID,
  name: 'Propagation',
  icon: '☀',
  source: 'HamRig · NOAA SWPC · VOACAP · KC2G',
  updateInterval: 5 * 60 * 1000,

  init(viewer) {
    _viewer = viewer;
    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('Ham propagation');
      viewer.dataSources.add(_dataSource);
    }
    if (!_auroraCollection) {
      _auroraCollection = new Cesium.PointPrimitiveCollection();
      viewer.scene.primitives.add(_auroraCollection);
    }
    _dataSource.show = false;
    _auroraCollection.show = false;
  },

  enable() {
    _enabled = true;
    syncPresentation();
    if (_overlays.grayline) {
      try {
        renderGrayline();
      } catch (error) {
        console.warn('[ham-propagation] grayline render failed', error);
      }
    }
    startGraylineTicker();
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
    _voacapAbort?.abort();
    _voacapAbort = null;
    _loading = false;
    _loadPromise = null;
    stopGraylineTicker();
    removeInteraction();
    if (_dataSource) _dataSource.show = false;
    if (_auroraCollection) _auroraCollection.show = false;
    emitState();
  },

  async update() {
    if (!_enabled) return true;
    try {
      await refreshAll();
      ageIonosondes();
    } catch (error) {
      _errors = Object.freeze({ ..._errors, summary: error?.message || 'Propagation update failed' });
      _stale = true;
      emitState();
    }
    return true;
  },

  destroy() {
    this.disable();
    clearGrayline();
    if (_dataSource && _viewer) _viewer.dataSources.remove(_dataSource, true);
    if (_auroraCollection && _viewer && !_viewer.scene.isDestroyed?.()) _viewer.scene.primitives.remove(_auroraCollection);
    _dataSource = null;
    _auroraCollection = null;
    _auroraLabelEntity = null;
    _ionoEntities.clear();
    _voacapEntities = [];
    _ionosondes = Object.freeze([]);
    _ionoById = new Map();
    _selectedId = null;
    _summary = null;
    _aurora = null;
    _voacapResult = null;
    _voacapCells = Object.freeze([]);
    _voacapKey = null;
    _voacap = normalizeVoacapState({}, {});
    _overlays = DEFAULT_OVERLAYS;
    _grayline = null;
    _errors = Object.freeze({});
    _stale = false;
    _updatedAt = null;
    _homeGrid = null;
    _statusChecked = false;
    _managerPresentation = null;
    _viewer = null;
    emitState();
    _listeners.clear();
  },

  getStats() {
    return {
      count: _ionosondes.length + (_aurora?.points.length ?? 0) + _voacapCells.length,
      ionosondes: _ionosondes.length,
      auroraPoints: _aurora?.points.length ?? 0,
      voacapCells: _voacapCells.length,
      selected: _selectedId,
      stale: _stale,
      loading: _loading,
      error: combinedError(),
      lastUpdate: _updatedAt ? Date.parse(_updatedAt) : null,
    };
  },

  subscribe,
  getUIState: getHamPropagationUIState,
  ensureLoaded,
  getSummary: () => _summary,
  getOverlays: () => _overlays,
  setOverlays,
  getVoacap: () => Object.freeze({ ..._voacap, result: _voacapResult, cells: _voacapCells }),
  setVoacap,
  getAurora: () => _aurora,
  getIonosondes: () => _ionosondes,
  getIonosonde: (code) => (code ? _ionoById.get(String(code).trim().toUpperCase()) || null : null),
  selectIonosonde,
  resolveIonosonde,
  frameVoacap,
  frameAurora,
  refresh: () => refreshAll(),
  VOACAP_FREQUENCIES,
};

export default hamPropagationLayer;
