/**
 * Web Receivers layer — internet-controllable radio receivers (KiwiSDR,
 * WebSDR, OpenWebRX) as globe markers you can find and tune.
 *
 * The directory comes from the same-origin broker at `/api/web-receivers/catalog`
 * (Receiverbook + the community KiwiSDR feed, see DATA_SOURCES.md). Tuning is a
 * URL: GEV never proxies audio or talks to a receiver itself — the receiver's
 * own web page is loaded in a panel dock or a new tab, so the receiver sees
 * the listener's browser exactly as if they had typed the address.
 *
 * Module state mirrors the Radio layer: a Cesium data source of points,
 * cluster styling, a click owner registration, and a small pub/sub for the UI.
 */

import * as Cesium from 'cesium';
import { isOwnedByOtherLayer, registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import {
  BAND_FILTERS,
  RECEIVER_TYPES,
  RECEIVER_TYPE_LABELS,
  buildSpectrumUrl,
  buildTuneUrl,
  defaultModeForHz,
  describeReceiverBands,
  formatFrequencyHz,
  formatFrequencyRange,
  normalizeReceiverMode,
  rankWebReceivers,
  receiverCoversHz,
  receiverCoversRangeHz,
  receiverMatchesFilter,
} from './webReceiverTuning.js';

export const WEB_RECEIVERS_LAYER_ID = 'web-receivers';
const CATALOG_ENDPOINT = '/api/web-receivers/catalog';
const PREFIX = 'web-receiver:';
const FETCH_TIMEOUT_MS = 20_000;
const GLOBE_INTERACTION_MAX_DISTANCE_M = 30_000_000;
const HIGHLIGHT_LIMIT = 12;

/** Marker colour per receiver family. */
export const RECEIVER_TYPE_COLORS = Object.freeze({
  kiwisdr: '#63f39a',
  websdr: '#ffb454',
  openwebrx: '#5ec8ff',
});

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
let _updatedAt = null;
let _sources = null;
let _receivers = Object.freeze([]);
let _byId = new Map();
let _renderById = new Map();
let _selectedId = null;
let _selectedEntity = null;
let _highlightIds = new Set();
let _filter = { type: 'all', band: 'all' };
let _lastTune = null;
let _lastSearch = null;
let _abort = null;
let _requestGeneration = 0;
let _loadPromise = null;
const _listeners = new Set();

function cleanText(value, maxLength = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Re-validate one broker row; the browser never trusts the wire blindly. */
export function isValidWebReceiver(row) {
  if (!row || typeof row !== 'object') return false;
  if (!/^[a-f0-9]{8,32}$/i.test(String(row.id || ''))) return false;
  if (!RECEIVER_TYPES.includes(row.type)) return false;
  if (!/^https?:\/\//i.test(String(row.url || ''))) return false;
  const lat = finiteNumber(row.lat);
  const lon = finiteNumber(row.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  if (lat === 0 && lon === 0) return false;
  return cleanText(row.name, 160).length > 0;
}

/** Freeze a validated row into the shape the layer and voice tools use. */
export function freezeWebReceiver(row) {
  const bands = Array.isArray(row.bands)
    ? row.bands
      .filter((band) => finiteNumber(band?.lowHz) !== null && finiteNumber(band?.highHz) !== null)
      .map((band) => Object.freeze({
        lowHz: Number(band.lowHz),
        highHz: Number(band.highHz),
        label: cleanText(band.label, 40),
      }))
    : [];
  const users = finiteNumber(row.users);
  const usersMax = finiteNumber(row.usersMax);
  return Object.freeze({
    id: String(row.id).toLowerCase(),
    type: row.type,
    typeLabel: RECEIVER_TYPE_LABELS[row.type],
    name: cleanText(row.name, 160),
    site: cleanText(row.site, 160),
    url: String(row.url),
    lat: Number(row.lat),
    lon: Number(row.lon),
    bands: Object.freeze(bands),
    users: users === null ? null : Math.max(0, Math.round(users)),
    usersMax: usersMax === null ? null : Math.max(0, Math.round(usersMax)),
    online: row.online === false ? false : (row.online === true ? true : null),
    antenna: cleanText(row.antenna, 160),
    sources: Object.freeze(Array.isArray(row.sources) ? row.sources.map((entry) => cleanText(entry, 20)) : []),
  });
}

function emitState() {
  const state = getWebReceiversUIState();
  for (const listener of _listeners) {
    try {
      listener(state);
    } catch (error) {
      console.warn('[web-receivers] listener failed', error);
    }
  }
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  try {
    listener(getWebReceiversUIState());
  } catch (error) {
    console.warn('[web-receivers] listener failed', error);
  }
  return () => _listeners.delete(listener);
}

function visibleReceivers() {
  return _receivers.filter((receiver) => receiverMatchesFilter(receiver, _filter));
}

/** Snapshot consumed by the panel and the voice tools. */
export function getWebReceiversUIState() {
  const selected = _selectedId ? _byId.get(_selectedId) || null : null;
  const visible = visibleReceivers();
  return {
    enabled: _enabled,
    loading: _loading,
    error: _error,
    stale: _stale,
    degraded: _degraded,
    updatedAt: _updatedAt,
    sources: _sources,
    receiverCount: _receivers.length,
    filteredCount: visible.length,
    filter: { ..._filter },
    filters: {
      types: [{ id: 'all', label: 'All receivers' }, ...RECEIVER_TYPES.map((type) => ({ id: type, label: RECEIVER_TYPE_LABELS[type] }))],
      bands: BAND_FILTERS.map((entry) => ({ id: entry.id, label: entry.label })),
    },
    selected,
    selectedBands: selected ? describeReceiverBands(selected) : '',
    highlightedIds: [..._highlightIds],
    lastTune: _lastTune,
    lastSearch: _lastSearch,
  };
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

function markerPosition(receiver) {
  return Cesium.Cartesian3.fromDegrees(receiver.lon, receiver.lat, 30);
}

function markerColor(receiver) {
  const base = Cesium.Color.fromCssColorString(RECEIVER_TYPE_COLORS[receiver.type] || '#ffffff');
  if (receiver.online === false) return base.withAlpha(0.3);
  if (_highlightIds.size && !_highlightIds.has(receiver.id)) return base.withAlpha(0.5);
  return base.withAlpha(0.9);
}

function markerSize(receiver) {
  const highlighted = _highlightIds.has(receiver.id);
  return highlighted ? 16 : 11;
}

function restyleMarkers() {
  for (const { receiver, entity } of _renderById.values()) {
    entity.point.color = markerColor(receiver);
    entity.point.pixelSize = markerSize(receiver);
    entity.show = receiverMatchesFilter(receiver, _filter);
  }
  updateSelectionEntity();
}

function reconcile(receivers) {
  _receivers = Object.freeze([...receivers]);
  _byId = new Map(receivers.map((receiver) => [receiver.id, receiver]));
  if (_selectedId && !_byId.has(_selectedId)) _selectedId = null;
  _highlightIds = new Set([..._highlightIds].filter((id) => _byId.has(id)));
  if (_dataSource) _dataSource.entities.removeAll();
  _renderById.clear();
  if (!_dataSource) return;
  for (const receiver of receivers) {
    const position = markerPosition(receiver);
    const entity = _dataSource.entities.add({
      id: `${PREFIX}${receiver.id}`,
      position,
      show: receiverMatchesFilter(receiver, _filter),
      point: {
        pixelSize: markerSize(receiver),
        color: markerColor(receiver),
        outlineColor: Cesium.Color.fromCssColorString('#06131a'),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(100_000, 1.2, 12_000_000, 1),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M),
      },
    });
    _renderById.set(receiver.id, { receiver, entity, position });
  }
  updateSelectionEntity();
}

function updateSelectionEntity() {
  if (!_viewer) return;
  const receiver = _selectedId ? _byId.get(_selectedId) : null;
  if (!receiver) {
    if (_selectedEntity) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    return;
  }
  const position = markerPosition(receiver);
  const text = `${receiver.name}\n${receiver.typeLabel} · ${describeReceiverBands(receiver)}`;
  if (!_selectedEntity) {
    _selectedEntity = _viewer.entities.add({
      id: `${PREFIX}selected`,
      position,
      point: {
        pixelSize: 22,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: Cesium.Color.fromCssColorString('#ffffff'),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text,
        font: '12px "JetBrains Mono", monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -22),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#06131a').withAlpha(0.75),
      },
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
  clustering.pixelRange = 38;
  clustering.minimumClusterSize = 3;
  clustering.clusterPoints = true;
  clustering.clusterLabels = false;
  clustering.clusterBillboards = false;
  _removeClusterListener = clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
    const types = new Map();
    for (const entity of clusteredEntities) {
      const receiver = _renderById.get(String(entity.id || '').slice(PREFIX.length))?.receiver;
      if (receiver) types.set(receiver.type, (types.get(receiver.type) || 0) + 1);
    }
    const dominant = [...types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'kiwisdr';
    cluster.point.id = clusteredEntities;
    cluster.billboard.id = clusteredEntities;
    cluster.label.show = false;
    cluster.label.text = '';
    cluster.point.show = true;
    cluster.point.pixelSize = Math.min(26, 12 + Math.log2(clusteredEntities.length) * 1.6);
    cluster.point.color = Cesium.Color.fromCssColorString(RECEIVER_TYPE_COLORS[dominant]).withAlpha(0.85);
    cluster.point.outlineColor = Cesium.Color.BLACK;
    cluster.point.outlineWidth = 2;
    cluster.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    cluster.point.distanceDisplayCondition = new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M);
  });
}

function receiverIdFromPick(picked) {
  const id = resolvePickId(picked);
  if (Array.isArray(id)) {
    const first = id.find((entity) => String(entity?.id || '').startsWith(PREFIX));
    return first ? String(first.id).slice(PREFIX.length) : null;
  }
  const text = String(id || '');
  if (!text.startsWith(PREFIX) || text === `${PREFIX}selected`) return null;
  return text.slice(PREFIX.length);
}

function pickedReceiverAt(position) {
  const scene = _viewer?.scene;
  if (!scene || !position) return null;
  const picked = scene.pick(position);
  if (isOwnedByOtherLayer(WEB_RECEIVERS_LAYER_ID, resolvePickId(picked))) return null;
  const id = receiverIdFromPick(picked);
  return id && _byId.has(id) ? id : null;
}

function installInteraction() {
  if (!_viewer || _clickHandler) return;
  registerPickOwner(WEB_RECEIVERS_LAYER_ID, (id) => typeof id === 'string' && id.startsWith(PREFIX));
  _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!presentationAllowed()) return;
    const id = pickedReceiverAt(click.position);
    if (!id) return;
    selectWebReceiver(id, { origin: 'user' });
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('gev:web-receiver-selected', { detail: { receiverId: id } }));
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function removeInteraction() {
  unregisterPickOwner(WEB_RECEIVERS_LAYER_ID);
  _clickHandler?.destroy();
  _clickHandler = null;
}

/** Select a receiver by id; optionally fly the camera to it. */
export function selectWebReceiver(id, { flyTo = false, origin = 'programmatic' } = {}) {
  const receiver = id ? _byId.get(String(id).toLowerCase()) : null;
  if (!receiver) {
    _selectedId = null;
    updateSelectionEntity();
    emitState();
    return null;
  }
  _selectedId = receiver.id;
  updateSelectionEntity();
  if (flyTo && _viewer) flyToWebReceiver(receiver);
  emitState();
  return receiver;
}

/** Fly to one receiver at a regional altitude. */
export function flyToWebReceiver(receiver, { altitudeM = 180_000 } = {}) {
  if (!_viewer || !receiver) return false;
  _viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(receiver.lon, receiver.lat, altitudeM),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
    duration: 2.2,
  });
  return true;
}

/** Frame several receivers at once (used after a voice search). */
export function frameWebReceivers(ids, { padding = 1.6 } = {}) {
  if (!_viewer) return false;
  const points = ids.map((id) => _byId.get(id)).filter(Boolean).map((receiver) => markerPosition(receiver));
  if (!points.length) return false;
  const sphere = Cesium.BoundingSphere.fromPoints(points);
  sphere.radius = Math.max(sphere.radius * padding, 60_000);
  _viewer.camera.flyToBoundingSphere(sphere, {
    duration: 2.4,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-60), sphere.radius * 2.6),
  });
  return true;
}

/** Highlight a set of receivers (search results) on the globe. */
export function highlightWebReceivers(ids) {
  _highlightIds = new Set((ids || []).map((id) => String(id).toLowerCase()).filter((id) => _byId.has(id)).slice(0, HIGHLIGHT_LIMIT));
  restyleMarkers();
  emitState();
}

/** Change the panel filter. */
export function setWebReceiversFilter(next = {}) {
  const type = RECEIVER_TYPES.includes(next.type) ? next.type : (next.type === 'all' ? 'all' : _filter.type);
  const band = BAND_FILTERS.some((entry) => entry.id === next.band) ? next.band : _filter.band;
  _filter = { type, band };
  restyleMarkers();
  emitState();
}

/**
 * Find receivers for a request. Returns ranked rows with distance and
 * coverage; also highlights them on the globe.
 */
export function findWebReceivers(request = {}) {
  const rows = rankWebReceivers(_receivers, request);
  _lastSearch = Object.freeze({
    at: new Date().toISOString(),
    lat: finiteNumber(request.lat),
    lon: finiteNumber(request.lon),
    hz: finiteNumber(request.hz),
    rangeHz: Array.isArray(request.rangeHz) ? [Number(request.rangeHz[0]), Number(request.rangeHz[1])] : null,
    label: cleanText(request.label, 120),
    resultIds: rows.map((row) => row.receiver.id),
  });
  highlightWebReceivers(rows.map((row) => row.receiver.id));
  return rows;
}

/** Look up one receiver by id, or by a name/site/host substring. */
export function resolveWebReceiver(query) {
  const text = cleanText(query, 160).toLowerCase();
  if (!text) return null;
  if (_byId.has(text)) return _byId.get(text);
  const words = text.split(/\s+/).filter(Boolean);
  const scored = _receivers.map((receiver) => {
    const haystack = `${receiver.name} ${receiver.site} ${receiver.url}`.toLowerCase();
    const hits = words.filter((word) => haystack.includes(word)).length;
    return { receiver, hits };
  }).filter((entry) => entry.hits === words.length);
  scored.sort((a, b) => (a.receiver.online === false) - (b.receiver.online === false) || a.receiver.name.length - b.receiver.name.length);
  return scored[0]?.receiver || null;
}

/**
 * Tune a receiver: records the request, selects the receiver and returns the
 * URL the UI (or a new tab) should load. Never contacts the receiver itself.
 */
export function tuneWebReceiver({ receiverId, hz, mode = null } = {}) {
  const receiver = receiverId ? _byId.get(String(receiverId).toLowerCase()) : null;
  const frequency = finiteNumber(hz);
  if (!receiver) return { ok: false, error: 'Receiver not found' };
  if (frequency === null || frequency <= 0) return { ok: false, error: 'Frequency is required' };
  const canonical = normalizeReceiverMode(mode) || defaultModeForHz(frequency);
  const url = buildTuneUrl(receiver, { hz: frequency, mode: canonical });
  if (!url) return { ok: false, error: 'This receiver cannot be tuned by URL' };
  const covers = receiverCoversHz(receiver, frequency);
  _lastTune = Object.freeze({
    kind: 'tune',
    receiverId: receiver.id,
    receiverName: receiver.name,
    type: receiver.type,
    hz: frequency,
    mode: canonical,
    url,
    covers,
    at: new Date().toISOString(),
    frequencyLabel: formatFrequencyHz(frequency),
  });
  _selectedId = receiver.id;
  updateSelectionEntity();
  emitState();
  return { ok: true, receiver, url, hz: frequency, mode: canonical, covers, frequencyLabel: _lastTune.frequencyLabel };
}

/**
 * Spectrum-only view of a range on a receiver: records it like a tune
 * (kind 'spectrum'), selects the receiver and returns the URL for the dock.
 * `muted` is only true for KiwiSDR pages; the note explains the rest.
 */
export function showWebReceiverSpectrum({ receiverId, lowHz, highHz } = {}) {
  const receiver = receiverId ? _byId.get(String(receiverId).toLowerCase()) : null;
  const low = finiteNumber(lowHz);
  const high = finiteNumber(highHz);
  if (!receiver) return { ok: false, error: 'Receiver not found' };
  if (low === null || high === null || high <= low) return { ok: false, error: 'A frequency range (low < high) is required' };
  const view = buildSpectrumUrl(receiver, { lowHz: low, highHz: high });
  if (!view) return { ok: false, error: 'This receiver cannot show a spectrum from a URL' };
  const covers = receiverCoversRangeHz(receiver, low, high);
  _lastTune = Object.freeze({
    kind: 'spectrum',
    receiverId: receiver.id,
    receiverName: receiver.name,
    type: receiver.type,
    hz: view.centerHz,
    lowHz: low,
    highHz: high,
    mode: 'spectrum',
    url: view.url,
    muted: view.muted,
    zoom: view.zoom,
    covers,
    note: view.note,
    at: new Date().toISOString(),
    frequencyLabel: view.rangeLabel,
  });
  _selectedId = receiver.id;
  updateSelectionEntity();
  emitState();
  return {
    ok: true,
    receiver,
    url: view.url,
    lowHz: low,
    highHz: high,
    rangeLabel: view.rangeLabel,
    muted: view.muted,
    zoom: view.zoom,
    shownSpanHz: view.shownSpanHz,
    covers,
    note: view.note,
  };
}

async function fetchCatalog(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(CATALOG_ENDPOINT, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.error || `Web receiver directory returned ${response.status}`);
      error.degraded = Boolean(body?.degraded);
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function loadCatalog() {
  if (_loadPromise) return _loadPromise;
  const generation = ++_requestGeneration;
  _abort?.abort();
  _abort = new AbortController();
  _loading = true;
  _error = null;
  emitState();
  _loadPromise = (async () => {
    try {
      const body = await fetchCatalog(_abort.signal);
      if (generation !== _requestGeneration) return;
      const rows = Array.isArray(body?.receivers) ? body.receivers : [];
      const receivers = rows.filter(isValidWebReceiver).map(freezeWebReceiver);
      reconcile(receivers);
      _updatedAt = typeof body?.updatedAt === 'string' ? body.updatedAt : new Date().toISOString();
      _stale = Boolean(body?.stale);
      _degraded = Boolean(body?.degraded);
      _sources = body?.sources && typeof body.sources === 'object' ? body.sources : null;
      _error = receivers.length ? null : 'Directory returned no receivers';
    } catch (error) {
      if (generation !== _requestGeneration) return;
      if (error?.name === 'AbortError') return;
      _error = error?.message || 'Web receiver directory unavailable';
      _degraded = _receivers.length > 0;
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

/** Resolve once the directory has loaded (used by voice tools). */
async function ensureLoaded() {
  if (_receivers.length) return _receivers;
  await loadCatalog();
  return _receivers;
}

/** Web Receivers layer lifecycle implementation. */
export const webReceiversLayer = {
  id: WEB_RECEIVERS_LAYER_ID,
  name: 'Web Receivers',
  icon: '⌁',
  source: 'Receiverbook / KiwiSDR',
  updateInterval: 30 * 60 * 1000,

  init(viewer) {
    _viewer = viewer;
    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('Web receivers');
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
    await loadCatalog();
  },

  destroy() {
    this.disable();
    _removeClusterListener?.();
    _removeClusterListener = null;
    if (_dataSource && _viewer) _viewer.dataSources.remove(_dataSource, true);
    _dataSource = null;
    _receivers = Object.freeze([]);
    _byId = new Map();
    _renderById.clear();
    _selectedId = null;
    _highlightIds = new Set();
    _filter = { type: 'all', band: 'all' };
    _lastTune = null;
    _lastSearch = null;
    _error = null;
    _stale = false;
    _degraded = false;
    _updatedAt = null;
    _sources = null;
    _managerPresentation = null;
    _viewer = null;
    emitState();
    _listeners.clear();
  },

  getStats() {
    return {
      count: _receivers.length,
      filtered: visibleReceivers().length,
      selected: _selectedId,
      stale: _stale,
      degraded: _degraded,
      loading: _loading,
      error: _error,
      lastUpdate: _updatedAt ? Date.parse(_updatedAt) : null,
    };
  },

  subscribe,
  getUIState: getWebReceiversUIState,
  getReceivers: () => _receivers,
  getReceiver: (id) => (id ? _byId.get(String(id).toLowerCase()) || null : null),
  ensureLoaded,
  setFilter: setWebReceiversFilter,
  selectReceiver: selectWebReceiver,
  resolveReceiver: resolveWebReceiver,
  find: findWebReceivers,
  highlight: highlightWebReceivers,
  frame: frameWebReceivers,
  flyTo: flyToWebReceiver,
  tune: tuneWebReceiver,
  showSpectrum: showWebReceiverSpectrum,
};

export default webReceiversLayer;
