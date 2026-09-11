import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';
import { AFFILIATION_COLOR, AFFILIATION_DEFAULT_COLOR } from './cotEvent.js';

/**
 * @file TAK / Cursor-on-Target data layer — Phase 1 of issue #7 (read-only
 * ingest; publishing selected God's Eye View objects into TAK is a later
 * Phase 2, not implemented here).
 *
 * BYOS: the server-side `takProxy` in vite.config.js only connects when a
 * TAK Server host + client certificate/key are explicitly configured
 * (TAK_SERVER_HOST, TAK_CLIENT_CERT_PATH, TAK_CLIENT_KEY_PATH); this layer
 * shows UNAVAILABLE otherwise and no connection is ever attempted. Not
 * viewport-bounded — a TAK Server's own membership already scopes what it
 * sends, and the server-side cache is capped independently.
 *
 * Points only: routes/polygons/shapes carried in some CoT events are out of
 * scope for this pass (see cotDecode.js — an event without a usable point is
 * dropped before it ever reaches this layer).
 * @module data/takEvents
 */

const LAYER_ID = 'tak-events';
const API_URL = '/api/tak/events';
const POLL_INTERVAL_MS = 15000;
const MAX_RENDERED = 1000;

function colorFor(record) {
  return Cesium.Color.fromCssColorString(AFFILIATION_COLOR[record.affiliation] || AFFILIATION_DEFAULT_COLOR);
}

const state = {
  dataSource: null,
  enabled: false,
  records: [],
  recordById: new Map(),
  selectedId: null,
  lastUpdate: null,
  connected: false,
  configured: null,
  error: null,
  clickHandler: null,
};

function clearRendered() {
  if (state.dataSource?.entities) state.dataSource.entities.removeAll();
  removeEntityContextsForLayer(LAYER_ID);
}

function renderRecords() {
  governorRequestRender('tak-render');
  clearRendered();
  for (const record of state.records.slice(0, MAX_RENDERED)) {
    const color = colorFor(record);
    const selected = record.uid === state.selectedId;
    const position = record.hae != null
      ? Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude, record.hae)
      : Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude);
    const entity = state.dataSource.entities.add({
      id: record.uid,
      position,
      point: {
        pixelSize: selected ? 13 : 9,
        color: selected ? Cesium.Color.WHITE : color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1,
        heightReference: record.hae != null ? undefined : Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevDisplayPosition = () => position;
    entity.gevLabelModel = {
      title: record.callsign || record.uid,
      details: [record.affiliation, record.groupName].filter(Boolean),
      accent: color.toCssColorString(),
    };
    registerEntityContext(entity, {
      id: record.uid,
      layerId: LAYER_ID,
      layerName: 'TAK / Cursor-on-Target',
      source: 'TAK Server (your own, BYOS)',
      label: record.callsign || record.uid,
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        uid: record.uid,
        type: record.type,
        affiliation: record.affiliation,
        callsign: record.callsign,
        group: record.groupName,
        role: record.groupRole,
        how: record.how,
        altitudeM: record.hae,
        course: record.course,
        speed: record.speed,
        battery: record.battery,
        device: record.device,
        platform: record.platform,
        version: record.version,
        time: record.time,
        stale: record.stale,
        detail: record.detail,
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

async function loadEvents() {
  // A `false` return is a manager.js contract: DURING the enable transition
  // it's treated as a fatal enable failure that bounces the toggle back
  // off — wrong for "not configured", which is the common case for this
  // BYOS layer and must stay enabled and read UNAVAILABLE via getStats().
  // Only ever resolve true (success) or undefined; never false.
  if (!state.enabled) return;
  try {
    const response = await fetch(API_URL);
    const payload = await response.json();
    if (!state.enabled || !state.dataSource) return; // torn down while in flight
    state.configured = payload?.available !== false;
    if (!state.configured) {
      state.error = payload?.error || 'TAK Server not configured';
      state.records = [];
      state.recordById = new Map();
      state.connected = false;
      renderRecords();
      return;
    }
    // The endpoint is deliberately non-2xx (503) for the "not configured"
    // case above, handled via `available` — this catches any OTHER
    // non-2xx response (e.g. a fronting proxy/rate-limiter in a non-dev
    // deployment) instead of silently trusting its body as a healthy feed.
    if (!response.ok) throw new Error(payload?.error || `TAK feed HTTP ${response.status}`);
    const records = Array.isArray(payload?.events) ? payload.events : [];
    state.records = records;
    state.recordById = new Map(records.map((r) => [r.uid, r]));
    state.connected = Boolean(payload?.connected);
    state.error = payload?.error || null;
    state.lastUpdate = Date.now();
    renderRecords();
    return true;
  } catch (e) {
    state.error = 'TAK feed network error';
  }
}

const takEventsLayer = {
  id: LAYER_ID,
  name: 'TAK (Cursor-on-Target)',
  icon: '⛛',
  source: 'TAK Server (BYOS)',
  updateInterval: POLL_INTERVAL_MS,
  init(viewer) {
    state.dataSource = new Cesium.CustomDataSource('tak-events');
    state.dataSource.show = false;
    viewer.dataSources.add(state.dataSource);
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
    if (state.dataSource) state.dataSource.show = false;
    clearSelectedEntityContextForLayer(LAYER_ID);
    state.selectedId = null;
  },
  update() { return loadEvents(); },
  destroy(viewer) {
    this.disable();
    state.clickHandler?.destroy();
    state.clickHandler = null;
    clearRendered();
    if (state.dataSource && viewer) viewer.dataSources.remove(state.dataSource, true);
    state.dataSource = null;
    state.records = [];
    state.recordById = new Map();
    state.lastUpdate = null;
    state.error = null;
  },
  getStats() {
    const hasEvents = state.records.length > 0;
    let status = 'idle';
    if (state.configured === false) status = 'unavailable';
    else if (!state.connected && !hasEvents) status = 'unavailable';
    return {
      count: state.records.length,
      lastUpdate: state.lastUpdate,
      error: state.error,
      status,
      stale: state.configured !== false && !state.connected && hasEvents,
    };
  },
};

export default takEventsLayer;
