import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';
import { meshtasticNodeFreshness, positionUncertaintyRadiusM } from './meshtasticMapReport.js';

/**
 * @file Public Meshtastic node layer.
 *
 * Nodes that opt in to Meshtastic's own "Map Reporting" feature publish
 * short/long name, hardware, firmware, LoRa config, and an approximate
 * position to mqtt.meshtastic.org's public MapReport stream. The server-side
 * `meshtasticProxy` in vite.config.js holds the one persistent MQTT
 * connection and decodes only that unencrypted stream (portnum 73); this
 * layer just polls the resulting JSON snapshot, same shape as any other
 * God's Eye View data layer. See issue #6.
 *
 * A reported location can be an intentionally coarse approximation — nodes
 * publish `position_precision` (bits retained), and a low value means "this
 * many km, not this exact spot". Rather than plot an artificially precise
 * pin, a node with meaningful uncertainty renders as a translucent circle at
 * `positionUncertaintyRadiusM()`; only a high-precision report gets a plain
 * point.
 *
 * @module data/meshtasticNodes
 */

const LAYER_ID = 'meshtastic-nodes';
const API_URL = '/api/meshtastic/nodes';
const POLL_INTERVAL_MS = 30000;
/** Global feed, not viewport-bounded — the server cache is already bounded. */
const MAX_RENDERED = 2000;
const NODE_COLOR = '#5fd97a';
/** Below this, the uncertainty circle would be imperceptible/misleading at globe scale — just draw a point. */
const UNCERTAINTY_RADIUS_MIN_M = 150;

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  records: [],
  recordById: new Map(),
  selectedId: null,
  lastUpdate: null,
  connected: false,
  error: null,
  clickHandler: null,
};

/** 0 for an expired node (server should already have evicted it, but never render one anyway). */
function freshnessAlpha(record) {
  const bucket = meshtasticNodeFreshness(record.lastSeen);
  if (bucket === 'live') return 0.85;
  if (bucket === 'stale') return 0.35;
  return 0;
}

function clearRendered() {
  if (state.dataSource?.entities) state.dataSource.entities.removeAll();
  removeEntityContextsForLayer(LAYER_ID);
}

function renderRecords() {
  governorRequestRender('meshtastic-render');
  clearRendered();
  for (const record of state.records.slice(0, MAX_RENDERED)) {
    const alpha = freshnessAlpha(record);
    if (alpha <= 0) continue;
    const selected = record.id === state.selectedId;
    const baseColor = Cesium.Color.fromCssColorString(NODE_COLOR);
    const radiusM = positionUncertaintyRadiusM(record.positionPrecisionBits);
    const position = Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude);

    const entityDef = {
      id: record.id,
      position,
      point: {
        pixelSize: selected ? 12 : 7,
        color: selected ? Cesium.Color.WHITE : baseColor.withAlpha(alpha),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    };
    if (radiusM >= UNCERTAINTY_RADIUS_MIN_M) {
      entityDef.ellipse = {
        semiMajorAxis: radiusM,
        semiMinorAxis: radiusM,
        material: new Cesium.ColorMaterialProperty(baseColor.withAlpha(alpha * 0.2)),
        outline: true,
        outlineColor: baseColor.withAlpha(alpha),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      };
    }

    const entity = state.dataSource.entities.add(entityDef);
    entity.gevDisplayPosition = () => position;
    entity.gevLabelModel = {
      title: record.longName || record.shortName || record.id,
      details: [record.role, record.hwModel].filter(Boolean),
      accent: NODE_COLOR,
    };
    registerEntityContext(entity, {
      id: record.id,
      layerId: LAYER_ID,
      layerName: 'Meshtastic Nodes',
      source: 'Meshtastic public MQTT MapReport (mqtt.meshtastic.org)',
      label: record.longName || record.shortName || record.id,
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        nodeId: record.id,
        shortName: record.shortName,
        longName: record.longName,
        role: record.role,
        hardwareModel: record.hwModel,
        firmwareVersion: record.firmwareVersion,
        region: record.region,
        modemPreset: record.modemPreset,
        altitude: record.altitude,
        positionUncertaintyM: radiusM ? Math.round(radiusM) : null,
        numOnlineLocalNodes: record.numOnlineLocalNodes,
        lastSeen: record.lastSeen,
        freshness: meshtasticNodeFreshness(record.lastSeen),
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

async function loadNodes() {
  // A `false` return is a manager.js contract: DURING the enable transition
  // (not just on the periodic poll), it's treated as a fatal enable failure
  // that bounces the toggle back off — wrong for "server unreachable this
  // poll", which must stay enabled and read UNAVAILABLE via getStats(). Only
  // ever resolve true (success) or undefined (anything else); never false.
  if (!state.enabled) return;
  try {
    const response = await fetch(API_URL);
    if (!state.enabled || !state.dataSource) return; // torn down while in flight
    if (!response.ok) {
      state.error = `Meshtastic feed HTTP ${response.status}`;
      return;
    }
    const payload = await response.json();
    if (!state.enabled || !state.dataSource) return; // torn down while in flight
    const records = Array.isArray(payload?.nodes) ? payload.nodes : [];
    records.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    state.records = records;
    state.recordById = new Map(records.map((r) => [r.id, r]));
    state.connected = Boolean(payload?.connected);
    state.error = payload?.error || null;
    state.lastUpdate = Date.now();
    renderRecords();
    return true;
  } catch (e) {
    state.error = 'Meshtastic feed network error';
  }
}

const meshtasticNodesLayer = {
  id: LAYER_ID,
  name: 'Meshtastic Nodes',
  icon: '📡',
  source: 'Meshtastic public MQTT MapReport',
  updateInterval: POLL_INTERVAL_MS,
  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource('meshtastic-nodes');
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
  update() { return loadNodes(); },
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
    const hasNodes = state.records.length > 0;
    let status = 'idle';
    if (!state.connected && !hasNodes) status = 'unavailable';
    return {
      count: state.records.length,
      lastUpdate: state.lastUpdate,
      error: state.error,
      status,
      stale: !state.connected && hasNodes,
    };
  },
};

export default meshtasticNodesLayer;
