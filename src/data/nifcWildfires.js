import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';

/**
 * @file NIFC wildfire incidents — confirmed, human-reported fire incidents
 * (WFIGS, the National Interagency Fire Center's public incident-tracking
 * system), distinct from the existing FIRMS layer's raw VIIRS satellite
 * thermal-anomaly detections. Same relationship as ALPR sits next to CCTV:
 * a separate reporting system, not a duplicate of what's already here.
 *
 * Public, CORS-open, keyless ArcGIS Feature Service — fetched directly from
 * the browser like earthquakes.js fetches USGS, no server proxy needed.
 * Scoped to WF (wildfire) and CX (complex) incidents; RX (prescribed —
 * planned, controlled burns) are excluded at the query level as out of
 * scope for a "wildfire incidents" layer.
 * @module data/nifcWildfires
 */

const QUERY_URL = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/'
  + 'WFIGS_Incident_Locations_Current/FeatureServer/0/query';
const OUT_FIELDS = [
  'IncidentName', 'IrwinID', 'FireDiscoveryDateTime', 'PercentContained',
  'IncidentSize', 'FireCause', 'FireCauseGeneral', 'IncidentTypeCategory',
  'POOState', 'FireOutDateTime',
].join(',');

export const NIFC_OVERLAY_SOURCE_ID = 'nifc-wildfires';
const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Matches every sibling non-viewport-bounded layer (alprCameras.js, meshtasticNodes.js,
 * militaryInstallations.js, takEvents.js, wigleNetworks.js) capping rendered entities. */
const MAX_RENDERED = 500;
const CONTAINMENT_COLOR = {
  uncontained: '#ff4d4d',
  partial: '#ffa63f',
  contained: '#ffe066',
};

function buildQueryUrl() {
  const params = new URLSearchParams({
    where: "IncidentTypeCategory IN ('WF','CX')",
    outFields: OUT_FIELDS,
    f: 'geojson',
    resultRecordCount: '2000',
  });
  return `${QUERY_URL}?${params}`;
}

/**
 * @param {number|null|undefined} percentContained
 * @returns {'uncontained'|'partial'|'contained'} Unset/null reads as
 *   uncontained — the honest default for an incident with no reported progress.
 */
export function nifcContainmentBucket(percentContained) {
  if (!Number.isFinite(percentContained)) return 'uncontained';
  if (percentContained >= 75) return 'contained';
  if (percentContained >= 25) return 'partial';
  return 'uncontained';
}

/** Sqrt-scaled marker size (px) so a 10-acre spot fire and a 50,000-acre complex read differently. */
export function nifcMarkerSizePx(acres) {
  if (!Number.isFinite(acres) || acres <= 0) return 8;
  return Math.max(8, Math.min(28, 8 + Math.sqrt(acres) * 0.35));
}

/**
 * Map one raw WFIGS GeoJSON feature to a plain incident record.
 * @param {object} feature
 * @returns {object|null} Null for anything missing coordinates.
 */
export function normalizeNifcIncident(feature) {
  const props = feature?.properties || {};
  const coords = feature?.geometry?.coordinates;
  const lon = Number(coords?.[0]);
  const lat = Number(coords?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  const num = (v) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    id: text(props.IrwinID) || `nifc:${lat.toFixed(5)},${lon.toFixed(5)}`,
    name: text(props.IncidentName) || 'Unnamed incident',
    category: text(props.IncidentTypeCategory),
    cause: text(props.FireCauseGeneral) || text(props.FireCause),
    discoveredAt: num(props.FireDiscoveryDateTime),
    acres: num(props.IncidentSize),
    percentContained: num(props.PercentContained),
    state: text(props.POOState),
    outAt: num(props.FireOutDateTime),
    latitude: lat,
    longitude: lon,
  };
}

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  records: [],
  recordById: new Map(),
  selectedId: null,
  lastUpdate: null,
  error: null,
  clickHandler: null,
  abort: null,
};

/** Biggest/most-significant incidents first, so a MAX_RENDERED cap truncates
 * the smallest ones — mirrors earthquakes.js ranking by magnitude. Missing
 * acreage sorts last rather than first (an unknown size is not "small"). */
export function rankByAcresDesc(records) {
  return records.slice().sort((a, b) => {
    const aAcres = Number.isFinite(a.acres) ? a.acres : -1;
    const bAcres = Number.isFinite(b.acres) ? b.acres : -1;
    return bAcres - aAcres;
  });
}

function colorFor(record) {
  return Cesium.Color.fromCssColorString(CONTAINMENT_COLOR[nifcContainmentBucket(record.percentContained)]);
}

function clearRendered() {
  if (state.dataSource?.entities) state.dataSource.entities.removeAll();
  removeEntityContextsForLayer(NIFC_OVERLAY_SOURCE_ID);
}

function renderRecords() {
  governorRequestRender('nifc-render');
  clearRendered();
  for (const record of state.records.slice(0, MAX_RENDERED)) {
    const color = colorFor(record);
    const selected = record.id === state.selectedId;
    const position = Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude);
    const entity = state.dataSource.entities.add({
      id: record.id,
      position,
      point: {
        pixelSize: selected ? nifcMarkerSizePx(record.acres) + 4 : nifcMarkerSizePx(record.acres),
        color: selected ? Cesium.Color.WHITE : color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevDisplayPosition = () => position;
    entity.gevLabelModel = {
      title: record.name,
      details: [
        record.category === 'CX' ? 'COMPLEX' : 'WILDFIRE',
        Number.isFinite(record.acres) ? `${Math.round(record.acres).toLocaleString()} ac` : null,
      ].filter(Boolean),
      accent: color.toCssColorString(),
    };
    registerEntityContext(entity, {
      id: record.id,
      layerId: NIFC_OVERLAY_SOURCE_ID,
      layerName: 'Wildfire Incidents (NIFC)',
      source: 'NIFC WFIGS (public incident tracking)',
      label: record.name,
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        category: record.category,
        cause: record.cause,
        discoveredAt: record.discoveredAt,
        acres: record.acres,
        percentContained: record.percentContained,
        containment: nifcContainmentBucket(record.percentContained),
        state: record.state,
        outAt: record.outAt,
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

async function loadIncidents() {
  if (!state.enabled) return;
  state.abort?.abort();
  const requestAbort = new AbortController();
  state.abort = requestAbort;
  try {
    const response = await fetch(buildQueryUrl(), { signal: requestAbort.signal });
    // Checked immediately after each await, before any state write: a
    // superseded poll (e.g. disable+re-enable while an old request is still
    // in flight) must not overwrite a newer request's already-rendered result.
    if (requestAbort.signal.aborted || state.abort !== requestAbort || !state.enabled) return;
    if (!response.ok) {
      state.error = `NIFC feed HTTP ${response.status}`;
      return;
    }
    const geojson = await response.json();
    if (requestAbort.signal.aborted || state.abort !== requestAbort || !state.enabled) return;
    if (!geojson || !Array.isArray(geojson.features)) {
      state.error = 'Malformed NIFC response';
      return;
    }
    const records = rankByAcresDesc(geojson.features.map(normalizeNifcIncident).filter(Boolean));
    state.records = records;
    state.recordById = new Map(records.map((r) => [r.id, r]));
    state.lastUpdate = Date.now();
    // ArcGIS truncates a response at the layer's max record count (2000 here,
    // requested in full) rather than paginating automatically — say so
    // instead of quietly showing an incomplete incident list as if complete.
    // At today's ~600 current incidents there's ~3x headroom, but a severe
    // multi-region fire season could plausibly close that gap.
    state.error = geojson.properties?.exceededTransferLimit
      ? 'NIFC response truncated at the server’s record limit — showing a partial incident list'
      : null;
    renderRecords();
    return true;
  } catch (e) {
    if (e?.name === 'AbortError') return;
    state.error = 'NIFC feed network error';
  } finally {
    if (state.abort === requestAbort) state.abort = null;
  }
}

const nifcWildfiresLayer = {
  id: NIFC_OVERLAY_SOURCE_ID,
  name: 'Wildfire Incidents (NIFC)',
  icon: '🔥',
  source: 'NIFC WFIGS',
  updateInterval: POLL_INTERVAL_MS,
  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource(NIFC_OVERLAY_SOURCE_ID);
    state.dataSource.show = false;
    viewer.dataSources.add(state.dataSource);
    installInteraction(viewer);
  },
  enable() {
    state.enabled = true;
    registerPickOwner(NIFC_OVERLAY_SOURCE_ID, (id) => state.recordById.has(id));
    if (state.dataSource) state.dataSource.show = true;
  },
  disable() {
    state.enabled = false;
    unregisterPickOwner(NIFC_OVERLAY_SOURCE_ID);
    state.abort?.abort();
    state.abort = null;
    if (state.dataSource) state.dataSource.show = false;
    clearSelectedEntityContextForLayer(NIFC_OVERLAY_SOURCE_ID);
    state.selectedId = null;
  },
  update() { return loadIncidents(); },
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
    return {
      count: state.records.length,
      lastUpdate: state.lastUpdate,
      error: state.error,
    };
  },
};

export default nifcWildfiresLayer;
