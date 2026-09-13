/**
 * Normalizes city or query string for loose matching.
 * @param {string} str
 * @returns {string}
 */
function normalizeText(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ');
}

/**
 * Creates an offline geocoder that matches bundled cities and prominent landmarks
 * from supplied presets with zero network calls and without requiring an API key.
 */
export function createPresetGeocoder({ presets = {} } = {}) {
  return {
    async geocode(query, { signal } = {}) {
      signal?.throwIfAborted();
      const q = normalizeText(query);
      if (!q || q.length < 2) return { place: null, answered: false };

      // 1. Check City Name matches (e.g. "london", "austin", "sf", "san francisco", "new york", "nyc", "tokyo")
      for (const [cityId, city] of Object.entries(presets)) {
        const cityName = normalizeText(city.name);
        if (q === cityName || q === cityId || (cityId === 'sf' && q === 'san francisco') || (cityId === 'nyc' && (q === 'new york' || q === 'new york city'))) {
          const primaryPoi = city.pois?.[0] || {};
          const bounds = city.viewBounds || {};
          return {
            place: {
              lat: primaryPoi.lat,
              lng: primaryPoi.lon,
              label: city.name,
              types: ['locality'],
              viewport: {
                south: bounds.southwest?.lat ?? (primaryPoi.lat - 0.1),
                north: bounds.northeast?.lat ?? (primaryPoi.lat + 0.1),
                west: bounds.southwest?.lng ?? (primaryPoi.lon - 0.1),
                east: bounds.northeast?.lng ?? (primaryPoi.lon + 0.1),
              },
            },
            answered: true,
          };
        }
      }

      // 2. Check individual POI names
      for (const city of Object.values(presets)) {
        for (const poi of city.pois || []) {
          const poiName = normalizeText(poi.name);
          if (q === poiName) {
            return {
              place: {
                lat: poi.lat,
                lng: poi.lon,
                label: `${poi.name}, ${city.name}`,
                types: ['point_of_interest'],
                viewport: {
                  south: poi.lat - 0.005,
                  north: poi.lat + 0.005,
                  west: poi.lon - 0.005,
                  east: poi.lon + 0.005,
                },
              },
              answered: true,
            };
          }
        }
      }

      return { place: null, answered: false };
    },
  };
}
