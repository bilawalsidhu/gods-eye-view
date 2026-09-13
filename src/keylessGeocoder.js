/** Photon/OpenStreetMap place-search adapter. */
const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';

/** Photon is a courtesy service; fail fast rather than hold the search open. */
const PHOTON_TIMEOUT_MS = 6000;

/** Bounded memo — a search box re-issues the same query on every keystroke. */
const PHOTON_CACHE_MAX = 64;

/**
 * Candidates requested per pass. One is not enough: proximity bias reorders the
 * list, so the name actually asked for can sit below a nearer near-miss.
 */
const PHOTON_RESULT_LIMIT = 5;
const photonCache = new Map();

/**
 * Photon's own coarse class → the Google Place Type `geocodeNavigationMode`
 * reads. Only types that function consults are worth emitting; anything else
 * falls through to `precise-place`, which is the correct default for a house
 * or a POI.
 */
const PHOTON_TYPE_TO_GOOGLE = Object.freeze({
  country: 'country',
  state: 'administrative_area_level_1',
  county: 'administrative_area_level_2',
  city: 'locality',
  district: 'sublocality',
  locality: 'locality',
  street: 'route',
});

/**
 * OSM `key=value` → Google Place Type. `null` means "this tag is a precise
 * place" and, like any other entry, stops the coarse class from being consulted.
 *
 * Two failure directions matter, and both were found by querying the live
 * service rather than by reasoning about OSM tagging:
 *
 * - Too coarse: a park or lake that arrives without an area type frames at
 *   building range, which is the exact bug `geocodeNavigationMode`'s area types
 *   exist to prevent — searching "Ho Guom" put the camera 26 m over the water.
 * - Too broad: Photon classifies a town square as `type: 'locality'`, so
 *   deferring to the coarse class frames Times Square as if it were a city.
 *   The explicit `null` below is what stops that.
 */
const OSM_TAG_TO_GOOGLE = Object.freeze({
  'leisure=park': 'park',
  'leisure=nature_reserve': 'park',
  'leisure=garden': 'park',
  'leisure=stadium': 'stadium',
  'boundary=national_park': 'park',
  'boundary=protected_area': 'park',
  'tourism=zoo': 'zoo',
  'tourism=theme_park': 'amusement_park',
  'amenity=university': 'university',
  'amenity=college': 'university',
  'amenity=grave_yard': 'cemetery',
  'landuse=cemetery': 'cemetery',
  'landuse=forest': 'natural_feature',
  'aeroway=aerodrome': 'airport',
  'shop=mall': 'shopping_mall',
  'place=region': 'natural_feature',
  'place=suburb': 'sublocality',
  'place=neighbourhood': 'sublocality',
  'place=quarter': 'sublocality',
  'place=borough': 'sublocality',
  'place=square': null,
});

/**
 * OSM keys whose features are areas whatever their value — lakes, rivers,
 * peaks, woods, protected land. Photon reports every one of these with
 * `type: 'other'`, so the key is the only signal that they are not buildings.
 */
const AREA_OSM_KEYS = Object.freeze(
  new Set(['natural', 'water', 'waterway', 'landuse']),
);

/**
 * Google-style types for one Photon feature's properties.
 *
 * A specific `key=value` mapping is authoritative and ends the lookup; the
 * coarse `type` is consulted only when no tag rule matched. Deferring to the
 * coarse class after a tag rule is what mis-framed town squares as cities.
 * @param {object} properties - Photon feature `properties`.
 * @returns {string[]} Google Place Types, possibly empty (a precise place).
 */
export function photonResultTypes(properties) {
  const key = String(properties?.osm_key || '');
  const value = String(properties?.osm_value || '');
  const tag = `${key}=${value}`;

  if (Object.prototype.hasOwnProperty.call(OSM_TAG_TO_GOOGLE, tag)) {
    const mapped = OSM_TAG_TO_GOOGLE[tag];
    return mapped ? [mapped] : [];
  }
  if (AREA_OSM_KEYS.has(key)) return ['natural_feature'];
  if (key === 'highway') return ['route'];

  const coarse = PHOTON_TYPE_TO_GOOGLE[String(properties?.type || '')];
  return coarse ? [coarse] : [];
}

/**
 * Photon `extent` → the `{southwest,northeast}` bounds the flight code frames.
 * Photon orders it [west, north, east, south]; a naive [w,s,e,n] read produces
 * an inverted box that still looks like a valid viewport.
 * @param {number[]} extent - Photon `properties.extent`.
 * @returns {?{southwest:{lat:number,lng:number}, northeast:{lat:number,lng:number}}}
 */
export function photonExtentToBounds(extent) {
  if (!Array.isArray(extent) || extent.length !== 4) return null;
  const [west, north, east, south] = extent;
  if (![west, north, east, south].every(Number.isFinite)) return null;
  if (west > east) return null; // Wrapped bounds are omitted until framing supports them.
  if (Math.abs(north) > 90 || Math.abs(south) > 90) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
  return {
    southwest: { lat: Math.min(north, south), lng: Math.min(west, east) },
    northeast: { lat: Math.max(north, south), lng: Math.max(west, east) },
  };
}

/**
 * Human label for a Photon feature — its name plus the coarsest containing
 * places that are not already in the name, mirroring the single-line address
 * Google's `formatted_address` provides.
 * @param {object} properties - Photon feature `properties`.
 * @returns {string}
 */
export function photonResultLabel(properties) {
  const name = String(properties?.name || '').trim();
  const parts = [name];
  for (const field of ['district', 'city', 'state', 'country']) {
    const part = String(properties?.[field] || '').trim();
    if (part && !parts.includes(part)) parts.push(part);
  }
  return parts.filter(Boolean).join(', ');
}

/**
 * Photon GeoJSON feature → the normalized geocode result its callers consume.
 * Returns null for a feature without usable coordinates.
 *
 * `name` is carried alongside the composed `label` because two call sites want
 * different halves of the same answer: the search box shows the full label,
 * while the annotation resolver matches OSM features on the canonical name
 * alone. Deriving it here keeps one shape rather than two parsers of the same
 * string.
 *
 * `properties.country` is deliberately NOT re-exported. Photon answers in the
 * feature's own language ("Việt Nam", "日本", "Россия"), which no consumer in
 * this app can match; the composed label is the only honest use for it.
 * @param {object} feature - One entry of Photon's `features` array.
 * @returns {?{lat:number, lng:number, name:string, label:string,
 *   types:string[], viewport:?object}}
 */
export function normalizePhotonFeature(feature) {
  if (
    !Array.isArray(feature?.geometry?.coordinates) ||
    feature.geometry.type !== 'Point'
  )
    return null;
  const [lng, lat] = feature.geometry.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const properties = feature.properties || {};
  const name = String(properties.name || '');
  return {
    lat,
    lng,
    name,
    label: photonResultLabel(properties) || name,
    types: photonResultTypes(properties),
    viewport: photonExtentToBounds(properties.extent),
  };
}

/**
 * Photon request URL for one query.
 *
 * `bias` is the SAME `"swLat,swLng|neLat,neLng"` string `viewportBias()` builds
 * for the Google call, so the two paths cannot drift apart — but it is sent as
 * Photon's `lat`/`lon` PROXIMITY bias, not as `bbox`.
 *
 * That distinction is the whole correctness of this function. Google's `bounds`
 * prefers results inside the box and still returns ones outside it; Photon's
 * `bbox` is a hard filter. Translating the rectangle literally makes every
 * search for somewhere off-screen return nothing — searching "Ho Guom, Ha Noi"
 * while looking at Austin answers `features: []`. Sent as `lat`/`lon` it finds
 * Hoan Kiem Lake, while "Sixth Street" still resolves to Austin's over Austin
 * and to England's over London. Soft bias is the semantics Google gives, so
 * soft bias is what the adapter must produce.
 * @param {string} query - Free-text place name.
 * @param {{bias?: ?string, limit?: number}} [options]
 * @returns {string}
 */
export function photonSearchUrl(
  query,
  { bias = null, limit = PHOTON_RESULT_LIMIT } = {},
) {
  const url = new URL(PHOTON_ENDPOINT);
  url.searchParams.set('q', String(query ?? ''));
  url.searchParams.set('limit', String(limit));

  const corners = String(bias ?? '').split('|');
  if (corners.length === 2) {
    const [swLat, swLng] = corners[0].split(',').map(Number);
    const [neLat, neLng] = corners[1].split(',').map(Number);
    if ([swLat, swLng, neLat, neLng].every(Number.isFinite)) {
      url.searchParams.set('lat', String((swLat + neLat) / 2));
      url.searchParams.set('lon', String((swLng + neLng) / 2));
    }
  }
  return url.toString();
}

/**
 * Place name reduced to comparable form: unaccented, lowercased, punctuation
 * collapsed to single spaces. "Huế" and "Hue" have to compare equal, because a
 * user typing either means the same city.
 * @param {string} text
 * @returns {string}
 */
export function normalizeToponym(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Pick the candidate whose name actually answers `target`.
 *
 * Matching leads rather than merely contains: "Hue" must select `Huế` and not
 * `Nguyen Hue Road`, which contains the word but names a different thing.
 * `allowContains` relaxes that to a substring match, used only as a second
 * choice once no candidate leads with the name.
 * @param {object[]} features - Photon features, in the order returned.
 * @param {string} target - Normalized name being looked for.
 * @param {{allowContains?: boolean}} [options]
 * @returns {?object}
 */
export function selectPhotonFeature(
  features,
  target,
  { allowContains = false } = {},
) {
  if (!target) return null;
  const names = (Array.isArray(features) ? features : []).map((feature) => [
    feature,
    normalizeToponym(feature?.properties?.name),
  ]);

  for (const [feature, name] of names) {
    if (name === target || name.startsWith(`${target} `)) return feature;
  }
  if (!allowContains) return null;
  for (const [feature, name] of names) {
    if (name.includes(target)) return feature;
  }
  return null;
}

/** Evict the oldest memo entries until the cache is within its cap. */
function trimPhotonCache(cache) {
  while (cache.size > PHOTON_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Geocode a place name without any API key, reporting whether the service
 * ANSWERED as well as what it found.
 *
 * A caller that remembers negative results needs both halves. "Photon has no
 * such place" is a verdict and may be cached; "Photon did not reply" is a
 * network blip, and caching THAT keeps the app answering "not found" from
 * memory long after the network came back — a whole session, for a key that
 * would now resolve. Conflating the two is the defect this app already had to
 * repair once in the Overpass disk cache, where refusals were persisted with
 * normal data TTLs.
 *
 * Caller cancellation throws; provider failure, timeout and empty results yield a null
 * `place`, which the caller reads exactly as it reads a Google miss.
 * @param {string} query - Free-text place name.
 * @param {{bias?: ?string, fetchImpl?: Function}} [options]
 * @returns {Promise<{place: ?{lat:number, lng:number, name:string, label:string,
 *   types:string[], viewport:?object}, answered:boolean}>}
 */
export async function geocodeKeylessWithOutcome(
  query,
  { bias = null, fetchImpl = fetch, signal, cache = photonCache } = {},
) {
  signal?.throwIfAborted();
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return { place: null, answered: true };

  const memoKey = `${bias ?? ''}\n${trimmed}`;
  // Only answered outcomes are memoised, so a hit is always an answer.
  const cached = cache.get(memoKey);
  if (cached && cached.expires > Date.now())
    return { place: cached.place, answered: true };
  cache.delete(memoKey);

  /** One request: the feature array Photon returned, or null if it did not answer. */
  const ask = async (url) => {
    try {
      signal?.throwIfAborted();
      const deadline = AbortSignal.timeout(PHOTON_TIMEOUT_MS);
      const requestSignal = signal
        ? AbortSignal.any([signal, deadline])
        : deadline;
      const response = await fetchImpl(url, { signal: requestSignal });
      if (!response.ok) return null;
      const data = await response.json();
      requestSignal.throwIfAborted();
      if (!Array.isArray(data?.features)) return null;
      if (data.features.some((feature) => !normalizePhotonFeature(feature)))
        return null;
      return data.features;
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  };

  // Bias decides WHICH match wins, never WHAT counts as a match. Photon scores
  // proximity against the name, so from Austin "Huế" came back as Hutto, Texas
  // and "Hạ Long" as Long Branch — near misses beating the exact name by
  // distance alone. Measured over twelve Vietnamese place names, three resolved
  // to the wrong continent. So a biased answer is only accepted when it leads
  // with the name asked for; otherwise the same query runs unbiased, which is
  // what a user searching for somewhere off-screen meant in the first place.
  let feature = null;
  let everyAskAnswered = true;
  if (bias) {
    const biased = await ask(photonSearchUrl(trimmed, { bias }));
    if (biased === null) everyAskAnswered = false;
    else feature = selectPhotonFeature(biased, normalizeToponym(trimmed));
  }

  signal?.throwIfAborted();
  if (!feature) {
    const anywhere = await ask(photonSearchUrl(trimmed, { bias: null }));
    if (anywhere === null) everyAskAnswered = false;
    else {
      // "Hoan Kiem Lake, Hanoi" names a place and then the region holding it, the
      // convention every geocoder's free-text field follows. The head segment is
      // the thing being searched for; the tail only says where to look.
      const head = normalizeToponym(trimmed.split(',')[0]);
      feature =
        selectPhotonFeature(anywhere, head, { allowContains: true }) ||
        anywhere[0];
    }
  }

  signal?.throwIfAborted();
  const place = normalizePhotonFeature(feature);
  // A found place is self-evidently an answer; a null one only counts as an
  // answer when every request it rests on actually came back.
  const answered = Boolean(place) || everyAskAnswered;

  // Answered misses are cached too: a typo re-issued on every keystroke should
  // cost one request, not one per stroke. Unanswered ones are not, so the next
  // attempt retries instead of replaying a network blip.
  if (answered) {
    cache.set(memoKey, {
      place,
      expires: Date.now() + (place ? 300_000 : 30_000),
    });
    trimPhotonCache(cache);
  }
  return { place, answered };
}

/**
 * Geocode a place name without any API key. Cancellation throws; network failure, a
 * timeout, or an empty result all resolve to null, which the caller reads as
 * "not found" exactly as it reads a Google miss.
 * @param {string} query - Free-text place name.
 * @param {{bias?: ?string, fetchImpl?: Function}} [options]
 * @returns {Promise<?{lat:number, lng:number, name:string, label:string, types:string[],
 *   viewport:?object}>}
 */
export async function geocodeKeyless(query, options) {
  return (await geocodeKeylessWithOutcome(query, options)).place;
}

/** Construct an independent Photon provider with a bounded query cache. */
export function createPhotonGeocoder({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const cache = new Map();
  return {
    geocode: (query, options = {}) =>
      geocodeKeylessWithOutcome(query, { ...options, fetchImpl, cache }),
  };
}
