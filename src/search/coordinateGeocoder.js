import { parseCoordinateQuery } from './coordinateParser.js';

/** Half-width of the box a bare coordinate is framed with, in degrees. */
const COORDINATE_HALF_SPAN_DEG = 0.015;

/** Keep a generated box inside the poles and inside the dateline. */
function boundedBox(lat, lon, halfSpan) {
  const wrap = (value) => {
    const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
    return wrapped === -180 ? 180 : wrapped;
  };
  return {
    southwest: {
      lat: Math.max(-90, lat - halfSpan),
      lng: wrap(lon - halfSpan),
    },
    northeast: {
      lat: Math.min(90, lat + halfSpan),
      lng: wrap(lon + halfSpan),
    },
  };
}

/**
 * Answer a decimal-degree query without asking anyone.
 *
 * It sits ahead of the network geocoders, so a coordinate costs no request and
 * works with no key. Anything that is not exactly a coordinate is passed on
 * untouched, and `answered: true` on a decline means only that this provider
 * had nothing to say — it is not a verdict on the query.
 */
export function createCoordinateGeocoder() {
  return {
    async geocode(query, { signal } = {}) {
      signal?.throwIfAborted();
      const parsed = parseCoordinateQuery(query);
      if (!parsed) return { place: null, answered: true };
      return {
        place: {
          lat: parsed.lat,
          lng: parsed.lon,
          name: parsed.label,
          label: parsed.label,
          types: ['coordinate'],
          // The point is the answer; nothing nearby can improve on it.
          exact: true,
          viewport: boundedBox(
            parsed.lat,
            parsed.lon,
            COORDINATE_HALF_SPAN_DEG,
          ),
        },
        answered: true,
      };
    },
  };
}
