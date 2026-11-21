/**
 * Client side of `/api/magnetosphere`.
 *
 * Only the solar wind state crosses the network. The field model ships with
 * the app, so a failure here costs the boundary and leaves the filaments.
 *
 * @module layers/magnetosphere/source
 */

const ENDPOINT = '/api/magnetosphere';

/** Reject anything that is not the shape we published, rather than coercing. */
export function validateMagnetosphereState(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.schemaVersion !== 1) return null;
  if (value.unavailable === true)
    return { unavailable: true, reason: String(value.reason || 'unavailable') };
  const wind = value.solarWind;
  const pause = value.magnetopause;
  if (!wind || !pause) return null;
  const numbers = [
    wind.speedKmPerS,
    wind.densityPerCm3,
    wind.bzNT,
    pause.standoffRe,
    pause.flaring,
    pause.dynamicPressureNPa,
  ];
  if (!numbers.every((n) => Number.isFinite(n))) return null;
  if (pause.standoffRe <= 1) return null; // inside the Earth is not a boundary
  return {
    unavailable: false,
    stale: value.stale === true,
    observedAt: wind.observedAt || null,
    arrivesAt: wind.arrivesAt || null,
    speedKmPerS: wind.speedKmPerS,
    densityPerCm3: wind.densityPerCm3,
    bzNT: wind.bzNT,
    // By and Dst decide whether the client can run T96 rather than T89, so
    // they are optional: null means "fall back", not "reject the response".
    byNT: Number.isFinite(wind.byNT) ? wind.byNT : null,
    btNT: Number.isFinite(wind.btNT) ? wind.btNT : null,
    dst: Number.isFinite(value.dst?.dst) ? value.dst.dst : null,
    dstObservedAt: value.dst?.observedAt || null,
    standoffRe: pause.standoffRe,
    flaring: pause.flaring,
    dynamicPressureNPa: pause.dynamicPressureNPa,
    kp: Number.isFinite(value.kp?.kp) ? value.kp.kp : null,
    insideGeosynchronous: pause.insideGeosynchronous === true,
    extrapolatedBeyondFit: pause.extrapolatedBeyondFit === true,
  };
}

export function createMagnetosphereSource({
  endpoint = ENDPOINT,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async load(signal) {
      const response = await fetchImpl(endpoint, { signal });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok && !body?.unavailable)
        throw new Error(`magnetosphere_http_${response.status}`);
      const state = validateMagnetosphereState(body);
      if (!state) throw new Error('magnetosphere_invalid_response');
      return state;
    },
  };
}
