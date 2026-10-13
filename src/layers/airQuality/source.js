const API_URL = '/api/air-quality';

/**
 * Request and validate live air quality observations.
 * Supports injected fetchImpl for unit testing and offline development.
 */
export function createAirQualitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiUrl = API_URL,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(apiUrl, { signal });
      if (!response.ok) throw new Error(`Air Quality HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();

      const rawStations = Array.isArray(payload?.stations)
        ? payload.stations
        : Array.isArray(payload)
          ? payload
          : [];

      return rawStations
        .filter(
          (s) =>
            s &&
            Number.isFinite(s.lat) &&
            Number.isFinite(s.lon) &&
            s.lat >= -90 &&
            s.lat <= 90 &&
            s.lon >= -180 &&
            s.lon <= 180,
        )
        .map((s, idx) => ({
          stableId: s.id ? String(s.id) : `station-${idx}`,
          name: s.name ? String(s.name) : 'Monitoring Station',
          city: s.city ? String(s.city) : '',
          country: s.country ? String(s.country) : '',
          industrialType: s.industrialType
            ? String(s.industrialType)
            : 'Ambient Station',
          lat: s.lat,
          lon: s.lon,
          aqi: Number.isFinite(s.aqi) ? Math.round(s.aqi) : 25,
          category: s.category ? String(s.category) : 'Moderate',
          primaryPollutant: s.primaryPollutant
            ? String(s.primaryPollutant)
            : 'PM2.5',
          pm25: Number.isFinite(s.pm25) ? s.pm25 : null,
          pm10: Number.isFinite(s.pm10) ? s.pm10 : null,
          no2: Number.isFinite(s.no2) ? s.no2 : null,
          so2: Number.isFinite(s.so2) ? s.so2 : null,
          co: Number.isFinite(s.co) ? s.co : null,
          o3: Number.isFinite(s.o3) ? s.o3 : null,
          timestamp: s.timestamp
            ? String(s.timestamp)
            : new Date().toISOString(),
          source: s.source ? String(s.source) : 'Open-Meteo Air Quality',
        }));
    },
  };
}
