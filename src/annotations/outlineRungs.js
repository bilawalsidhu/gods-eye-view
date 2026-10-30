import {
  bufferCorridor,
  ringAreaM2,
  ringCentroid,
} from '../sources/featureGeometry.js';
import { isUnavailableCapability } from '../sources/capability.js';
import { polygonsContain } from '../data/adminBoundaries.js';
import {
  BUILDING_MAX_DISTANCE_M,
  OUTLINE_TILE_ZOOM,
  STREET_RADIUS_M,
  boxAround,
  buildingFromTiles,
  createOpenFreeMapOutlineSource,
  enclosingAreaFromTiles,
  groundsClassesFor,
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

/**
 * Whether polygons contain a point. A part whose outer ring crosses the
 * antimeridian ([179.99, …], [-179.99, …]) is read contiguously in its own
 * longitude frame, with the point moved into that frame; every other part,
 * including one genuinely wider than 180°, is tested as stored. Crossing is
 * read from an edge jumping more than 180°, which assumes densely noded rings
 * (OSM, Nominatim, tiles); a ring that is both wider than 180° and crossing, or
 * a non-crossing ring with a single edge over 180°, is not supported.
 */
export function containsAnchor(polygons, lat, lon) {
  if (!Number.isFinite(lon)) return false;
  for (const part of polygons || []) {
    const outer = part?.[0];
    if (!Array.isArray(outer) || !outer.length) continue;
    const reference = outer[0][0];
    const shift = (x) => x - 360 * Math.round((x - reference) / 360);
    const span = (ring, f) => {
      let west = Infinity;
      let east = -Infinity;
      for (const [x] of ring) {
        west = Math.min(west, f(x));
        east = Math.max(east, f(x));
      }
      return east - west;
    };
    // An edge jumping more than 180° wraps the line; a polar ring whose
    // edges run along ±180 collapses when reframed and is read as stored.
    const jumps = outer.some(
      ([x], i) => i > 0 && Math.abs(x - outer[i - 1][0]) > 180,
    );
    const framedSpan = jumps ? span(outer, shift) : 0;
    const crosses = framedSpan > 0 && framedSpan < 180;
    const framed = crosses
      ? part.map((ring) => ring.map(([x, y]) => [shift(x), y]))
      : part;
    if (polygonsContain([framed], lat, crosses ? shift(lon) : lon)) return true;
  }
  return false;
}

/**
 * Parts with the one holding the anchor outside its holes first. A boundary
 * can be largest at sea (Tokyo's island municipalities), so size alone does
 * not pick the part the ask is about; with no part holding the anchor, the
 * order is kept.
 */
export function anchorPartFirst(polygons, points) {
  for (const { lat, lon } of points) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const at = polygons.findIndex((polygon) =>
      containsAnchor([polygon], lat, lon),
    );
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
  };
}

// Rungs built without their own tiles share one outline source, so a second
// resolver instance cannot add another outline cache to the tile budget.
let defaultOutlineTiles = null;
const sharedOutlineTiles = () =>
  (defaultOutlineTiles ??= createOpenFreeMapOutlineSource());

export function createOutlineRungs({
  tiles = sharedOutlineTiles(),
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

  async function buildingRung(ctx, requireContainment = false) {
    const decoded = await tilesAround(
      ctx.lat,
      ctx.lon,
      BUILDING_MAX_DISTANCE_M * 2,
      ctx.signal,
    );
    const building = decoded && buildingFromTiles(decoded, ctx);
    if (!building || (requireContainment && building.contains !== true))
      return null;
    return {
      ring: building.ring,
      polygons: building.polygons,
      kind: 'building',
      heightM: building.heightM,
      synthesized: false,
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
        name: outlineQueryText(ctx.target || ctx.matchName),
        // The kind the ask names ("… School grounds") lets unnamed tile
        // landuse of that class answer; read before grounds words are cut.
        unnamedClasses: groundsClassesFor(ctx.target || ctx.matchName),
        minAreaM2: GROUNDS_MIN_AREA_M2,
      });
    if (!area || !containsAnchor(area.polygons, ctx.lat, ctx.lon)) return null;
    return {
      ring: area.ring,
      polygons: area.polygons,
      kind: 'area',
      heightM: null,
      synthesized: false,
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
    if (!outline?.polygons?.length) return outline; // null | undefined | unavailable | rateLimited
    // Named outlines must retain the resolved place's authority,
    // including holes; a nearby same-name polygon is not the selected place.
    if (!containsAnchor(outline.polygons, ctx.lat, ctx.lon)) return null;
    const polygons = anchorPartFirst(outline.polygons, [
      { lat: ctx.lat, lon: ctx.lon },
    ]);
    const ring = polygons[0][0];
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
    const accept = (fp, asScope = scope, provider) => {
      alive();
      if (!fp) return null;
      const patch = finish(fp, asScope);
      if (patch?.ring) {
        patch.outlineCredit = provider === 'openfreemap' ? 'tiles' : 'osm';
        ctx.credit?.(patch.outlineCredit);
        // One line per answered outline, like the resolver's own trace.
        console.log(
          `[Outline] "${ctx.target || ''}": scope=${asScope} → ${provider}` +
            ` (${patch.footprintKind}, ${patch.polygons?.length || 1} part(s))`,
        );
        return patch;
      }
      return null;
    };

    // Tiles first for streets and for a building pointed at rather than named.
    if (scope === 'street') {
      const street = accept(await streetRung(ctx), 'street', 'openfreemap');
      if (street) return street;
    } else if (scope === 'building' && !named && !ctx.around) {
      const building = accept(
        await buildingRung(ctx),
        'building',
        'openfreemap',
      );
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
        const patch = accept(
          found,
          ctx.groundsLike ? 'compound' : scope,
          'nominatim',
        );
        if (patch) return patch;
      } else if (found === undefined || found?.rateLimited) {
        retryLater = { value: found };
      }
    }

    // Grounds absent from the named lookup: a matching named tile area.
    if (ctx.groundsLike && named) {
      // Around the named building when Nominatim found it, else the anchor.
      let grounds = groundsSeed
        ? accept(await groundsRung(ctx, groundsSeed), 'compound', 'openfreemap')
        : null;
      grounds ||= accept(await groundsRung(ctx), 'compound', 'openfreemap');
      if (grounds) return grounds;
    }

    // A named building nobody outlined: the footprint holding its point. Never for
    // a grounds ask, where the building is the wrong shape.
    if (scope === 'building' && named && !ctx.around && !ctx.groundsLike) {
      const building = accept(
        await buildingRung(ctx, true),
        'building',
        'openfreemap',
      );
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
