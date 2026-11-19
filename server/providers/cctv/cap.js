import {
  CCTV_MAX_SOURCES_CEILING,
  CCTV_SHARED_SOURCE_SLOTS,
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
 * pack happened to be appended last. A pack with a `reservedCount` keeps up to
 * that many rows only from the capacity ABOVE the shared floor, so a
 * reservation adds room and never shrinks the other packs' round-robin
 * share; at or below the floor reserved packs are ordinary lanes. Duplicate
 * ids resolve last-pack-wins so
 * file/env overrides keep replacing live records; the record is then counted
 * against the pack that won it.
 *
 * @param {Array<{name:string, sources:Array<object>}>} packs - Normalized
 *   packs in merge order (earlier packs lose duplicate ids to later ones).
 * @param {number} maxCount - Catalog cap.
 * @param {object} [options]
 * @param {number} [options.sharedFloor=CCTV_SHARED_SOURCE_SLOTS] - Slots kept
 *   for the round-robin before reservations apply.
 * @returns {{sources:Array<object>, packs:Array<{name:string, offered:number, kept:number}>}}
 */
export function allocateSourceCap(
  packs,
  maxCount,
  { sharedFloor = CCTV_SHARED_SOURCE_SLOTS } = {},
) {
  const owner = new Map();
  for (const pack of packs) {
    for (const source of pack.sources) {
      if (!source?.id) continue;
      owner.set(source.id, { pack: pack.name, source });
    }
  }
  const lanes = packs.map((pack) => {
    // Only the record that WON its id (the last occurrence anywhere, so also
    // the last within this pack) takes a lane slot; earlier duplicates never
    // count against the cap.
    const queue = pack.sources.filter(
      (source) => source?.id && owner.get(source.id)?.source === source,
    );
    return {
      name: pack.name,
      queue,
      reserved: Math.max(
        0,
        Math.min(queue.length, Math.floor(Number(pack.reservedCount) || 0)),
      ),
      next: 0,
      kept: 0,
    };
  });
  const total = lanes.reduce((sum, lane) => sum + lane.queue.length, 0);
  const limit = Math.min(total, Math.max(0, Math.floor(maxCount)));

  const sources = [];
  const reservedSources = [];
  if (limit >= total) {
    for (const lane of lanes) {
      sources.push(...lane.queue);
      lane.kept = lane.queue.length;
    }
  } else {
    // Reserved packs draw only on the capacity above the shared floor, then
    // every lane (reserved ones included) shares the rest round-robin.
    const reserveBudget = Math.max(0, limit - Math.max(0, sharedFloor));
    while (reservedSources.length < reserveBudget) {
      let tookReserved = false;
      for (const lane of lanes) {
        if (reservedSources.length >= reserveBudget) break;
        if (lane.kept >= lane.reserved) continue;
        reservedSources.push(lane.queue[lane.next]);
        lane.next += 1;
        lane.kept += 1;
        tookReserved = true;
      }
      if (!tookReserved) break;
    }
    while (sources.length + reservedSources.length < limit) {
      for (const lane of lanes) {
        if (sources.length + reservedSources.length >= limit) break;
        if (lane.next >= lane.queue.length) continue;
        sources.push(lane.queue[lane.next]);
        lane.next += 1;
        lane.kept += 1;
      }
    }
  }
  return {
    // Keep the shared round-robin sequence first so the default active camera
    // remains in its established region; guaranteed regional rows follow it.
    sources: [...sources, ...reservedSources],
    packs: lanes.map((lane) => ({
      name: lane.name,
      offered: lane.queue.length,
      kept: lane.kept,
    })),
  };
}
