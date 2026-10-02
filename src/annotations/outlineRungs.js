import {
  bufferCorridor,
  ringAreaM2,
  ringCentroid,
} from '../sources/featureGeometry.js';
import { isUnavailableCapability } from '../sources/capability.js';
import {
  BUILDING_MAX_DISTANCE_M,
  OUTLINE_TILE_ZOOM,
  STREET_RADIUS_M,
  boxAround,
  buildingFromTiles,
  createOpenFreeMapOutlineSource,
  enclosingAreaFromTiles,
  streetFromTiles,
} from '../sources/openFreeMapOutlines.js';
import { createNominatimOutlineClient } from '../sources/nominatimOutlines.js';

/**
 * Outline rungs that need no Overpass, around the resolver's existing ladder:
 *
 *   bundled rungs (inside the base ladder)
 *   → OpenFreeMap tiles for streets and pointed-at buildings
 *   → operator Overpass, when configured (the base ladder, unchanged)
 *   → the server's guarded Nominatim outline (cities, landmarks, grounds,
 *     parks, lakes, campuses, named buildings)
 *   → OpenFreeMap building at the point, for a named building nobody outlined
 *   → the base answer: an honest point marked "outline unavailable".
 *
 * Every rung returns the resolver's footprint shape
 * `{ ring, polygons?, kind, heightM, synthesized }` and hands it to the
 * resolver's `finish`, which applies the scope caps and drift bound and
 * re-centres the anchor. Nothing here fetches without an explicit ask.
 */

/** Half-width (m) of the ribbon drawn along a street. */
const STREET_HALF_WIDTH_M = 11;

/** A Nominatim "grounds" answer smaller than this is a building, not grounds. */
const GROUNDS_MIN_AREA_M2 = 20_000;

/** Words that point at the thing rather than name it. */
const DEICTIC_RE =
  /^(?:(?:this|that|the|my)\s+)?(?:building|house|structure|tower|place|one|thing|spot|here|there|it)$/i;

/** Words that describe grounds rather than belong to the name searched. */
const GROUNDS_WORDS_RE =
  /\b(?:grounds|compound|campus|premises|property|site|area|complex)\b/gi;

/** Whether the ask names a thing (vs. "this building" at a pointer). */
export function isNamedAsk(target) {
  const text = String(target || '').trim();
  return Boolean(text) && !DEICTIC_RE.test(text) && /\p{L}/u.test(text);
}

/** The words sent to Nominatim: the ask without grounds words or articles. */
export function outlineQueryText(target) {
  return String(target || '')
    .replace(GROUNDS_WORDS_RE, ' ')
    .replace(/^\s*the\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Which Nominatim ask kind (if any) suits a resolver scope.
 * Neighbourhoods and streets are not sent: bundled packs and tiles own them.
 */
export function nominatimKindFor({ scope, groundsLike, pointLike, around }) {
  if (pointLike) return null;
  // "Around" asks get a buffer, except grounds: the grounds ARE the thing.
  if (around && !groundsLike) return null;
  if (scope === 'city') return 'city';
  if (scope === 'state' || scope === 'county' || scope === 'country')
    return 'admin';
  if (groundsLike) return 'landmark';
  if (scope === 'building') return 'building';
  if (scope === 'compound' || scope === 'auto') return 'landmark';
  return null;
}

/** Ray-cast test for a `[lon, lat]` ring. */
function ringHolds(ring, lat, lon) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/**
 * Parts with the one holding the anchor first. A boundary can be largest at
 * sea (Tokyo's island municipalities), so size alone does not pick the part
 * the ask is about; with no part holding the anchor, the order is kept.
 */
export function anchorPartFirst(polygons, points) {
  for (const { lat, lon } of points) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const at = polygons.findIndex(([outer]) => ringHolds(outer, lat, lon));
    if (at > 0) return [polygons[at], ...polygons.filter((_, i) => i !== at)];
    if (at === 0) return polygons;
  }
  return polygons;
}

/** Whether a base answer is final (a real outline, or "try again later"). */
function keepBase(result) {
  if (result === undefined) return true;
  if (result?.rateLimited === true) return true;
  if (isUnavailableCapability(result)) return false;
  return Boolean(result?.ring) && !result.synthesized;
}

/** Street polylines → one ribbon polygon per chain (longest first). */
export function streetFootprint(street) {
  const polygons = street.lines
    .filter((line) => line.length >= 2)
    .map((line) => [bufferCorridor(line, STREET_HALF_WIDTH_M)]);
  if (!polygons.length) return null;
  return {
    ring: polygons[0][0],
    polygons,
    lines: street.lines,
    kind: 'area',
    heightM: null,
    synthesized: false,
    outlineSource: 'openfreemap',
  };
}

export function createOutlineRungs({
  tiles = createOpenFreeMapOutlineSource(),
  nominatim = createNominatimOutlineClient(),
} = {}) {
  /** Decoded tiles around a point, or null when the tiles cannot be read. */
  async function tilesAround(lat, lon, radiusM, signal) {
    try {
      const { tiles: decoded } = await tiles.fetchBounds(
        boxAround(lat, lon, radiusM),
        { zoom: OUTLINE_TILE_ZOOM, signal },
      );
      return decoded;
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.name === 'AbortError') throw error;
      return null;
    }
  }

  async function streetRung(ctx) {
    const name = ctx.matchName || ctx.target;
    if (!isNamedAsk(name)) return null;
    const decoded = await tilesAround(
      ctx.lat,
      ctx.lon,
      STREET_RADIUS_M,
      ctx.signal,
    );
    if (!decoded) return null;
    const street = streetFromTiles(decoded, {
      name,
      lat: ctx.lat,
      lon: ctx.lon,
    });
    return street ? streetFootprint(street) : null;
  }

  async function buildingRung(ctx) {
    const decoded = await tilesAround(
      ctx.lat,
      ctx.lon,
      BUILDING_MAX_DISTANCE_M * 2,
      ctx.signal,
    );
    const building = decoded && buildingFromTiles(decoded, ctx);
    if (!building) return null;
    return {
      ring: building.ring,
      polygons: [building.rings],
      kind: 'building',
      heightM: building.heightM,
      synthesized: false,
      outlineSource: 'openfreemap',
    };
  }

  /** The open area enclosing `seed` (the named feature) or the anchor. */
  async function groundsRung(ctx, seed = null) {
    const at = seed || { lat: ctx.lat, lon: ctx.lon };
    const decoded = await tilesAround(at.lat, at.lon, 600, ctx.signal);
    const area =
      decoded &&
      enclosingAreaFromTiles(decoded, {
        lat: at.lat,
        lon: at.lon,
        minAreaM2: GROUNDS_MIN_AREA_M2,
      });
    if (!area) return null;
    return {
      ring: area.ring,
      polygons: [area.rings],
      kind: 'area',
      heightM: null,
      synthesized: false,
      outlineSource: 'openfreemap',
    };
  }

  async function nominatimRung(ctx, kind) {
    const query = outlineQueryText(
      kind === 'city' || kind === 'admin'
        ? ctx.matchName || ctx.target
        : ctx.target || ctx.matchName,
    );
    if (!isNamedAsk(query)) return null;
    const bias = ctx.view || { lat: ctx.lat, lon: ctx.lon };
    const outline = await nominatim.lookup(
      { query, kind, lat: bias.lat, lon: bias.lon },
      { signal: ctx.signal },
    );
    if (!outline?.polygons) return outline; // null | undefined | unavailable | rateLimited
    const polygons = anchorPartFirst(outline.polygons, [
      { lat: ctx.lat, lon: ctx.lon },
      outline.center || {},
    ]);
    const ring = polygons[0][0];
    // A grounds ask answered by a building-sized polygon is the dome, not the
    // grounds: report no grounds outline rather than the wrong shape.
    // A grounds ask answered by a building-sized polygon found the named
    // building, not its grounds: keep its position to find what encloses it.
    if (ctx.groundsLike && ringAreaM2(ring) < GROUNDS_MIN_AREA_M2)
      return { groundsSeed: ringCentroid(ring) };
    return {
      ring,
      polygons,
      kind:
        kind === 'building' || outline.class === 'building'
          ? 'building'
          : 'area',
      heightM: null,
      synthesized: false,
      outlineSource: 'nominatim',
      outlineName: outline.name,
    };
  }

  /**
   * Run the ladder for one resolved anchor.
   *
   * @param {object} ctx  scope, target, matchName, lat, lon, named anchor facts,
   *                      view centre, signal, and `credit(kind)`.
   * @param {{base: () => Promise<any>, finish: (fp: object, scope: string) => any}} ladder
   */
  async function resolve(ctx, { base, finish }) {
    const { scope } = ctx;
    const named = ctx.fromName && isNamedAsk(ctx.target);
    // A cancelled ask (board cleared, superseded) stops between rungs, so it
    // never spends a Nominatim request.
    const alive = () => ctx.signal?.throwIfAborted();
    const accept = (fp, asScope = scope) => {
      alive();
      if (!fp) return null;
      const patch = finish(fp, asScope);
      if (patch?.ring) {
        ctx.credit?.(fp.outlineSource === 'openfreemap' ? 'tiles' : 'osm');
        // One line per answered outline, like the resolver's own trace.
        console.log(
          `[Outline] "${ctx.target || ''}": scope=${asScope} → ${fp.outlineSource}` +
            ` (${patch.footprintKind}, ${patch.polygons?.length || 1} part(s))`,
        );
        return { ...patch, outlineSource: fp.outlineSource };
      }
      return null;
    };

    // Tiles first for streets and for a building pointed at rather than named.
    if (scope === 'street') {
      const street = accept(await streetRung(ctx), 'street');
      if (street) return street;
    } else if (scope === 'building' && !named && !ctx.around) {
      const building = accept(await buildingRung(ctx), 'building');
      if (building) return building;
    }

    alive();
    const baseResult = await base();
    alive();
    if (keepBase(baseResult)) return baseResult;

    // A transient or busy Nominatim answer is kept aside while the tile
    // fallbacks run; it is returned only if nothing else answers.
    let retryLater = null;
    let groundsSeed = null;
    const kind = named ? nominatimKindFor(ctx) : null;
    if (kind) {
      const found = await nominatimRung(ctx, kind);
      alive();
      if (found?.groundsSeed) {
        groundsSeed = found.groundsSeed;
      } else if (found?.ring) {
        const patch = accept(found, ctx.groundsLike ? 'compound' : scope);
        if (patch) return patch;
      } else if (found === undefined || found?.rateLimited) {
        retryLater = { value: found };
      }
    }

    // Grounds nobody named in a polygon: the open area enclosing the point.
    if (ctx.groundsLike && named) {
      // Around the named building when Nominatim found it, else the anchor.
      let grounds = groundsSeed
        ? accept(await groundsRung(ctx, groundsSeed), 'compound')
        : null;
      grounds ||= accept(await groundsRung(ctx), 'compound');
      if (grounds) return grounds;
    }

    // A named building nobody outlined: the footprint at its point. Never for
    // a grounds ask, where the building is the wrong shape.
    if (scope === 'building' && named && !ctx.around && !ctx.groundsLike) {
      const building = accept(await buildingRung(ctx), 'building');
      if (building) return building;
    }
    // Keep the mark retryable only when nothing else could answer. A
    // definitive miss or an approximation from the configured ladder stands
    // rather than inviting repeated lookups.
    if (retryLater && isUnavailableCapability(baseResult))
      return retryLater.value;
    return baseResult;
  }

  return { resolve };
}
