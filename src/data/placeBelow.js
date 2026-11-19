/**
 * What a ground point is over, offline: on land the country (Natural Earth
 * admin-0) and its first-level division (admin-1: "Sichuan, China"), plus,
 * when asked for a radius, the most prominent populated place within it
 * ("near Chengdu"); else the smallest named sea, gulf, strait, channel,
 * sound or bay, else the ocean (`marine.json` carries the seven oceans).
 * Bays narrower than a satellite frame cares about — fjords, lagoons,
 * inlets, reefs and rivers — are skipped, so a pass reads "Bay of Bengal",
 * not a harbour.
 *
 * PURE data module: no Cesium, node-testable. Each pack loads lazily on the
 * first lookup that needs it (divisions on the first land hit, places on the
 * first radius) and is indexed once, and the loading status names them while
 * one is on its way (`placePacksStatus`); a country's division rings are decoded
 * the first time a point falls inside it. A failed load is retried later
 * (see `createRetryableLoader`). No network.
 */

import { loadBundledJson } from './bundledJson.js';
import { createRetryableLoader } from './retryableLoad.js';
import { containsAnchor, decodeRing } from './adminBoundaries.js';
import { greatCircleKm } from '../geoDistance.js';

/** Marine feature classes named as the place below; oceans come last. */
const MARINE_KINDS = new Set([
  'sea',
  'gulf',
  'strait',
  'channel',
  'sound',
  'bay',
]);

const PACKS = {
  countries: new URL(
    './local_data/natural_earth/countries.json',
    import.meta.url,
  ),
  marine: new URL('./local_data/natural_earth/marine.json', import.meta.url),
  divisions: new URL(
    './local_data/natural_earth/states_provinces.json',
    import.meta.url,
  ),
  places: new URL(
    './local_data/natural_earth/populated_places.json',
    import.meta.url,
  ),
};

/**
 * The packs on their way now, and those that failed in the current load (or
 * the last one): a load starts with no failures, so a retry that lands is
 * not blamed for a pack that failed before. (A load that does not need the
 * failed pack clears it too; the next lookup that needs it tries it again.)
 */
const loadingPacks = new Set();
const failedPacks = new Set();
// One lookup loads its packs one after another (countries and seas, then
// divisions, then places): the status holds them as one load until the
// lookup ends, rather than ending and starting a batch between packs.
let lookupsInFlight = 0;
let lookupLoaded = false;
const loadingListeners = new Set();

function notifyLoading() {
  for (const listener of [...loadingListeners]) {
    try {
      listener();
    } catch {
      /* A status listener never breaks a lookup. */
    }
  }
}

/** Whether the status shows a load on its way. */
function loadingNow() {
  return loadingPacks.size > 0 || (lookupLoaded && lookupsInFlight > 0);
}

/**
 * A pack load that the loading status follows: on its way while it runs,
 * and failed, if it fails, until the next load starts.
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} load
 * @returns {() => Promise<T>}
 */
export function reportedPlacePackLoad(name, load) {
  return async () => {
    // A fresh load forgets earlier failures: it ends on what it loads.
    if (!loadingNow()) failedPacks.clear();
    if (lookupsInFlight > 0) lookupLoaded = true;
    loadingPacks.add(name);
    notifyLoading();
    try {
      return await load();
    } catch (error) {
      failedPacks.add(name);
      throw error;
    } finally {
      loadingPacks.delete(name);
      notifyLoading();
    }
  };
}

/**
 * The place packs' state for the loading status. The packs load lazily, on
 * the first lookup that needs them, so the status says so meanwhile, and
 * says when one would not load.
 * @returns {{loading: boolean, failed: boolean}}
 */
export function placePacksStatus() {
  return {
    loading: loadingNow(),
    failed: failedPacks.size > 0,
  };
}

/**
 * Hear each start and end of a place pack load.
 * @param {() => void} listener
 * @returns {() => void} Stops listening.
 */
export function onPlacePacksLoadingChange(listener) {
  loadingListeners.add(listener);
  return () => loadingListeners.delete(listener);
}

/** Test seam: count pack loads (lazy-loading contract). */
export const placePackLoads = { divisions: 0, places: 0 };

/** The zoom from which the view names the populated place it shows. */
export const NEAR_PLACE_MIN_ZOOM = 8;

/**
 * How far from the sub-satellite point a populated place may lie and still
 * be named: half the view's smaller ground dimension from
 * NEAR_PLACE_MIN_ZOOM on, so the place is in the picture whichever way it
 * lies; null below it or without a size.
 * @param {number} zoom Optical zoom.
 * @param {number} widthKm The view's ground width, km.
 * @param {number} [heightKm] The view's ground height, km; the width when
 *   not given.
 * @returns {number|null}
 */
export function nearPlaceRadiusKm(zoom, widthKm, heightKm = widthKm) {
  if (!(zoom >= NEAR_PLACE_MIN_ZOOM)) return null;
  const smallerKm = Math.min(widthKm, heightKm);
  return Number.isFinite(smallerKm) && smallerKm > 0 ? smallerKm / 2 : null;
}

/** Shortest wait between two lookups, ms. */
export const PLACE_LOOKUP_MIN_MS = 2000;
/** Ground travel that makes a fresh lookup worth it, km. */
export const PLACE_LOOKUP_MIN_MOVE_KM = 20;

function boxOf(parts) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const part of parts)
    for (const ring of part)
      for (const [lon, lat] of ring) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
  return [west, south, east, north];
}

function inBox([west, south, east, north], lat, lon) {
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

/** Planar ring area in degrees², shrunk by cos(latitude): enough to rank. */
function ringRank(ring) {
  let sum = 0;
  let latSum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    latSum += ring[i][1];
  }
  const meanLat = ring.length ? latSum / ring.length : 0;
  return (Math.abs(sum) / 2) * Math.cos((meanLat * Math.PI) / 180);
}

async function readPlaces() {
  const [countries, marine] = await Promise.all([
    loadBundledJson(PACKS.countries),
    loadBundledJson(PACKS.marine),
  ]);
  const decimals = countries.meta?.decimals ?? 3;
  const land = [];
  for (const feature of countries.features || []) {
    const parts = (feature.polygons || []).map((part) =>
      part.map((ring) => decodeRing(ring, decimals)),
    );
    if (!parts.length) continue;
    land.push({
      name: feature.name,
      // Natural Earth writes -99 for units without an ISO code.
      countryCode: /^[A-Z]{2}$/.test(feature.iso2 || '') ? feature.iso2 : null,
      parts,
      box: boxOf(parts),
    });
  }
  const water = [];
  for (const feature of marine.features || []) {
    const kind = feature.featurecla;
    if (kind !== 'ocean' && !MARINE_KINDS.has(kind)) continue;
    // Marine rings are stored outer-only and plain [lon, lat].
    const parts = (feature.polygons || []).map((ring) => [ring]);
    if (!parts.length) continue;
    water.push({
      name: feature.name,
      kind: kind === 'ocean' ? 'ocean' : 'sea',
      parts,
      box: boxOf(parts),
      rank: parts.reduce((sum, [ring]) => sum + ringRank(ring), 0),
    });
  }
  return { land, water };
}
const loadPlaces = createRetryableLoader(
  reportedPlacePackLoad('places', readPlaces),
);

/** Divisions grouped by country code; rings decoded per country on demand. */
async function readDivisions() {
  placePackLoads.divisions += 1;
  const pack = await loadBundledJson(PACKS.divisions);
  const decimals = pack.meta?.decimals ?? 3;
  const byCountry = new Map();
  for (const feature of pack.features || []) {
    if (!feature.name || !/^[A-Z]{2}$/.test(feature.iso2 || '')) continue;
    const list = byCountry.get(feature.iso2) || [];
    list.push({ feature, decimals: feature.d ?? decimals });
    byCountry.set(feature.iso2, list);
  }
  return { byCountry, decoded: new Map() };
}
const loadDivisions = createRetryableLoader(
  reportedPlacePackLoad('divisions', readDivisions),
);

/** The first-level division holding a point inside country `code`, or null. */
async function divisionAt(code, lat, lon) {
  if (!code) return null;
  const { byCountry, decoded } = await loadDivisions();
  let units = decoded.get(code);
  if (!units) {
    units = (byCountry.get(code) || []).map(({ feature, decimals }) => {
      const parts = (feature.polygons || []).map((part) =>
        part.map((ring) => decodeRing(ring, decimals)),
      );
      return { name: feature.name, parts, box: boxOf(parts) };
    });
    decoded.set(code, units);
  }
  for (const unit of units)
    if (inBox(unit.box, lat, lon) && containsAnchor(unit.parts, lat, lon))
      return unit.name;
  return null;
}

async function readPopulatedPlaces() {
  placePackLoads.places += 1;
  const pack = await loadBundledJson(PACKS.places);
  return (pack.places || []).filter(
    (row) =>
      Array.isArray(row) &&
      row[0] &&
      Number.isFinite(row[1]) &&
      Number.isFinite(row[2]),
  );
}
const loadPopulatedPlaces = createRetryableLoader(
  reportedPlacePackLoad('populated-places', readPopulatedPlaces),
);

/**
 * The most prominent populated place within `radiusKm` of a point (lowest
 * Natural Earth scalerank, then the larger population class, then the
 * nearer), or null.
 * @returns {Promise<string|null>}
 */
export async function nearPlace(lat, lon, radiusKm) {
  if (!(radiusKm > 0) || !Number.isFinite(lat) || !Number.isFinite(lon))
    return null;
  const places = await loadPopulatedPlaces();
  const latSpan = radiusKm / 111;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const lonSpan = cosLat > 0.01 ? latSpan / cosLat : 360;
  let best = null;
  for (const [name, pLat, pLon, scalerank, rankMax] of places) {
    if (Math.abs(pLat - lat) > latSpan) continue;
    const dLon = Math.abs(((((pLon - lon + 180) % 360) + 360) % 360) - 180);
    if (dLon > lonSpan) continue;
    const km = greatCircleKm({ lat, lon }, { lat: pLat, lon: pLon });
    if (km > radiusKm) continue;
    if (
      !best ||
      scalerank < best.scalerank ||
      (scalerank === best.scalerank &&
        (rankMax > best.rankMax || (rankMax === best.rankMax && km < best.km)))
    )
      best = { name, scalerank, rankMax, km };
  }
  return best ? best.name : null;
}

/** The division and near-place lookups `placeBelow` adds on land. */
const DETAIL_LOOKUPS = Object.freeze({ division: divisionAt, near: nearPlace });

/** A detail lookup's answer, or null when it (its pack) fails. */
async function orNull(lookup) {
  try {
    return (await lookup()) ?? null;
  } catch {
    return null;
  }
}

/**
 * The place under a ground point.
 * @param {number} latitude Degrees.
 * @param {number} longitude Degrees, any wrap.
 * @param {{nearKm?: number|null, detail?: {division: Function,
 *   near: Function}}} [options] On land, also name the most prominent
 *   populated place within `nearKm` (`nearPlaceRadiusKm`). `detail` replaces
 *   the division and near-place lookups (a test seam).
 * @returns {Promise<{kind: 'country'|'sea'|'ocean', name: string,
 *   countryCode: string|null, division?: string|null,
 *   near?: string|null}|null>} A country carries its first-level `division`
 *   and the `near` place (each null when none, or when its pack failed to
 *   load: the country still stands); a sea or ocean neither. Null when no
 *   feature holds the point (a coastline gap left by the packs'
 *   simplification) or it is invalid. Rejects only when the country and
 *   marine packs fail.
 */
export async function placeBelow(latitude, longitude, options) {
  lookupsInFlight += 1;
  try {
    return await findPlaceBelow(latitude, longitude, options);
  } finally {
    lookupsInFlight -= 1;
    if (lookupsInFlight === 0 && lookupLoaded) {
      lookupLoaded = false;
      notifyLoading();
    }
  }
}

async function findPlaceBelow(
  latitude,
  longitude,
  { nearKm = null, detail = DETAIL_LOOKUPS } = {},
) {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90
  )
    return null;
  const lon = ((((longitude + 180) % 360) + 360) % 360) - 180;
  const { land, water } = await loadPlaces();
  for (const entry of land) {
    if (
      inBox(entry.box, latitude, lon) &&
      containsAnchor(entry.parts, latitude, lon)
    )
      return {
        kind: 'country',
        name: entry.name,
        countryCode: entry.countryCode,
        division: await orNull(() =>
          detail.division(entry.countryCode, latitude, lon),
        ),
        near: await orNull(() => detail.near(latitude, lon, nearKm)),
      };
  }
  let best = null;
  for (const entry of water) {
    if (best && entry.rank >= best.rank) continue;
    if (
      inBox(entry.box, latitude, lon) &&
      containsAnchor(entry.parts, latitude, lon)
    )
      best = entry;
  }
  return best ? { kind: best.kind, name: best.name, countryCode: null } : null;
}

/**
 * Whether two radii ask for the same detail: both off, or within 20% (a
 * zoom step at least halves the view; altitude drift moves it far less).
 */
function sameRadius(a, b) {
  if (a === null || b === null) return a === b;
  return Math.max(a, b) / Math.min(a, b) < 1.2;
}

/**
 * Keep the place below a moving ground point current without a lookup per
 * frame: a new lookup once at least `minIntervalMs` has passed AND the point
 * has moved `minMoveKm` (a low orbit refreshes about every 2.6 s, a
 * geostationary one never after the first). A new `nearKm` radius (a zoom
 * step) looks up again at once. One lookup runs at a time; a result that
 * arrives after `reset()` is dropped. A failed lookup reports no place (the
 * old one would name ground the view has left) and lets the next update
 * look up again at once.
 * @param {{onPlace: (place: object|null) => void,
 *   lookup?: (lat: number, lon: number,
 *     options: {nearKm: number|null}) => Promise<object|null>,
 *   minIntervalMs?: number, minMoveKm?: number}} options
 */
export function createPlaceTracker({
  onPlace,
  lookup = placeBelow,
  minIntervalMs = PLACE_LOOKUP_MIN_MS,
  minMoveKm = PLACE_LOOKUP_MIN_MOVE_KM,
}) {
  let generation = 0;
  let inFlight = false;
  let last = null;
  return {
    /**
     * Offer the current ground point and the radius to name a place in.
     * @returns {boolean} True when a lookup started.
     */
    update(lat, lon, nowMs, nearKm = null) {
      if (inFlight || !Number.isFinite(lat) || !Number.isFinite(lon))
        return false;
      const radius = Number.isFinite(nearKm) && nearKm > 0 ? nearKm : null;
      if (
        last &&
        sameRadius(last.nearKm, radius) &&
        (nowMs - last.ms < minIntervalMs ||
          greatCircleKm(last, { lat, lon }) < minMoveKm)
      )
        return false;
      last = { lat, lon, ms: nowMs, nearKm: radius };
      inFlight = true;
      const token = generation;
      Promise.resolve()
        .then(() => lookup(lat, lon, { nearKm: radius }))
        .then(
          (place) => {
            if (token !== generation) return;
            inFlight = false;
            onPlace(place ?? null);
          },
          () => {
            if (token !== generation) return;
            inFlight = false;
            last = null;
            onPlace(null);
          },
        );
      return true;
    },
    /** Forget the point and drop any lookup still in flight. */
    reset() {
      generation += 1;
      inFlight = false;
      last = null;
    },
  };
}
