/**
 * @module ondemand/entityContext
 * @description Pure builder for the context payload the "ASK ONDEMAND"
 * entity chat sends to OnDemand as its first turn (docs/ENTITY_CHAT.md).
 *
 * Everything here is synchronous and side-effect free: the caller
 * (src/ondemand/entityChat.js) gathers the live inputs — the selected
 * record, the data manager, the viewer camera, the `/api/tools` catalogue,
 * the `/api/ondemand/health` config block and, optionally, the satellites
 * the `/api/tools/list_satellites_in_scene` tool reports overhead — and this
 * module turns them into one JSON-safe object plus the compact system-style
 * instruction that precedes it. No value may be `undefined` or `NaN`:
 * missing data is `null` so the payload survives JSON.stringify unchanged.
 *
 * Layer rows carry the EXACT text the DATA LAYERS panel prints for each
 * layer: `dataManager._buildMetaText(layer)` when the manager exposes it
 * (src/data/manager.js), else the same LayerPanel method invoked directly.
 */
import * as mgrsModule from 'mgrs';
import { layerFeedState } from '../data/feedState.js';
import { LayerPanel } from '../ui/layerPanel.js';

export const ENTITY_CONTEXT_SCHEMA = 'ondemand-spatial/entity-chat/1';
export const MAX_NEARBY = 10;
export const ENTITY_KINDS = Object.freeze(['aircraft', 'vessel', 'satellite']);
/** Selection-lane layer id → entity kind. */
export const LAYER_KIND = Object.freeze({
  flights: 'aircraft',
  military: 'aircraft',
  'ais-live-vessels': 'vessel',
  satellites: 'satellite',
});
/** Ground radius searched for nearby aircraft/vessels (km). */
export const NEARBY_RADIUS_KM = 250;
/** Ground radius for satellites overhead (km) — matches the tool default. */
export const SATELLITE_RADIUS_KM = 1500;
/** Byte budget for the first turn; the chat proxy rejects queries > 32 KiB. */
export const CONTEXT_BYTE_BUDGET = 28 * 1024;
const MAX_RAW_KEYS = 40;
const MAX_RAW_STRING = 160;
const EARTH_RADIUS_KM = 6371.0088;

// `mgrs` is a CommonJS package: Vite resolves its ESM build (named exports
// only), Node's loader sees `module.exports` as `default`. Accept both.
const toMgrsRaw =
  typeof mgrsModule.forward === 'function'
    ? mgrsModule.forward
    : mgrsModule.default?.forward;

/** @param {string} layerId @returns {'aircraft'|'vessel'|'satellite'|null} */
export function kindForLayer(layerId) {
  return LAYER_KIND[layerId] || null;
}

/** Finite number or null — never NaN/undefined. */
export function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Trimmed non-empty string or null. */
export function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/**
 * MGRS grid reference, spaced the way the HUD prints it
 * (src/hud.js `_formatMGRS`: `18S UJ 2337 0716`, 10 m precision).
 * @param {number} lat
 * @param {number} lon
 * @returns {string|null}
 */
export function toMgrs(lat, lon) {
  const latitude = finiteOrNull(lat);
  const longitude = finiteOrNull(lon);
  if (
    latitude === null ||
    longitude === null ||
    Math.abs(latitude) > 84 ||
    Math.abs(longitude) > 180 ||
    typeof toMgrsRaw !== 'function'
  )
    return null;
  try {
    const raw = String(toMgrsRaw([longitude, latitude], 4));
    const match = raw.match(/^(\d{1,2}[A-Z])\s*([A-Z]{2})\s*(\d+)$/);
    if (!match) return raw;
    const [, zone, square, coords] = match;
    const half = coords.length / 2;
    return `${zone} ${square} ${coords.slice(0, half)} ${coords.slice(half)}`;
  } catch {
    return null;
  }
}

/** Great-circle distance in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing (deg, 0..360) from point 1 to point 2. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.cos(toRad(lon2 - lon1));
  return ((((Math.atan2(y, x) * 180) / Math.PI) % 360) + 360) % 360;
}

function round(value, digits) {
  const number = finiteOrNull(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const date =
    value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value < 1e12 ? value * 1000 : value)
        : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Trim a record to JSON-safe primitives: at most MAX_RAW_KEYS keys, strings
 * clipped, nested objects dropped (the summarised fields already carry the
 * important ones). Cesium objects, functions and symbols never survive.
 * @param {object|null|undefined} record
 * @returns {object}
 */
export function trimRecord(record) {
  const out = {};
  if (!record || typeof record !== 'object') return out;
  let count = 0;
  for (const [key, value] of Object.entries(record)) {
    if (count >= MAX_RAW_KEYS) break;
    if (key.startsWith('_') || key === 'position' || key === 'entity') continue;
    if (typeof value === 'string') {
      out[key] =
        value.length > MAX_RAW_STRING ? value.slice(0, MAX_RAW_STRING) : value;
    } else if (typeof value === 'number') {
      out[key] = Number.isFinite(value) ? value : null;
    } else if (typeof value === 'boolean' || value === null) {
      out[key] = value;
    } else if (value === undefined) {
      continue;
    } else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      ['origin', 'destination', 'route'].includes(key)
    ) {
      // Route legs are small {code, name} pairs worth keeping.
      out[key] = trimRecord(value);
    } else {
      continue;
    }
    count += 1;
  }
  return out;
}

/**
 * Normalise whatever a layer hands out for its selected/tracked subject —
 * flights/military `getTrackedInfo()`, vessels `getSelectedInfo()` or a raw
 * AIS record, satellites `getTrackedInfo()` — into the fixed entity block.
 * @param {'aircraft'|'vessel'|'satellite'} kind
 * @param {object} entity
 * @param {{ sourceFeed?: string|null }} [options]
 */
export function normalizeEntity(kind, entity = {}, { sourceFeed = null } = {}) {
  const e = entity && typeof entity === 'object' ? entity : {};
  const lat = finiteOrNull(e.lat ?? e.latitude);
  const lon = finiteOrNull(e.lon ?? e.longitude);
  const base = {
    kind,
    id: null,
    lat,
    lon,
    altitudeM: null,
    speedMps: null,
    headingDeg: null,
    squawk: textOrNull(e.squawk),
    sourceFeed: textOrNull(sourceFeed ?? e.sourceFeed ?? e.source),
    observedAtUtc: null,
    raw: trimRecord(e),
  };
  if (kind === 'aircraft') {
    const icao24 = textOrNull(e.icao24 ?? e.id);
    const speedKt = finiteOrNull(e.speedKt);
    return {
      ...base,
      id: icao24,
      callsign: textOrNull(e.callsign) || textOrNull(e.label) || null,
      icao24,
      registration: textOrNull(e.registration),
      typeCode: textOrNull(e.typeCode),
      typeName: textOrNull(e.typeName),
      operator: textOrNull(e.airline ?? e.operator),
      onGround: typeof e.onGround === 'boolean' ? e.onGround : null,
      military: e.military === true || e.layerId === 'military' || null,
      altitudeM: round(e.altitudeM ?? e.altitude, 0),
      speedMps: round(
        e.velocityMps ??
          e.speedMps ??
          (speedKt === null ? null : speedKt * 0.514444),
        1,
      ),
      headingDeg: round(
        e.track ?? e.headingDeg ?? e.heading ?? e.true_track,
        0,
      ),
      observedAtUtc: isoOrNull(
        e.lastContactEpochMs ?? e.observedAtUtc ?? e.lastContact,
      ),
      route:
        e.route && typeof e.route === 'object'
          ? {
              origin: textOrNull(e.route.origin?.code ?? e.origin),
              destination: textOrNull(
                e.route.destination?.code ?? e.destination,
              ),
            }
          : e.origin || e.destination
            ? {
                origin: textOrNull(e.origin),
                destination: textOrNull(e.destination),
              }
            : null,
    };
  }
  if (kind === 'vessel') {
    const mmsi = textOrNull(e.mmsi ?? e.id);
    const speedKt = finiteOrNull(e.speedKt ?? e.speed);
    return {
      ...base,
      id: mmsi,
      name: textOrNull(e.name) || textOrNull(e.label) || null,
      mmsi,
      imo: textOrNull(e.imo),
      shipType: textOrNull(e.type ?? e.shipType),
      destination: textOrNull(e.destination),
      altitudeM: 0,
      speedMps: speedKt === null ? null : round(speedKt * 0.514444, 1),
      speedKt: speedKt === null ? null : round(speedKt, 1),
      headingDeg: round(e.heading ?? e.headingDeg ?? e.course, 0),
      courseDeg: round(e.course, 0),
      observedAtUtc: isoOrNull(
        e.lastPositionUtc ?? e.lastPositionEpoch ?? e.observedAtUtc,
      ),
    };
  }
  const noradId = textOrNull(e.noradId ?? e.norad ?? e.id);
  const velocityKms = finiteOrNull(e.velocityKms);
  return {
    ...base,
    kind: 'satellite',
    id: noradId,
    name: textOrNull(e.name) || textOrNull(e.label) || null,
    noradId,
    group: textOrNull(e.group ?? e.class),
    altitudeM: round(
      e.altitudeM ?? (e.altKm === undefined ? null : e.altKm * 1000),
      0,
    ),
    speedMps:
      finiteOrNull(e.speedMps) ??
      (velocityKms === null ? null : round(velocityKms * 1000, 0)),
    headingDeg: round(e.headingDeg ?? e.heading, 0),
    observedAtUtc: isoOrNull(e.observedAtUtc ?? e.epochUtc),
  };
}

/**
 * The exact DATA LAYERS row text for one manager layer. Prefers the live
 * manager's `_buildMetaText` (src/data/manager.js → LayerPanel); otherwise
 * runs the same LayerPanel method with a `_timeAgo` bound to `now`.
 * @param {object} layer  one entry of dataManager.getAll()
 * @param {{ dataManager?: object, now?: number }} [options]
 * @returns {string}
 */
export function layerStatusText(layer, { dataManager, now = Date.now() } = {}) {
  if (dataManager && typeof dataManager._buildMetaText === 'function') {
    try {
      const text = dataManager._buildMetaText(layer);
      if (typeof text === 'string') return text;
    } catch {
      // fall through to the direct LayerPanel path
    }
  }
  const host = {
    _timeAgo(timestamp) {
      const diff = Math.floor((now - timestamp) / 1000);
      if (diff < 5) return 'just now';
      if (diff < 60) return `${diff}s ago`;
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
      return `${Math.floor(diff / 3600)}h ago`;
    },
  };
  try {
    return LayerPanel.prototype._buildMetaText.call(host, layer);
  } catch {
    const stats = layer?.stats || {};
    return `${String(layerFeedState(stats)).toUpperCase()} · ${stats.source || layer?.source || 'unknown'}`;
  }
}

/**
 * One row per registered layer (ALL of them, hidden ones included).
 * @param {{ getAll?: () => object[] }|null|undefined} dataManager
 * @param {{ now?: number }} [options]
 */
export function describeLayers(dataManager, { now = Date.now() } = {}) {
  let layers = [];
  try {
    layers =
      typeof dataManager?.getAll === 'function' ? dataManager.getAll() : [];
  } catch {
    layers = [];
  }
  if (!Array.isArray(layers)) layers = [];
  return layers.map((layer) => {
    const stats =
      layer?.stats && typeof layer.stats === 'object' ? layer.stats : {};
    return {
      id: String(layer?.id ?? ''),
      label: textOrNull(layer?.name) || String(layer?.id ?? ''),
      enabled: layer?.enabled === true,
      feedState: layer?.enabled ? layerFeedState(stats) : 'off',
      statusText: layerStatusText(layer, { dataManager, now }),
      source: textOrNull(stats.source) || textOrNull(layer?.source) || null,
      providerStatus: textOrNull(stats.providerStatus),
      providerError: textOrNull(
        stats.providerError ?? stats.error ?? stats.lastError,
      ),
      count: Math.max(0, Math.trunc(finiteOrNull(stats.count) ?? 0)),
    };
  });
}

function positionsOf(dataManager, layerId, maxCount) {
  const module = dataManager?.layers?.get?.(layerId)?.module;
  if (!module || typeof module.getAllPositions !== 'function') return [];
  try {
    const rows = module.getAllPositions(maxCount);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * Sort a position list by distance from (lat, lon), drop the subject itself,
 * cap at `limit` and reduce each row to a small JSON-safe summary.
 * @param {object[]} rows  `{ id, label, latitude, longitude, altitudeM?, ... }`
 * @param {{ lat: number, lon: number, radiusKm: number, excludeId?: string|null, limit?: number, extra?: (row) => object }} options
 */
export function nearbyRows(
  rows,
  { lat, lon, radiusKm, excludeId = null, limit = MAX_NEARBY, extra },
) {
  if (
    !Array.isArray(rows) ||
    finiteOrNull(lat) === null ||
    finiteOrNull(lon) === null
  )
    return [];
  const exclude =
    excludeId === null || excludeId === undefined
      ? null
      : String(excludeId).toLowerCase();
  const scored = [];
  for (const row of rows) {
    if (!row) continue;
    const rowLat = finiteOrNull(row.latitude ?? row.lat);
    const rowLon = finiteOrNull(row.longitude ?? row.lon);
    if (rowLat === null || rowLon === null) continue;
    const id = row.id === undefined || row.id === null ? null : String(row.id);
    if (exclude !== null && id !== null && id.toLowerCase() === exclude)
      continue;
    const distanceKm = haversineKm(lat, lon, rowLat, rowLon);
    if (distanceKm > radiusKm) continue;
    scored.push({ row, id, rowLat, rowLon, distanceKm });
  }
  scored.sort((a, b) => a.distanceKm - b.distanceKm);
  return scored
    .slice(0, Math.max(0, limit))
    .map(({ row, id, rowLat, rowLon, distanceKm }) => ({
      id,
      label: textOrNull(row.label ?? row.name) || id,
      lat: round(rowLat, 4),
      lon: round(rowLon, 4),
      altitudeM: round(
        row.altitudeM ?? (row.altKm === undefined ? null : row.altKm * 1000),
        0,
      ),
      distanceKm: round(distanceKm, 1),
      bearingDeg: round(bearingDeg(lat, lon, rowLat, rowLon), 0),
      ...(typeof extra === 'function' ? extra(row) : {}),
    }));
}

/**
 * Nearby aircraft (flights + military), vessels and satellites around the
 * subject. Satellites prefer the `list_satellites_in_scene` tool rows when
 * the caller fetched them; otherwise the satellites layer's rendered points.
 */
export function collectNearby({
  dataManager,
  entity,
  satellitesOverhead = null,
} = {}) {
  const lat = entity?.lat;
  const lon = entity?.lon;
  const excludeAircraft = entity?.kind === 'aircraft' ? entity.id : null;
  const excludeVessel = entity?.kind === 'vessel' ? entity.id : null;
  const excludeSatellite = entity?.kind === 'satellite' ? entity.id : null;
  const aircraftRows = [
    ...positionsOf(dataManager, 'flights', 500).map((row) => ({
      ...row,
      military: false,
    })),
    ...positionsOf(dataManager, 'military', 500).map((row) => ({
      ...row,
      military: true,
    })),
  ];
  const aircraft = nearbyRows(aircraftRows, {
    lat,
    lon,
    radiusKm: NEARBY_RADIUS_KM,
    excludeId: excludeAircraft,
    extra: (row) => ({
      military: row.military === true,
      typeCode: textOrNull(row.typeCode),
      origin: textOrNull(row.origin),
      destination: textOrNull(row.destination),
    }),
  });
  const vessels = nearbyRows(
    positionsOf(dataManager, 'ais-live-vessels', 800),
    {
      lat,
      lon,
      radiusKm: NEARBY_RADIUS_KM,
      excludeId: excludeVessel,
    },
  );
  const toolRows = Array.isArray(satellitesOverhead)
    ? satellitesOverhead.map((row) => ({
        id: row.noradId ?? row.id,
        label: row.name ?? row.label,
        latitude: row.lat ?? row.latitude,
        longitude: row.lon ?? row.longitude,
        altKm: row.altKm,
        altitudeM: row.altitudeM,
        group: row.group,
        elevationDeg: row.elevationDeg,
      }))
    : null;
  const satellites = nearbyRows(
    toolRows && toolRows.length
      ? toolRows
      : positionsOf(dataManager, 'satellites', 300),
    {
      lat,
      lon,
      radiusKm: SATELLITE_RADIUS_KM,
      excludeId: excludeSatellite,
      extra: (row) => ({
        group: textOrNull(row.group),
        elevationDeg: round(row.elevationDeg, 1),
      }),
    },
  );
  return {
    radiusKm: NEARBY_RADIUS_KM,
    satelliteRadiusKm: SATELLITE_RADIUS_KM,
    satelliteSource:
      toolRows && toolRows.length
        ? 'list_satellites_in_scene'
        : 'satellites-layer',
    aircraft,
    vessels,
    satellites,
  };
}

function radToDeg(rad) {
  return (rad * 180) / Math.PI;
}

/**
 * Scene block: a name, the camera's view rectangle as an OpenSky-style bbox
 * (falls back to ±2° around the subject), the camera position and the
 * subject coordinates with their MGRS reference. The viewer is duck-typed
 * (Cesium `camera.positionCartographic` / `camera.computeViewRectangle`) so
 * tests can pass plain objects.
 */
export function describeScene({ viewer, entity, scene = {} } = {}) {
  const lat = finiteOrNull(entity?.lat);
  const lon = finiteOrNull(entity?.lon);
  let camera = { lat: null, lon: null, heightM: null };
  let bbox = null;
  try {
    const carto = viewer?.camera?.positionCartographic;
    if (carto && Number.isFinite(carto.latitude)) {
      camera = {
        lat: round(radToDeg(carto.latitude), 4),
        lon: round(radToDeg(carto.longitude), 4),
        heightM: round(carto.height, 0),
      };
    }
    const rect =
      typeof viewer?.camera?.computeViewRectangle === 'function'
        ? viewer.camera.computeViewRectangle()
        : null;
    if (rect && Number.isFinite(rect.south)) {
      bbox = {
        lamin: round(radToDeg(rect.south), 3),
        lomin: round(radToDeg(rect.west), 3),
        lamax: round(radToDeg(rect.north), 3),
        lomax: round(radToDeg(rect.east), 3),
      };
    }
  } catch {
    // a torn-down viewer reports nothing
  }
  if (scene?.camera && typeof scene.camera === 'object') {
    camera = {
      lat: finiteOrNull(scene.camera.lat) ?? camera.lat,
      lon: finiteOrNull(scene.camera.lon) ?? camera.lon,
      heightM: finiteOrNull(scene.camera.heightM) ?? camera.heightM,
    };
  }
  if (scene?.bbox && typeof scene.bbox === 'object') {
    bbox = {
      lamin: finiteOrNull(scene.bbox.lamin),
      lomin: finiteOrNull(scene.bbox.lomin),
      lamax: finiteOrNull(scene.bbox.lamax),
      lomax: finiteOrNull(scene.bbox.lomax),
    };
  }
  if (!bbox && lat !== null && lon !== null) {
    bbox = {
      lamin: round(Math.max(-90, lat - 2), 3),
      lomin: round(Math.max(-180, lon - 2), 3),
      lamax: round(Math.min(90, lat + 2), 3),
      lomax: round(Math.min(180, lon + 2), 3),
    };
  }
  if (!bbox) bbox = { lamin: null, lomin: null, lamax: null, lomax: null };
  const name =
    textOrNull(scene?.name) ||
    (lat !== null && lon !== null
      ? `${round(lat, 3)}, ${round(lon, 3)}`
      : 'unknown scene');
  return {
    name,
    bbox,
    camera,
    coordinates: {
      lat: round(lat, 5),
      lon: round(lon, 5),
      mgrs: toMgrs(lat, lon),
    },
  };
}

/**
 * Trim the `/api/tools` catalogue (`{ tools: [{ id, name, description,
 * tools: [{ name, summary, path, params }] }] }`, or the inner array) to
 * ids, names, paths and param names.
 */
export function describeToolCatalogue(tools) {
  const list = Array.isArray(tools)
    ? tools
    : Array.isArray(tools?.tools)
      ? tools.tools
      : [];
  return list
    .filter((plugin) => plugin && typeof plugin === 'object')
    .map((plugin) => ({
      id: textOrNull(plugin.id),
      name: textOrNull(plugin.name),
      tools: (Array.isArray(plugin.tools) ? plugin.tools : [])
        .filter((tool) => tool && typeof tool === 'object')
        .map((tool) => ({
          name: textOrNull(tool.name),
          path:
            textOrNull(tool.path) ||
            (tool.name ? `/api/tools/${tool.name}` : null),
          params:
            tool.params &&
            typeof tool.params === 'object' &&
            !Array.isArray(tool.params)
              ? Object.keys(tool.params)
              : Array.isArray(tool.params)
                ? tool.params.map(String)
                : [],
        })),
    }));
}

/**
 * Workflow identity from the health config block. Health reports NAMES
 * (`source`, `resolvedVia`), not values, so `id`/`versionLabel` are only
 * populated when the block carries them; the env-name provenance is always
 * present.
 * @param {object|null|undefined} health  `/api/ondemand/health` JSON
 */
export function describeWorkflow(health) {
  const cfg =
    health?.config && typeof health.config === 'object' ? health.config : {};
  const flowId =
    cfg.spatialFlowId && typeof cfg.spatialFlowId === 'object'
      ? cfg.spatialFlowId
      : {};
  const flowVersion =
    cfg.flowVersion && typeof cfg.flowVersion === 'object'
      ? cfg.flowVersion
      : {};
  return {
    id: textOrNull(flowId.id ?? flowId.value),
    idSource: textOrNull(flowId.source),
    versionLabel: textOrNull(
      flowVersion.value ?? flowVersion.label ?? flowVersion.version,
    ),
    versionSource: textOrNull(flowVersion.source),
    resolvedVia: textOrNull(flowVersion.resolvedVia),
    configured: health?.configured === true,
    ondemand: textOrNull(health?.ondemand),
  };
}

/**
 * Build the full context payload.
 * @param {{
 *   entity: object, kind: 'aircraft'|'vessel'|'satellite',
 *   viewer?: object, dataManager?: object, scene?: object,
 *   tools?: object|object[], health?: object, now?: number|Date,
 *   satellitesOverhead?: object[]|null, sourceFeed?: string|null,
 * }} input
 */
export function buildEntityContext({
  entity,
  kind,
  viewer = null,
  dataManager = null,
  scene = {},
  tools = null,
  health = null,
  now = Date.now(),
  satellitesOverhead = null,
  sourceFeed = null,
} = {}) {
  const resolvedKind = ENTITY_KINDS.includes(kind)
    ? kind
    : kindForLayer(entity?.layerId) || 'aircraft';
  const nowMs =
    now instanceof Date ? now.getTime() : (finiteOrNull(now) ?? Date.now());
  const normalized = normalizeEntity(resolvedKind, entity, { sourceFeed });
  return {
    schema: ENTITY_CONTEXT_SCHEMA,
    generatedAtUtc: new Date(nowMs).toISOString(),
    entity: normalized,
    scene: describeScene({ viewer, entity: normalized, scene }),
    layers: describeLayers(dataManager, { now: nowMs }),
    nearby: collectNearby({
      dataManager,
      entity: normalized,
      satellitesOverhead,
    }),
    tools: {
      catalogue: describeToolCatalogue(tools),
      workflow: describeWorkflow(health),
    },
    limits: { maxNearby: MAX_NEARBY, contextByteBudget: CONTEXT_BYTE_BUDGET },
  };
}

function utf8Bytes(text) {
  if (typeof TextEncoder !== 'undefined')
    return new TextEncoder().encode(text).length;
  return text.length;
}

/**
 * Shrink a context until its JSON fits `maxBytes` — raw record first, then
 * tool params, then the nearby lists, then layer status text. Returns a new
 * object; the input is untouched.
 */
export function fitContextToBudget(context, maxBytes = CONTEXT_BYTE_BUDGET) {
  let next = JSON.parse(JSON.stringify(context));
  const steps = [
    (c) => {
      if (c.entity) c.entity.raw = {};
    },
    (c) => {
      for (const plugin of c.tools?.catalogue || [])
        for (const tool of plugin.tools || []) tool.params = [];
    },
    (c) => {
      for (const key of ['aircraft', 'vessels', 'satellites'])
        if (Array.isArray(c.nearby?.[key]))
          c.nearby[key] = c.nearby[key].slice(0, 3);
    },
    (c) => {
      if (c.tools) c.tools.catalogue = [];
    },
    (c) => {
      for (const key of ['aircraft', 'vessels', 'satellites'])
        if (c.nearby) c.nearby[key] = [];
    },
    (c) => {
      c.layers = (c.layers || []).filter((row) => row.enabled);
    },
    (c) => {
      for (const row of c.layers || [])
        if (typeof row.statusText === 'string' && row.statusText.length > 80)
          row.statusText = `${row.statusText.slice(0, 77)}...`;
    },
    (c) => {
      c.layers = (c.layers || []).slice(0, 40);
    },
    (c) => {
      c.layers = [];
    },
  ];
  for (const step of steps) {
    if (utf8Bytes(JSON.stringify(next)) <= maxBytes) break;
    step(next);
  }
  return next;
}

const ENTITY_LABEL = {
  aircraft: 'aircraft',
  vessel: 'vessel',
  satellite: 'satellite',
};

/**
 * The compact instruction that precedes the JSON context (≤ 2 KB).
 * @param {object} context  output of buildEntityContext
 */
export function entitySystemInstruction(context) {
  const kind = ENTITY_LABEL[context?.entity?.kind] || 'entity';
  const label =
    context?.entity?.callsign ||
    context?.entity?.name ||
    context?.entity?.id ||
    'unknown';
  const mgrs = context?.scene?.coordinates?.mgrs || 'n/a';
  const enabled = (context?.layers || []).filter((row) => row.enabled).length;
  const total = (context?.layers || []).length;
  const toolNames = (context?.tools?.catalogue || [])
    .flatMap((plugin) => (plugin.tools || []).map((tool) => tool.name))
    .filter(Boolean)
    .slice(0, 12)
    .join(', ');
  return [
    'You are the OnDemand Spatial analyst embedded in a live 3D globe console.',
    `The operator has selected a ${kind}: ${label} at MGRS ${mgrs} (scene "${context?.scene?.name || 'unknown'}").`,
    'The JSON block after this instruction is the ground truth for this conversation: the selected entity (fields are null when the feed did not report them), the camera scene, the status text of EVERY data layer exactly as the DATA LAYERS panel shows it, the nearest aircraft/vessels/satellites (capped at 10 each) and the tool catalogue this console can call.',
    'Rules: answer concisely (2–6 sentences or a short list) in plain text; state units (m, kt, km, °); never invent identity, route or position data that is not in the JSON — say "not reported" instead; when a layer is DEGRADED/STALE/FALLBACK/UNAVAILABLE, say so before relying on it; distances are great-circle from the selected entity.',
    toolNames
      ? `Tools available to the console (you cannot call them yourself; recommend by name when useful): ${toolNames}.`
      : 'No tool catalogue was available for this session.',
    'When a map action is appropriate (fly to, track, enable a layer), end your reply with one line: MapAction: {"action":"flyTo|track|enableLayer","target":"<id or layer id>"}; otherwise omit that line.',
    'Reply to this first message with exactly: READY',
  ].join('\n');
}

/**
 * First-turn text: the instruction plus the (budget-fitted) JSON context.
 * @param {object} context
 * @param {{ maxBytes?: number }} [options]
 */
export function entitySystemPrompt(
  context,
  { maxBytes = CONTEXT_BYTE_BUDGET } = {},
) {
  const instruction = entitySystemInstruction(context);
  const fitted = fitContextToBudget(
    context,
    maxBytes - utf8Bytes(instruction) - 64,
  );
  return `${instruction}\n\nCONTEXT_JSON:\n${JSON.stringify(fitted)}`;
}
