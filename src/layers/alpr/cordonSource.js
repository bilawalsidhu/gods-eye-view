/**
 * @file Cordon data acquisition through the shared keyless /api/overpass
 * proxy: the enclosing town boundary at a point (`is_in` → area pivot, the
 * proxy's 30-day boundary cache class), the drivable roads in its padded
 * bbox, and the mapped cameras from the layer's own camera source. Every
 * query is spatially bounded the way the proxy validator requires — no
 * `poly:` and no area-bounded element scans, so roads come from the bbox and
 * crossing detection stays client-side in cordon.js.
 */

import {
  OVERPASS_URL,
  CORDON_MAX_BBOX_DEG,
  CORDON_BBOX_MARGIN_DEG,
  CORDON_ROADS_LIMIT,
} from './policy.js';
import {
  buildCordonRoadsQuery,
  normalizeCordonRoads,
  pickCordonBoundary,
  stitchOuterRing,
  ringBox,
} from './cordon.js';

/** Construct the bounded cordon fetch adapter without starting a request. */
export function createCordonSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function overpass(query, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      throw new Error(
        response.status === 429
          ? 'Overpass rate-limited'
          : response.status === 504
            ? 'Overpass timed out'
            : 'Overpass temporarily unavailable',
      );
    }
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.elements) || payload.remark) {
      throw new Error('Overpass returned an incomplete response');
    }
    return payload;
  }

  /**
   * Everything computeCordon needs for the town enclosing {lat, lon}.
   * Throws with a user-facing message when no cordon-scale boundary exists.
   * @param {{lat:number, lon:number}} center
   * @param {{fetch:Function}} cameraSource - the layer's ALPR source
   * @param {AbortSignal} [signal]
   */
  async function analyze({ lat, lon }, cameraSource, signal) {
    const admin = await overpass(
      `[out:json][timeout:25];is_in(${lat},${lon})->.a;area.a["boundary"="administrative"]["admin_level"];out tags;`,
      signal,
    );
    const candidates = pickCordonBoundary(admin.elements);
    if (!candidates.length)
      throw new Error('No town boundary is mapped at the view center');
    let town = null;
    let ring = null;
    let box = null;
    for (const candidate of candidates) {
      const geometry = await overpass(
        `[out:json][timeout:25];area(${candidate.id})->.x;rel(pivot.x);out geom;`,
        signal,
      );
      const relation = geometry.elements.find((el) => el.type === 'relation');
      const candidateRing = relation ? stitchOuterRing(relation) : [];
      if (candidateRing.length < 4) continue;
      const candidateBox = ringBox(candidateRing);
      if (
        candidateBox.north - candidateBox.south > CORDON_MAX_BBOX_DEG ||
        candidateBox.east - candidateBox.west > CORDON_MAX_BBOX_DEG
      )
        continue;
      town = candidate;
      ring = candidateRing;
      box = candidateBox;
      break;
    }
    if (!town)
      throw new Error(
        'The boundary here is too large for a cordon — zoom into a town',
      );
    const padded = {
      south: box.south - CORDON_BBOX_MARGIN_DEG,
      west: box.west - CORDON_BBOX_MARGIN_DEG,
      north: box.north + CORDON_BBOX_MARGIN_DEG,
      east: box.east + CORDON_BBOX_MARGIN_DEG,
    };
    const roadsPayload = await overpass(buildCordonRoadsQuery(padded), signal);
    const cameraSnapshot = await cameraSource.fetch(padded, signal);
    return {
      name: town.name,
      level: town.level,
      ring,
      box: padded,
      roads: normalizeCordonRoads(roadsPayload),
      cameras: cameraSnapshot.records,
      // Either truncation makes the share an under/over-estimate; the UI
      // must say so rather than present a confident number.
      truncated:
        cameraSnapshot.saturated ||
        roadsPayload.elements.length >= CORDON_ROADS_LIMIT,
    };
  }
  return { analyze };
}
