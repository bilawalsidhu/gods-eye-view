/**
 * @module ondemand/cameraContext
 * @description Resolve the CCTV layer's active camera into the entity shape
 * `entityContext.normalizeEntity('camera', …)` understands, enriched with the
 * road/lane metadata and live traffic state the camera chat answers from
 * (docs/ONDEMAND_CAMERA_CHAT_ADDENDUM_2026-09-21.md §3):
 *
 *   - camera id, intersection name, street names, lat/lon, heading, FOV,
 *     provider and source health — from the layer's public camera state;
 *   - the current frame: the same-origin `/api/cctv/frame/<id>` URL the
 *     panel `<img>` shows plus its load time (the provider burns the capture
 *     time into the picture; the load time is the freshest timestamp we own);
 *   - OpenStreetMap ways within ~60 m through the EXISTING `/api/overpass`
 *     proxy (`out tags center`): name, highway class, lanes, lanes:forward /
 *     lanes:backward, oneway, maxspeed, turn:lanes;
 *   - the Street Traffic layer's live sample (`getStats().flowSegment`,
 *     mode, closedRoads, coverage) — the MOVEMENT/layer toggles themselves
 *     are already in `context.layers` (entityContext.describeLayers).
 *
 * Pure helpers (`parseOverpassRoads`, `buildLanesQuery`, `cameraEntityFrom`)
 * are exported for node:test; the network calls are tolerant — a failed
 * Overpass lookup leaves `roads: null` and the chat still opens.
 */
import {
  finiteOrNull,
  textOrNull,
  splitIntersection,
} from './entityContext.js';

export const CCTV_LAYER_ID = 'cctv';
export const LANES_RADIUS_M = 60;
export const LANES_TIMEOUT_SEC = 10;
/** Browser-side cap on the lanes lookup so the panel never waits on Overpass. */
export const LANES_FETCH_TIMEOUT_MS = 12000;
export const MAX_ROADS = 12;
const ROAD_CLASSES =
  '^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|service|living_street)$';
const LANE_TAGS = [
  'name',
  'highway',
  'lanes',
  'lanes:forward',
  'lanes:backward',
  'oneway',
  'maxspeed',
  'turn:lanes',
  'turn:lanes:forward',
  'turn:lanes:backward',
  'bus:lanes',
  'cycleway',
  'sidewalk',
  'crossing',
];

/** Overpass QL for the ways around a camera (same shape the traffic layer posts). */
export function buildLanesQuery(
  lat,
  lon,
  { radiusM = LANES_RADIUS_M, timeoutSec = LANES_TIMEOUT_SEC } = {},
) {
  const la = Number(lat).toFixed(6);
  const lo = Number(lon).toFixed(6);
  return `[out:json][timeout:${timeoutSec}];way["highway"~"${ROAD_CLASSES}"](around:${radiusM},${la},${lo});out tags center;`;
}

/** Overpass `elements[]` → compact road rows (tags we care about, ints parsed). */
export function parseOverpassRoads(body, { max = MAX_ROADS } = {}) {
  const elements = Array.isArray(body?.elements) ? body.elements : [];
  const rows = [];
  for (const element of elements) {
    if (element?.type !== 'way') continue;
    const tags =
      element.tags && typeof element.tags === 'object' ? element.tags : {};
    const row = { osmWayId: element.id ?? null };
    for (const tag of LANE_TAGS) {
      const value = textOrNull(tags[tag]);
      if (value === null) continue;
      const key = tag.replace(/:(\w)/g, (_, c) => c.toUpperCase());
      row[key] =
        tag === 'lanes' || tag === 'lanes:forward' || tag === 'lanes:backward'
          ? (finiteOrNull(Number(value)) ?? value)
          : value;
    }
    if (element.center) {
      row.centerLat = finiteOrNull(element.center.lat);
      row.centerLon = finiteOrNull(element.center.lon);
    }
    rows.push(row);
    if (rows.length >= max) break;
  }
  // Named roads first (the intersection legs), then the rest.
  rows.sort((a, b) => Number(Boolean(b.name)) - Number(Boolean(a.name)));
  return rows;
}

/** Summarise the lane rows for the status line / tests: "2 named ways · lanes tagged on 2". */
export function summarizeRoads(roads) {
  if (!Array.isArray(roads)) return 'roads: not loaded';
  const named = roads.filter((r) => r.name).length;
  const tagged = roads.filter((r) => r.lanes !== undefined).length;
  return `${roads.length} ways (${named} named) · lanes tagged on ${tagged}`;
}

/** The live Street Traffic sample, or null when the layer is absent. */
export function trafficSnapshot(dataManager) {
  const module = dataManager?.layers?.get?.('traffic')?.module;
  let enabled = false;
  try {
    enabled = Boolean(dataManager?.isEnabled?.('traffic'));
  } catch {
    enabled = false;
  }
  if (!module || typeof module.getStats !== 'function') return null;
  let stats;
  try {
    stats = module.getStats() || {};
  } catch {
    return null;
  }
  const segment =
    stats.flowSegment && typeof stats.flowSegment === 'object'
      ? stats.flowSegment
      : null;
  return {
    layerEnabled: enabled,
    mode: textOrNull(stats.mode),
    status: textOrNull(stats.status),
    source: textOrNull(stats.providerSource ?? stats.source),
    coverage: textOrNull(stats.coverage),
    flowCoveragePct: finiteOrNull(stats.flowCoveragePct),
    closedRoads: finiteOrNull(stats.closedRoads),
    renderedRoads: finiteOrNull(stats.count),
    flowSegment: segment
      ? {
          ok: segment.ok === true,
          currentSpeed: finiteOrNull(segment.currentSpeed),
          freeFlowSpeed: finiteOrNull(segment.freeFlowSpeed),
          confidence: finiteOrNull(segment.confidence),
          fetchedAt: textOrNull(segment.fetchedAt),
        }
      : null,
  };
}

/** The CCTV layer's public UI state (controls.getState), or null. */
export function cctvState(dataManager) {
  const module = dataManager?.layers?.get?.(CCTV_LAYER_ID)?.module;
  if (!module) return null;
  try {
    if (typeof module.getUIState === 'function') return module.getUIState();
    if (typeof module.getState === 'function') return module.getState();
  } catch {
    // fall through
  }
  return null;
}

/** Current frame from the panel `<img>` (same-origin proxy URL) — or null. */
export function frameFromDocument(document, cameraId) {
  const img = document?.getElementById?.('cctv-frame');
  if (!img) return null;
  const src = img.dataset?.currentSrc || img.getAttribute?.('src') || null;
  if (!src) return null;
  if (cameraId && img.dataset?.cameraId && img.dataset.cameraId !== cameraId)
    return null;
  const loadedAt = finiteOrNull(Number(img.dataset?.loadedAt));
  return {
    url: src,
    capturedAtUtc: loadedAt ? new Date(loadedAt).toISOString() : null,
    ageSec: loadedAt
      ? Math.max(0, Math.round((Date.now() - loadedAt) / 1000))
      : null,
    status: img.dataset?.error
      ? 'error'
      : img.dataset?.loading
        ? 'loading'
        : img.classList?.contains?.('active')
          ? 'shown'
          : 'unknown',
  };
}

/**
 * Build the entity object for one public camera record.
 * @param {object} camera  one entry of cctvState().cameras / activeCamera
 * @param {{ frame?: object|null, roads?: object[]|null, traffic?: object|null, now?: number }} [extra]
 */
export function cameraEntityFrom(
  camera,
  { frame = null, roads = null, traffic = null } = {},
) {
  if (!camera || typeof camera !== 'object') return null;
  const name = textOrNull(camera.name) || textOrNull(camera.id);
  return {
    layerId: CCTV_LAYER_ID,
    id: textOrNull(camera.id),
    cameraId: textOrNull(camera.id),
    name,
    label: name,
    intersection: name,
    streets: splitIntersection(name),
    city: camera.city ?? null,
    provider: camera.provider ?? null,
    feedType: camera.feedType ?? null,
    sourceStatus: camera.sourceStatus ?? null,
    sourceLabel: camera.sourceLabel ?? null,
    lat: finiteOrNull(camera.lat),
    lon: finiteOrNull(camera.lon),
    headingDeg: finiteOrNull(camera.headingDeg),
    pitchDeg: finiteOrNull(camera.pitchDeg),
    fovDeg: finiteOrNull(camera.fovDeg),
    rangeM: finiteOrNull(camera.rangeM),
    elevationM: finiteOrNull(camera.elevationM),
    mountHeightM: finiteOrNull(camera.mountHeightM),
    frame,
    roads,
    traffic,
  };
}

/**
 * Resolve the active camera (or `cameraId`) with lanes + traffic + frame.
 * @returns {Promise<{ entity: object, kind: 'camera', layerId: 'cctv' }|null>}
 */
export async function resolveCameraEntity({
  dataManager,
  document,
  cameraId = null,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  signal,
} = {}) {
  const state = cctvState(dataManager);
  if (!state) return null;
  const camera =
    (cameraId && (state.cameras || []).find((c) => c.id === cameraId)) ||
    state.activeCamera ||
    null;
  if (!camera) return null;
  const frame = frameFromDocument(document, camera.id);
  const traffic = trafficSnapshot(dataManager);
  let roads = null;
  if (finiteOrNull(camera.lat) !== null && finiteOrNull(camera.lon) !== null) {
    try {
      const response = await fetchImpl('/api/overpass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:
          'data=' + encodeURIComponent(buildLanesQuery(camera.lat, camera.lon)),
        signal:
          signal ??
          (typeof AbortSignal?.timeout === 'function'
            ? AbortSignal.timeout(LANES_FETCH_TIMEOUT_MS)
            : undefined),
      });
      if (response?.ok) roads = parseOverpassRoads(await response.json());
    } catch {
      roads = null;
    }
  }
  return {
    kind: 'camera',
    layerId: CCTV_LAYER_ID,
    entity: cameraEntityFrom(camera, { frame, roads, traffic }),
  };
}
