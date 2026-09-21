import { DEFAULT_FAMILY, DEFAULT_WINDOW_YEARS, FAMILY_IDS } from './policy.js';

/** Matches MAX_VIEWPORT_DEGREES; the upstream cannot serve a wider box in time. */
const MAX_BOX_DEGREES = 2;

function validBox(box) {
  const { south, west, north, east } = box || {};
  return (
    [south, west, north, east].every(Number.isFinite) &&
    south >= -90 &&
    north <= 90 &&
    west >= -180 &&
    east <= 180 &&
    north > south &&
    east > west &&
    north - south <= MAX_BOX_DEGREES &&
    east - west <= MAX_BOX_DEGREES
  );
}

function requestOptions({ family, sinceYears }) {
  return {
    family: FAMILY_IDS.includes(family) ? family : DEFAULT_FAMILY,
    sinceYears: Number.isFinite(sinceYears)
      ? String(Math.round(sinceYears))
      : String(DEFAULT_WINDOW_YEARS),
  };
}

async function readPayload(response, signal, failureLabel) {
  const body = await response.json();
  signal?.throwIfAborted();
  if (!response.ok)
    throw Object.assign(
      new Error(body?.error || `${failureLabel} HTTP ${response.status}`),
      {
        failureReason: ['rate_limited', 'timeout', 'query_failed'].includes(
          body?.reason,
        )
          ? body.reason
          : 'unavailable',
      },
    );
  return body;
}

/**
 * Read monitoring sites and per-site measurements through fixed endpoints.
 *
 * Both reads validate before touching the network, so a malformed viewport or
 * site identifier costs no request. A malformed snapshot throws rather than
 * resolving empty: "the upstream answered with nothing recognisable" and "there
 * is nothing here" are different facts and the layer states them differently.
 * @param {{fetchImpl?:Function}} options Injected transport.
 * @returns {{getStations:Function, getResults:Function}} Water-quality source.
 */
export function createWaterQualitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getStations(box, { family, sinceYears, signal } = {}) {
      if (!validBox(box))
        throw new TypeError('A bounded water-quality viewport is required');
      signal?.throwIfAborted();
      const options = requestOptions({ family, sinceYears });
      const query = new URLSearchParams({
        south: box.south.toFixed(5),
        west: box.west.toFixed(5),
        north: box.north.toFixed(5),
        east: box.east.toFixed(5),
        ...options,
      });
      const response = await fetchImpl(`/api/water-quality/sites?${query}`, {
        signal,
      });
      const body = await readPayload(
        response,
        signal,
        'Water quality site feed',
      );
      if (!Array.isArray(body?.sites))
        throw new Error('Malformed water-quality site snapshot');
      return {
        sites: body.sites,
        totalSiteCount: Number(body.totalSiteCount) || body.sites.length,
        saturated: body.saturated === true,
        sampledSince: body.sampledSince || null,
        status: body.status,
        retrievedAt: body.retrievedAt || null,
      };
    },

    async getResults(siteId, { family, sinceYears, signal } = {}) {
      const site = String(siteId || '').trim();
      if (!site)
        throw new TypeError('A monitoring site identifier is required');
      signal?.throwIfAborted();
      const options = requestOptions({ family, sinceYears });
      const query = new URLSearchParams({ site, ...options });
      const response = await fetchImpl(`/api/water-quality/results?${query}`, {
        signal,
      });
      const body = await readPayload(
        response,
        signal,
        'Water quality result feed',
      );
      if (!Array.isArray(body?.measurements))
        throw new Error('Malformed water-quality result snapshot');
      return {
        site,
        measurements: body.measurements,
        saturated: body.saturated === true,
        sampledSince: body.sampledSince || null,
        status: body.status,
        retrievedAt: body.retrievedAt || null,
      };
    },
  };
}
