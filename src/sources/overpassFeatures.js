export {
  FEATURE_SOURCE_METHODS,
  requireFeatureSource,
} from './featureSource.js';
import { normalizeOverpassFeatures } from './overpassFeaturesRecords.js';

function validPoint(lat, lon) {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    throw new TypeError('Valid feature coordinates are required');
}

/** Query bounded feature candidates; ranking and rendering belong to callers.
 * Array = definitive response (possibly empty), null = retryable failure,
 * {rateLimited, retryAfterMs} = admission delay.
 */
export function createOverpassFeatureSource({
  boundarySource,
  signal: lifetime,
} = {}) {
  if (typeof boundarySource?.query !== 'function')
    throw new TypeError('A boundary query transport is required');
  async function query(
    text,
    timeoutMs,
    { signal, focus = false, relationsOnly = false } = {},
  ) {
    const controller = new AbortController();
    const signals = [lifetime, signal, controller.signal].filter(Boolean);
    const combined = AbortSignal.any(signals);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      combined.throwIfAborted();
      const elements = await boundarySource.query(text, { signal: combined });
      combined.throwIfAborted();
      return Array.isArray(elements)
        ? normalizeOverpassFeatures(
            relationsOnly
              ? elements.filter((element) => element.type === 'relation')
              : elements,
            { focus },
          )
        : elements;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    getFocusFootprints({ lat, lon }, options = {}) {
      validPoint(lat, lon);
      return query(
        `
    [out:json][timeout:10];
    (
      way(around:180,${lat},${lon})["building"];
      relation(around:180,${lat},${lon})["building"];
      way(around:180,${lat},${lon})["man_made"];
      relation(around:180,${lat},${lon})["man_made"];
      way(around:180,${lat},${lon})["tourism"="attraction"];
      relation(around:180,${lat},${lon})["tourism"="attraction"];
    );
    out tags center geom;
  `,
        6000,
        { ...options, focus: true },
      );
    },
    getAdministrativeAreas({ lat, lon }, options = {}) {
      validPoint(lat, lon);
      return query(
        `[out:json][timeout:25];is_in(${lat},${lon})->.a;area.a["boundary"="administrative"]["admin_level"];out tags;`,
        14000,
        options,
      );
    },
    getAreaGeometry(id, options = {}) {
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new TypeError('Invalid feature geometry reference');
      return query(
        `[out:json][timeout:25];area(${id})->.x;rel(pivot.x);out geom;`,
        28000,
        { ...options, relationsOnly: true },
      );
    },
    getNeighborhoodAreas({ lat, lon }, options = {}) {
      validPoint(lat, lon);
      return query(
        `[out:json][timeout:20];(` +
          `way(around:1500,${lat},${lon})["place"~"neighbourhood|suburb|quarter|borough"]["name"];` +
          `relation(around:1500,${lat},${lon})["place"~"neighbourhood|suburb|quarter|borough"]["name"];` +
          `relation(around:1500,${lat},${lon})["boundary"="place"]["name"];` +
          `);out tags geom;`,
        14000,
        options,
      );
    },
    getStreetAreas({ lat, lon }, options = {}) {
      validPoint(lat, lon);
      return query(
        `[out:json][timeout:20];(` +
          `way(around:450,${lat},${lon})["place"~"quarter|neighbourhood|suburb|city_block"];` +
          `relation(around:450,${lat},${lon})["place"~"quarter|neighbourhood|suburb"];` +
          `way(around:450,${lat},${lon})["landuse"~"commercial|retail"]["name"];` +
          `relation(around:450,${lat},${lon})["landuse"~"commercial|retail"]["name"]["type"="multipolygon"];` +
          `);out tags geom;`,
        14000,
        options,
      );
    },
    getStreetLines({ lat, lon }, options = {}) {
      validPoint(lat, lon);
      return query(
        `[out:json][timeout:20];way(around:320,${lat},${lon})["highway"]["name"];out geom;`,
        14000,
        options,
      );
    },
    getFootprints({ lat, lon }, options = {}) {
      validPoint(lat, lon);
      return query(
        `
    [out:json][timeout:25];
    (
      way(around:320,${lat},${lon})["building"];
      relation(around:320,${lat},${lon})["building"];
      way(around:1800,${lat},${lon})["landuse"];
      relation(around:1800,${lat},${lon})["landuse"];
      way(around:1800,${lat},${lon})["leisure"];
      relation(around:1800,${lat},${lon})["leisure"];
      way(around:1800,${lat},${lon})["aeroway"="aerodrome"];
      relation(around:1800,${lat},${lon})["aeroway"="aerodrome"];
      way(around:1800,${lat},${lon})["natural"="water"]["name"];
      relation(around:1800,${lat},${lon})["natural"="water"]["name"]["type"="multipolygon"];
      way(around:1200,${lat},${lon})["shop"="mall"];
      relation(around:1200,${lat},${lon})["shop"="mall"];
      way(around:800,${lat},${lon})["amenity"];
      way(around:800,${lat},${lon})["tourism"];
    );
    out geom;
  `,
        12000,
        options,
      );
    },
    getEnclosingAreas({ lat, lon }, options = {}) {
      validPoint(lat, lon);
      return query(
        `
    [out:json][timeout:25];
    (
      way(around:${600},${lat},${lon})["leisure"]["name"];
      relation(around:${600},${lat},${lon})["leisure"]["name"]["type"="multipolygon"];
      way(around:${600},${lat},${lon})["landuse"]["name"];
      relation(around:${600},${lat},${lon})["landuse"]["name"]["type"="multipolygon"];
      way(around:${600},${lat},${lon})["boundary"]["name"];
      relation(around:${600},${lat},${lon})["boundary"]["name"];
      way(around:${600},${lat},${lon})["amenity"]["name"];
      relation(around:${600},${lat},${lon})["amenity"]["name"]["type"="multipolygon"];
      way(around:${600},${lat},${lon})["natural"="water"]["name"];
      relation(around:${600},${lat},${lon})["natural"="water"]["name"]["type"="multipolygon"];
    );
    out geom;
  `,
        12000,
        options,
      );
    },
    getMonuments({ lat, lon }, options = {}) {
      validPoint(lat, lon);
      return query(
        `
        [out:json][timeout:20];
        (
          nwr(around:${2500},${lat},${lon})["historic"~"memorial|monument|statue|tomb"];
          nwr(around:${2500},${lat},${lon})["tourism"="artwork"]["name"];
          nwr(around:${2500},${lat},${lon})["memorial"]["name"];
        );
        out center tags;
      `,
        6000,
        options,
      );
    },
  };
}
