import { createHmac, randomBytes } from 'node:crypto';
/**
 * Pure state handling for the OpenTrafficMap tiled C-ITS feed.
 *
 * OpenTrafficMap (opentrafficmap.org) relays C-ITS broadcasts (CAM, DENM,
 * MAPEM, SPATEM) that volunteer receivers pick up over the air. Its
 * `/ws_tiled` socket serves a per-tile full status followed by patch batches.
 * This module mirrors that protocol (tile choice, full status, delta
 * application) and compacts the result into the small records the browser
 * layer draws. The socket itself lives in `../cits.js`.
 */

/** Highest tile zoom the upstream accepts. */
export const CITS_MAX_TILE_ZOOM = 14;
/** Below this zoom a 4-tile cover is too wide to subscribe responsibly. */
export const CITS_MIN_TILE_ZOOM = 9;
/** Upstream clients subscribe at most this many tiles. */
export const CITS_MAX_TILES = 4;

/** Moving stations disappear once they have been silent this long. */
export const CITS_VEHICLE_MAX_AGE_MS = 120_000;
/** Fixed stations (lights, RSUs, trailers) are kept a day after last contact. */
export const CITS_FIXED_MAX_AGE_MS = 86_400_000;
/** Upstream station TTL; older stations are flagged stale. */
export const CITS_STALE_AFTER_MS = 900_000;
/** A SPaT older than this no longer describes the current signal phase. */
export const CITS_SPAT_FRESH_MS = 15_000;
/** Response ceilings, so one dense view cannot balloon a poll. */
export const CITS_MAX_OBJECTS = 8000;
export const CITS_MAX_HAZARDS = 2000;
export const CITS_MAX_INTERSECTIONS = 600;
/** Mirror ceiling per tile; upserts past it are dropped. */
export const CITS_MAX_POINTS_PER_TILE = 20_000;

/**
 * Station kinds shown in full. Every other moving station — private cars and
 * any other vehicle that is not public transport — is reduced to an anonymous
 * dot: a per-process keyed hash instead of its station address, and only
 * kind, position, speed and report age. Vehicle tracks are never returned.
 */
export const CITS_PUBLIC_KINDS = Object.freeze(
  new Set(['traffic_light', 'rsu', 'trailer', 'bus', 'tram']),
);

const FIXED_KINDS = new Set(['traffic_light', 'rsu', 'trailer']);
// Rotates with the process; anonymous ids cannot be joined across restarts.
const ANONYMOUS_ID_KEY = randomBytes(32);

/** Keyed, truncated hash that stands in for a station address. */
export function citsAnonymousId(value, key = ANONYMOUS_ID_KEY) {
  return `anon-${createHmac('sha256', key).update(String(value)).digest('hex').slice(0, 16)}`;
}

function lonToX(lon, zoom) {
  const scale = 2 ** zoom;
  let normalized = Number(lon);
  while (normalized < -180) normalized += 360;
  while (normalized >= 180) normalized -= 360;
  return Math.max(
    0,
    Math.min(scale - 1, Math.floor(((normalized + 180) / 360) * scale)),
  );
}

function latToY(lat, zoom) {
  const scale = 2 ** zoom;
  const clipped = Math.max(-85.05112878, Math.min(85.05112878, Number(lat)));
  const radians = (clipped * Math.PI) / 180;
  return Math.max(
    0,
    Math.min(
      scale - 1,
      Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * scale),
    ),
  );
}

/**
 * Validate a `west,south,east,north` box in degrees.
 * @returns {{west:number,south:number,east:number,north:number}|null}
 */
export function validCitsBounds({ west, south, east, north } = {}) {
  const box = {
    west: Number(west),
    south: Number(south),
    east: Number(east),
    north: Number(north),
  };
  if (!Object.values(box).every(Number.isFinite)) return null;
  if (box.west < -180 || box.east > 180 || box.west >= box.east) return null;
  if (box.south < -90 || box.north > 90 || box.south >= box.north) return null;
  return box;
}

/**
 * Choose the most detailed cover of at most four tiles, as the upstream map
 * client does. Returns `null` when the box needs tiles coarser than
 * CITS_MIN_TILE_ZOOM, which would pull a whole country's worth of traffic.
 * @returns {{zoom:number,tiles:string[]}|null}
 */
export function citsTilesForBounds(bounds) {
  const box = validCitsBounds(bounds);
  if (!box) return null;
  for (let zoom = CITS_MAX_TILE_ZOOM; zoom >= CITS_MIN_TILE_ZOOM; zoom--) {
    const minX = lonToX(box.west, zoom);
    const maxX = lonToX(box.east, zoom);
    const minY = latToY(box.north, zoom);
    const maxY = latToY(box.south, zoom);
    const count = (maxX - minX + 1) * (maxY - minY + 1);
    if (count > CITS_MAX_TILES) continue;
    const tiles = [];
    for (let x = minX; x <= maxX; x++)
      for (let y = minY; y <= maxY; y++) tiles.push(`${zoom}/${x}/${y}`);
    return { zoom, tiles };
  }
  return null;
}

/** Create the mirror of every subscribed tile. */
export function createCitsTileStore() {
  /** @type {Map<string,{seq:number,points:object,tracks:object,maps:object}>} */
  const tiles = new Map();
  let mapsVersion = 0;

  function applyPointPatch(feature, patch) {
    if (!feature || !patch) return null;
    const properties = { ...feature.properties, ...patch.properties };
    for (const key of Array.isArray(patch.removeProperties)
      ? patch.removeProperties
      : [])
      delete properties[key];
    const next = { ...feature, properties };
    if (patch.geometry && typeof patch.geometry === 'object')
      next.geometry = patch.geometry;
    return next;
  }

  // Tracks are vehicle location histories. Only their ids are mirrored —
  // patches must find a known track for the tile sequence to stay valid —
  // and no coordinate is ever kept.
  const TRACK_MARKER = true;
  const trackIds = (collection) =>
    Object.fromEntries(
      Object.keys(collection || {}).map((id) => [id, TRACK_MARKER]),
    );

  /**
   * Apply one tile delta. Returns false when the tile's sequence or an
   * unknown patch target means the mirror diverged and needs a resync.
   */
  function applyDelta(delta, dictionaries) {
    const entry = tiles.get(String(delta?.tile || ''));
    if (!entry) return true;
    if (Number(delta.baseSeq) !== entry.seq) return false;
    let pointCount = Object.keys(entry.points).length;
    for (const id of delta.upsertPointIds || []) {
      const feature = dictionaries.pointsById?.[id];
      if (!feature) continue;
      if (!entry.points[id]) {
        if (pointCount >= CITS_MAX_POINTS_PER_TILE) continue;
        pointCount++;
      }
      entry.points[id] = feature;
    }
    for (const id of delta.patchPointIds || []) {
      const next = applyPointPatch(
        entry.points[id],
        dictionaries.pointPatchesById?.[id],
      );
      if (!next) return false;
      entry.points[id] = next;
    }
    for (const id of delta.removePoints || []) delete entry.points[id];
    for (const id of delta.upsertTrackIds || []) {
      if (dictionaries.tracksById?.[id]) entry.tracks[id] = TRACK_MARKER;
    }
    for (const id of delta.patchTrackIds || []) {
      if (!entry.tracks[id] || !dictionaries.trackPatchesById?.[id])
        return false;
    }
    for (const id of delta.removeTracks || []) delete entry.tracks[id];
    for (const id of delta.upsertTrafficLightMapIds || []) {
      const map = dictionaries.trafficLightMapsById?.[id];
      if (map?.mac) {
        entry.maps[map.mac] = map;
        mapsVersion++;
      }
    }
    for (const id of delta.removeTrafficLightMaps || []) {
      if (entry.maps[id]) mapsVersion++;
      delete entry.maps[id];
    }
    entry.seq = Number(delta.seq) || entry.seq;
    return true;
  }

  return {
    /** Replace one tile with a `tile-fullstatus` message. */
    applyFullStatus(message) {
      const tile = String(message?.tile || '');
      if (!tile) return;
      const state = message.state || {};
      tiles.set(tile, {
        seq: Number(message.seq) || 0,
        points: { ...state.points },
        tracks: trackIds(state.tracks),
        maps: { ...state.trafficLightMaps },
      });
      mapsVersion++;
    },

    /**
     * Apply a `tile-delta-batch` (or a lone `tile-delta`).
     * @returns {string[]} Tiles whose mirror diverged and must be resynced.
     */
    applyDeltaBatch(message) {
      const deltas =
        message?.type === 'tile-delta' ? [message] : message?.deltas || [];
      const dictionaries = message?.type === 'tile-delta' ? {} : message;
      const resync = [];
      for (const delta of deltas) {
        if (!applyDelta(delta, dictionaries)) {
          resync.push(String(delta.tile));
          tiles.delete(String(delta.tile));
        }
      }
      return resync;
    },

    /** Drop tiles that are no longer subscribed. */
    retain(tileIds) {
      const keep = new Set(tileIds);
      for (const tile of [...tiles.keys()])
        if (!keep.has(tile)) {
          tiles.delete(tile);
          mapsVersion++;
        }
    },

    clear() {
      if (tiles.size) mapsVersion++;
      tiles.clear();
    },

    has: (tile) => tiles.has(tile),
    get mapsVersion() {
      return mapsVersion;
    },

    /** Merge subscribed tiles into id-keyed feature maps. */
    merged() {
      const points = new Map();
      const maps = new Map();
      for (const entry of tiles.values()) {
        for (const [id, feature] of Object.entries(entry.points))
          points.set(id, feature);
        for (const [id, map] of Object.entries(entry.maps)) maps.set(id, map);
      }
      return { points, maps };
    },
  };
}

function inBounds([lon, lat] = [], box) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= box.west &&
    lon <= box.east &&
    lat >= box.south &&
    lat <= box.north
  );
}

function finiteOrNull(value) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? null : number;
}

function compactSpat(properties, now) {
  const spat = properties.trafficLightSpat;
  const ts = Date.parse(properties.trafficLightSpatTs || '');
  if (!spat || !Array.isArray(spat.groups)) return null;
  if (Number.isFinite(ts) && now - ts > CITS_SPAT_FRESH_MS) return null;
  return spat.groups
    .filter((group) => group && group.signalGroup != null)
    .map((group) => ({
      group: String(group.signalGroup),
      state: finiteOrNull(group.eventState),
    }));
}

function compactDenm(denm) {
  if (!denm || typeof denm !== 'object') return null;
  const position = Array.isArray(denm.eventPosition)
    ? denm.eventPosition.slice(0, 2)
    : null;
  const traces = Array.isArray(denm.traces)
    ? denm.traces.filter((trace) => Array.isArray(trace) && trace.length > 1)
    : [];
  const zone = Array.isArray(denm.eventZone) ? denm.eventZone : null;
  return {
    kind: typeof denm.messageKind === 'string' ? denm.messageKind : null,
    label: typeof denm.messageLabel === 'string' ? denm.messageLabel : null,
    position,
    paths: zone && zone.length > 1 ? [zone] : traces,
    speedLimit: finiteOrNull(denm.speedLimit),
  };
}

/**
 * Compact the merged mirror into browser records inside `box`.
 * Device MACs are pseudonymous station addresses, kept as stable ids only.
 */
export function compactCitsState(
  merged,
  box,
  {
    now = Date.now(),
    vehicleMaxAgeMs = CITS_VEHICLE_MAX_AGE_MS,
    fixedMaxAgeMs = CITS_FIXED_MAX_AGE_MS,
  } = {},
) {
  const objects = [];
  const hazards = new Map();
  for (const [id, feature] of merged.points) {
    const coordinates = feature?.geometry?.coordinates;
    const p = feature?.properties || {};
    const kind = typeof p.kind === 'string' ? p.kind : 'unknown';
    const lastSeen = Date.parse(p.lastSeen || '');
    const fixed = FIXED_KINDS.has(kind);
    const age = now - lastSeen;
    if (
      !Number.isFinite(lastSeen) ||
      age > (fixed ? fixedMaxAgeMs : vehicleMaxAgeMs)
    )
      continue;
    const denms = [
      ...(Array.isArray(p.denmEvents)
        ? p.denmEvents.map((event) => [event?.key, event?.denmData])
        : []),
      ...(p.denmData ? [['current', p.denmData]] : []),
    ];
    for (const [key, data] of denms) {
      const hazard = compactDenm(data);
      if (!hazard?.position || !inBounds(hazard.position, box)) continue;
      // DENMs are re-broadcast by many stations; the originator and its
      // sequence number identify one event.
      const hazardId = citsAnonymousId(
        data?.originatingStationId != null && data?.sequenceNumber != null
          ? `${data.originatingStationId}:${data.sequenceNumber}`
          : `${p.stationId ?? id}:${key}`,
      );
      if (hazards.size < CITS_MAX_HAZARDS)
        hazards.set(hazardId, { id: hazardId, ...hazard });
    }
    if (!inBounds(coordinates, box)) continue;
    if (objects.length >= CITS_MAX_OBJECTS) continue;
    const stale = age > (fixed ? CITS_STALE_AFTER_MS : CITS_VEHICLE_MAX_AGE_MS);
    if (!CITS_PUBLIC_KINDS.has(kind)) {
      objects.push({
        id: citsAnonymousId(id),
        kind,
        anonymous: true,
        lon: coordinates[0],
        lat: coordinates[1],
        speedKmh: finiteOrNull(p.speedKmh),
        lastSeen: p.lastSeen,
        stale,
      });
      continue;
    }
    objects.push({
      id,
      kind,
      lon: coordinates[0],
      lat: coordinates[1],
      heading: finiteOrNull(p.headingDeg),
      speedKmh: finiteOrNull(p.speedKmh),
      lastSeen: p.lastSeen,
      stale,
      name: p.trafficLightName || p.stationOverrideName || null,
      line: p.transitLineDisplay || null,
      destination: p.transitTargetName || null,
      vehicleNumber: p.vehicleNumber || null,
      spat: kind === 'traffic_light' ? compactSpat(p, now) : null,
      hasMap: p.hasTrafficLightMap === true,
    });
  }
  return { objects, hazards: [...hazards.values()] };
}

/** Convert one MAPEM lane point (centimetres east/north) to degrees. */
export function citsLanePointToLonLat(ref, point) {
  const east = Number(point?.[0]) / 100;
  const north = Number(point?.[1]) / 100;
  if (!Number.isFinite(east) || !Number.isFinite(north)) return null;
  return [
    ref.lon +
      east / Math.max(1e-9, 111320 * Math.cos((ref.lat * Math.PI) / 180)),
    ref.lat + north / 111320,
  ];
}

/** Compact MAPEM intersections inside `box` into lane polylines. */
export function compactCitsIntersections(merged, box) {
  const intersections = [];
  for (const [mac, entry] of merged.maps) {
    // Map entries wrap the decoded MAPEM as `{ type, mac, map }`.
    const map = entry?.map || entry;
    let lat = Number(map?.refLat);
    let lon = Number(map?.refLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      lat /= 1e7;
      lon /= 1e7;
    }
    if (!inBounds([lon, lat], box)) continue;
    const ref = { lat, lon };
    const lanes = [];
    for (const lane of Array.isArray(map.lanes) ? map.lanes : []) {
      const coordinates = (Array.isArray(lane?.points) ? lane.points : [])
        .map((point) => citsLanePointToLonLat(ref, point))
        .filter(Boolean);
      if (coordinates.length < 2) continue;
      lanes.push({
        id: String(lane.laneId ?? lanes.length),
        kind: typeof lane.kind === 'string' ? lane.kind : 'other',
        ingress: lane.ingressPath === true,
        egress: lane.egressPath === true,
        signalGroups: Array.isArray(lane.signalGroups)
          ? lane.signalGroups.map(String)
          : [],
        coordinates,
      });
    }
    if (intersections.length >= CITS_MAX_INTERSECTIONS) break;
    if (lanes.length)
      intersections.push({ id: mac, name: map.name || null, lon, lat, lanes });
  }
  return intersections;
}
