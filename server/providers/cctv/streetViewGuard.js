/** Server-only guard for metered CCTV Street View fallback requests. */
export const STREET_VIEW_WINDOW_MS = 60_000;
export const STREET_VIEW_MAX_REQUESTS = 12;

/**
 * Accept only a registered source with valid geographic coordinates.
 * Query-string overrides are deliberately ignored: they are untrusted input.
 */
export function registeredStreetViewLocation(source) {
  if (!source || typeof source.id !== 'string' || !source.id.trim())
    return null;
  if (
    source.lat == null ||
    source.lon == null ||
    (typeof source.lat === 'string' && !source.lat.trim()) ||
    (typeof source.lon === 'string' && !source.lon.trim())
  )
    return null;
  const lat = Number(source.lat);
  const lon = Number(source.lon);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  )
    return null;
  const heading = Number(source.headingDeg);
  const fov = Number(source.fovDeg);
  const pitch = Number(source.pitchDeg);
  return {
    lat,
    lon,
    heading: Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : 0,
    fov: Number.isFinite(fov) ? Math.max(20, Math.min(120, fov)) : 80,
    pitch: Number.isFinite(pitch) ? Math.max(-40, Math.min(20, pitch)) : 0,
  };
}

/**
 * A bounded per-process budget shared by all CCTV cameras. Count attempts
 * before the upstream fetch (including failed requests), never after it.
 */
export function createStreetViewBudget({
  now = Date.now,
  windowMs = STREET_VIEW_WINDOW_MS,
  maxRequests = STREET_VIEW_MAX_REQUESTS,
} = {}) {
  if (
    !Number.isFinite(windowMs) ||
    windowMs <= 0 ||
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1
  ) {
    throw new TypeError('Invalid Street View request budget');
  }
  let started = now();
  let used = 0;
  return {
    consume() {
      const time = now();
      if (time < started || time - started >= windowMs) {
        started = time;
        used = 0;
      }
      if (used >= maxRequests) return false;
      used += 1;
      return true;
    },
  };
}
