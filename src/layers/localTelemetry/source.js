export const DEFAULT_TELEMETRY_API_URL = '/api/telemetry';

/**
 * Request and validate live industrial telemetry observations.
 * Supports injected fetchImpl for unit testing and offline development.
 */
export function createLocalTelemetrySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiUrl = DEFAULT_TELEMETRY_API_URL,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(apiUrl, { signal });
      if (!response.ok) {
        throw new Error(`Industrial Telemetry HTTP ${response.status}`);
      }
      const payload = await response.json();
      signal?.throwIfAborted();

      const rawDevices = Array.isArray(payload?.devices)
        ? payload.devices
        : Array.isArray(payload)
          ? payload
          : [];

      return rawDevices
        .filter(
          (d) =>
            d &&
            Number.isFinite(d.lat) &&
            Number.isFinite(d.lon) &&
            d.lat >= -90 &&
            d.lat <= 90 &&
            d.lon >= -180 &&
            d.lon <= 180,
        )
        .map((d, idx) => ({
          id: d.id ? String(d.id) : `dev-${idx}`,
          name: d.name ? String(d.name) : `Asset #${idx + 1}`,
          facility: d.facility ? String(d.facility) : '',
          city: d.city ? String(d.city) : '',
          country: d.country ? String(d.country) : '',
          type: d.type ? String(d.type).toLowerCase() : 'sensor',
          lat: Number(d.lat),
          lon: Number(d.lon),
          alt: Number.isFinite(d.alt) ? Number(d.alt) : 0,
          heading: Number.isFinite(d.heading) ? Number(d.heading) : 0,
          speed: Number.isFinite(d.speed) ? Number(d.speed) : 0,
          status: d.status ? String(d.status).toLowerCase() : 'nominal',
          battery: Number.isFinite(d.battery) ? Number(d.battery) : null,
          metrics: d.metrics && typeof d.metrics === 'object' ? d.metrics : {},
          updatedAt: d.updatedAt || new Date().toISOString(),
          source: d.source || payload?.source || 'IIoT Feed',
        }));
    },
  };
}
