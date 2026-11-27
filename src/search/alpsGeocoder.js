import { findNaturalRegion } from '../data/naturalEarthRegions.js';

/**
 * The unqualified Alps ask names the European range, not a same-named peak
 * or local POI. Keep this correction exact and Alps-only: other ranges and
 * geographic qualifiers retain the caller's configured geocoder semantics.
 */
export function createAlpsGeocoder({ lookupRegion = findNaturalRegion } = {}) {
  return {
    async geocode(query, { signal } = {}) {
      signal?.throwIfAborted();
      const name = String(query ?? '')
        .trim()
        .replace(/\s+/g, ' ');
      if (!/^(?:the )?alps(?: mountains)?$/i.test(name))
        return { place: null, answered: true };

      const region = await lookupRegion('Alps');
      signal?.throwIfAborted();
      // A broken pack is not permission to cache an unrelated network peak
      // as the canonical range. Existing search error/retry handling owns it.
      if (
        region?.name !== 'Alps' ||
        region.kind !== 'natural' ||
        !region.polygons?.length
      )
        throw new Error('Bundled Alps geometry unavailable');
      const vertices = region.polygons.flat();
      const west = Math.min(...vertices.map(([lon]) => lon));
      const east = Math.max(...vertices.map(([lon]) => lon));
      const south = Math.min(...vertices.map(([, lat]) => lat));
      const north = Math.max(...vertices.map(([, lat]) => lat));
      const lat = (south + north) / 2;
      const lng = (west + east) / 2;
      return {
        answered: true,
        place: {
          lat,
          lng,
          name: region.name,
          label: region.name,
          types: ['natural_feature'],
          exact: true,
          viewport: {
            southwest: { lat: south, lng: west },
            northeast: { lat: north, lng: east },
          },
        },
      };
    },
  };
}
