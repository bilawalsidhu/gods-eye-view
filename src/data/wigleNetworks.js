import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';
import { registerDynamicCredit, WIGLE_CREDIT } from './dataCredits.js';
import { WIGLE_MAX_VIEWPORT_DEGREES, wigleRetryDelayMs, wigleNetworkFreshness } from './wigleApi.js';

/**
 * @file WiGLE Wi-Fi network layer — crowdsourced observations, not live RF
 * detections. Optional and BYOK: the server-side `/api/wigle` proxy
 * (vite.config.js) reports UNAVAILABLE without WIGLE_API_NAME/WIGLE_API_TOKEN
 * configured; this layer never simulates data. See issue #4.
 *
 * Same viewport-bounded, moveEnd-debounced, backoff-retry shape as
 * militaryInstallations.js/alprCameras.js, tightened to WiGLE's own small,
 * account-dependent daily query allowance.
 * @module data/wigleNetworks
 */

const LAYER_ID = 'wigle-networks';
const API_URL = '/api/wigle/search';
const REQUEST_DEBOUNCE_MS = 600;
const MAX_RENDERED = 500;
const FRESHNESS_COLOR = {
  recent: '#ffb545',
  aged: '#c9862f',
  old: '#7a6248',
  unknown: '#8a8a8a',
};

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  records: [],
  recordById: new Map(),
  selectedId: null,
  lastUpdate: null,
  error: null,
  status: 'idle',
  loading: false,
  hasKey: null,
  abort: null,
  retryTimer: null,
  retryDelayMs: 0,
  moveEndRemove: null,
  clickHandler: null,
};

function colorFor(record) {
  return Cesium.Color.fromCssColorString(FRESHNESS_COLOR[wigleNetworkFreshness(record.lastSeen)]);
}

function viewportBox(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (!rectangle) return null;
  const south = Cesium.Math.toDegrees(rectangle.south);
  const north = Cesium.Math.toDegrees(rectangle.north);
  const west = Cesium.Math.toDegrees(rectangle.west);
  const east = Cesium.Math.toDegrees(rectangle.east);
  if (!Number.isFinite(south + north + west + east) || east <= west
    || north - south > WIGLE_MAX_VIEWPORT_DEGREES || east - west > WIGLE_MAX_VIEWPORT_DEGREES) return null;
  return { south, west, north, east };
}

function clearRendered() {
  if (state.dataSource?.entities) state.dataSource.entities.removeAll();
  removeEntityContextsForLayer(LAYER_ID);
}

function renderRecords() {
  governorRequestRender('wigle-render');
  clearRendered();
  for (const record of state.records.slice(0, MAX_RENDERED)) {
    const color = colorFor(record);
    const selected = record.id === state.selectedId;
    const position = Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude);
    const entity = state.dataSource.entities.add({
      id: record.id,
      position,
      point: {
        pixelSize: selected ? 11 : 6,
        color: selected ? Cesium.Color.WHITE : color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevDisplayPosition = () => position;
    entity.gevLabelModel = {
      title: record.ssid || '(hidden SSID)',
      details: [record.encryption?.toUpperCase(), record.netid].filter(Boolean),
      accent: color.toCssColorString(),
    };
    registerEntityContext(entity, {
      id: record.id,
      layerId: LAYER_ID,
      layerName: 'WiGLE Wi-Fi Networks',
      source: 'WiGLE (crowdsourced observation)',
      label: record.ssid || '(hidden SSID)',
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        ssid: record.ssid,
        bssid: record.netid,
        encryption: record.encryption,
        type: record.type,
        channel: record.channel,
        qos: record.qos,
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
        freshness: wigleNetworkFreshness(record.lastSeen),
      },
    });
  }
  const selectedEntity = state.selectedId ? state.dataSource.entities.getById(state.selectedId) : null;
  if (selectedEntity) selectEntityContext(selectedEntity);
  else state.selectedId = null;
}

function selectRecord(id) {
  if (!state.recordById.has(id) || !state.dataSource) return false;
  state.selectedId = id;
  renderRecords();
  return state.selectedId === id;
}

function installInteraction(viewer) {
  if (state.clickHandler) return;
  state.clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  state.clickHandler.setInputAction((click) => {
    if (!state.enabled) return;
    const picked = viewer.scene.pick(click.position);
    const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
    if (id && state.recordById.has(id)) selectRecord(id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function scheduleUnavailableRetry() {
  if (!state.enabled) return;
  clearTimeout(state.retryTimer);
  state.retryDelayMs = wigleRetryDelayMs(state.retryDelayMs);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    if (state.enabled && !state.loading) loadNetworks();
  }, state.retryDelayMs);
}

function clearUnavailableRetry({ resetBackoff = true } = {}) {
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  if (resetBackoff) state.retryDelayMs = 0;
}

function scheduleLoad() {
  if (!state.enabled) return;
  clearUnavailableRetry({ resetBackoff: false });
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => { loadNetworks(); }, REQUEST_DEBOUNCE_MS);
}

async function loadNetworks() {
  if (!state.enabled || !state.viewer) return;
  const box = viewportBox(state.viewer);
  if (!box) {
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    clearUnavailableRetry();
    state.status = 'zoom-in';
    state.error = 'Zoom in to load WiGLE observations';
    return;
  }
  state.abort?.abort();
  const requestAbort = new AbortController();
  state.abort = requestAbort;
  state.loading = true;
  try {
    const query = new URLSearchParams(Object.entries(box).map(([k, v]) => [k, v.toFixed(5)]));
    const response = await fetch(`${API_URL}?${query}`, { signal: requestAbort.signal });
    const payload = await response.json();
    // Checked immediately after both awaits, before any state write: a
    // superseded request whose body had already fully arrived before
    // abort() took effect resolves without ever throwing AbortError, and
    // must not clobber the newer request's already-rendered result.
    if (requestAbort.signal.aborted || state.abort !== requestAbort || !state.enabled) return;
    state.hasKey = payload?.available !== false;
    if (!state.hasKey) {
      state.status = 'unavailable';
      state.error = payload?.error || 'WIGLE_API_NAME/WIGLE_API_TOKEN not configured';
      state.records = [];
      state.recordById = new Map();
      renderRecords();
      return;
    }
    if (!response.ok) {
      const err = new Error(payload?.error || `WiGLE feed HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    const records = Array.isArray(payload?.networks) ? payload.networks : [];
    state.records = records;
    state.recordById = new Map(records.map((r) => [r.id, r]));
    state.lastUpdate = Date.now();
    state.status = records.length ? 'ready' : 'empty';
    state.error = null;
    clearUnavailableRetry();
    renderRecords();
    // Only once a keyed search actually returns data — matches the
    // documented DATA_SOURCES.md contract; an empty viewport must not
    // register the credit for data that was never shown.
    if (records.length) registerDynamicCredit(state.viewer, WIGLE_CREDIT);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    state.status = 'unavailable';
    if (error?.status === 429) {
      // The daily query budget is exhausted server-side and only rolls
      // over at the next US/Pacific midnight — an escalating retry timer
      // can't succeed before then, so skip it and just say why; the next
      // user-driven pan/zoom (moveEnd) will naturally try again.
      state.error = error?.message || 'WiGLE daily query budget exhausted';
      clearUnavailableRetry();
    } else {
      state.error = error?.message || 'WiGLE feed unavailable';
      scheduleUnavailableRetry();
    }
  } finally {
    if (state.abort === requestAbort) {
      state.abort = null;
      state.loading = false;
    }
  }
}

const wigleNetworksLayer = {
  id: LAYER_ID,
  name: 'WiGLE Wi-Fi',
  icon: '📶',
  source: 'WiGLE (BYOK)',
  updateInterval: 0,
  statsRefreshInterval: 1000,
  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource('wigle-networks');
    viewer.dataSources.add(state.dataSource);
    state.moveEndRemove = viewer.camera.moveEnd.addEventListener(scheduleLoad);
    installInteraction(viewer);
  },
  enable() {
    state.enabled = true;
    registerPickOwner(LAYER_ID, (id) => state.recordById.has(id));
    if (state.dataSource) state.dataSource.show = true;
  },
  disable() {
    state.enabled = false;
    unregisterPickOwner(LAYER_ID);
    clearUnavailableRetry();
    clearTimeout(state.debounceTimer);
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    if (state.dataSource) state.dataSource.show = false;
    clearSelectedEntityContextForLayer(LAYER_ID);
    state.selectedId = null;
  },
  update() { return loadNetworks(); },
  destroy(viewer) {
    this.disable();
    state.moveEndRemove?.();
    state.moveEndRemove = null;
    state.clickHandler?.destroy();
    state.clickHandler = null;
    clearRendered();
    if (state.dataSource && viewer) viewer.dataSources.remove(state.dataSource, true);
    state.dataSource = null;
    state.records = [];
    state.recordById = new Map();
    state.lastUpdate = null;
    state.error = null;
    state.status = 'idle';
  },
  getStats() {
    return {
      count: state.records.length,
      lastUpdate: state.lastUpdate,
      error: state.error,
      status: state.status,
      loading: state.loading,
      loadingLabel: state.loading ? 'loading WiGLE observations' : '',
    };
  },
};

export default wigleNetworksLayer;
