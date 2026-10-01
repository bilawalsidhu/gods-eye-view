import {
  CCTV_MAX_SOURCES_CEILING,
  DEFAULT_CCTV_MAX_SOURCES,
} from './constants.js';

/**
 * Resolve the catalog-wide source cap from an env value.
 *
 * @param {string|number|undefined} raw - CCTV_MAX_SOURCES as configured.
 * @returns {number} Cap bounded to [8, CCTV_MAX_SOURCES_CEILING].
 */
export function resolveCatalogCap(raw) {
  const parsed = Number(raw || DEFAULT_CCTV_MAX_SOURCES);
  if (!Number.isFinite(parsed)) return DEFAULT_CCTV_MAX_SOURCES;
  return Math.max(8, Math.min(CCTV_MAX_SOURCES_CEILING, Math.floor(parsed)));
}

/**
 * Merge source packs under one cap without starving any of them.
 *
 * Every pack arrives already ordered by its own priority (nearest-to-anchor
 * first) and already trimmed to its own per-pack cap. When the packs together
 * exceed the catalog cap, the cap is filled ROUND-ROBIN — one camera from
 * each pack per turn, in each pack's own order — so a lowered
 * CCTV_MAX_SOURCES thins every region a little instead of deleting whichever
 * pack happened to be appended last. Duplicate ids resolve last-pack-wins so
 * file/env overrides keep replacing live records; the record is then counted
 * against the pack that won it.
 *
 * @param {Array<{name:string, sources:Array<object>}>} packs - Normalized
 *   packs in merge order (earlier packs lose duplicate ids to later ones).
 * @param {number} maxCount - Catalog cap.
 * @returns {{sources:Array<object>, packs:Array<{name:string, offered:number, kept:number}>}}
 */
export function allocateSourceCap(packs, maxCount) {
  const owner = new Map();
  for (const pack of packs) {
    for (const source of pack.sources) {
      if (!source?.id) continue;
      owner.set(source.id, { pack: pack.name, source });
    }
  }
  const lanes = packs.map((pack) => ({
    name: pack.name,
    // Only the record that WON its id (the last occurrence anywhere, so also
    // the last within this pack) takes a lane slot; earlier duplicates never
    // count against the cap.
    queue: pack.sources.filter(
      (source) => source?.id && owner.get(source.id)?.source === source,
    ),
    next: 0,
    kept: 0,
  }));
  const total = lanes.reduce((sum, lane) => sum + lane.queue.length, 0);
  const limit = Math.min(total, Math.max(0, Math.floor(maxCount)));

  const sources = [];
  if (limit >= total) {
    for (const lane of lanes) {
      sources.push(...lane.queue);
      lane.kept = lane.queue.length;
    }
  } else {
    while (sources.length < limit) {
      for (const lane of lanes) {
        if (sources.length >= limit) break;
        if (lane.next >= lane.queue.length) continue;
        sources.push(lane.queue[lane.next]);
        lane.next += 1;
        lane.kept += 1;
      }
    }
  }
  return {
    sources,
    packs: lanes.map((lane) => ({
      name: lane.name,
      offered: lane.queue.length,
      kept: lane.kept,
    })),
  };
}

function distanceKm(a, b) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

/** Select the nearest cameras to a geographic view focus, keeping last-pack-wins IDs. */
export function allocateSourceCapNearView(packs, maxCount, focus) {
  const owner = new Map();
  packs.forEach((pack, packIndex) => {
    for (const source of pack.sources) {
      if (source?.id)
        owner.set(source.id, { source, packIndex, pack: pack.name });
    }
  });
  const ranked = Array.from(owner.values())
    .map((entry) => ({
      ...entry,
      distance:
        Number.isFinite(entry.source.lat) && Number.isFinite(entry.source.lon)
          ? distanceKm(focus, { lat: entry.source.lat, lon: entry.source.lon })
          : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.distance - b.distance || a.packIndex - b.packIndex);
  const limit = Math.min(ranked.length, Math.max(0, Math.floor(maxCount)));
  const selected = ranked.slice(0, limit);
  const keptByPack = new Map();
  for (const item of selected) {
    keptByPack.set(item.pack, (keptByPack.get(item.pack) || 0) + 1);
  }
  return {
    sources: selected.map(({ source }) => source),
    packs: packs.map((pack) => ({
      name: pack.name,
      offered: pack.sources.filter(
        (source) => source?.id && owner.get(source.id)?.source === source,
      ).length,
      kept: keptByPack.get(pack.name) || 0,
    })),
  };
}
