import { readResponseJsonCapped } from '../../sources/httpBody.js';

const BASE = 'https://api.open511.gov.bc.ca/events';
const MAX_EVENTS = 500;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_COORDINATES = 5000;
const CACHE_TTL_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 12_000;
const text = (value, length) =>
  typeof value === 'string' ? value.slice(0, length) : null;

function normalizeCoordinates(value, remaining) {
  if (!Array.isArray(value) || !remaining.count) return [];
  const out = [];
  for (const pair of value) {
    if (remaining.count <= 0) break;
    if (
      Array.isArray(pair) &&
      pair.length >= 2 &&
      Number.isFinite(pair[0]) &&
      Math.abs(pair[0]) <= 180 &&
      Number.isFinite(pair[1]) &&
      Math.abs(pair[1]) <= 90
    ) {
      out.push([pair[0], pair[1]]);
      remaining.count--;
    }
  }
  return out;
}

function normalizeGeometry(value, remaining) {
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'Point') {
    const coords = normalizeCoordinates([value.coordinates], remaining);
    return coords.length ? { type: 'Point', coordinates: coords[0] } : null;
  }
  if (value.type === 'LineString') {
    const coordinates = normalizeCoordinates(value.coordinates, remaining);
    return coordinates.length >= 2 ? { type: 'LineString', coordinates } : null;
  }
  if (value.type === 'MultiLineString') {
    const coordinates = (
      Array.isArray(value.coordinates) ? value.coordinates : []
    )
      .map((line) => normalizeCoordinates(line, remaining))
      .filter((line) => line.length >= 2);
    return coordinates.length ? { type: 'MultiLineString', coordinates } : null;
  }
  return null;
}

export function normalizeDriveBcSnapshot(payload) {
  if (!Array.isArray(payload?.events) || payload.events.length > MAX_EVENTS)
    throw new Error('Malformed DriveBC response');
  const events = [];
  const ids = new Set();
  for (const raw of payload.events) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      raw.status !== 'ACTIVE' ||
      typeof raw.id !== 'string' ||
      !raw.id ||
      ids.has(raw.id)
    )
      continue;
    const remaining = { count: MAX_COORDINATES };
    const geometry = normalizeGeometry(raw.geography, remaining);
    if (!geometry) continue;
    ids.add(raw.id);
    const url =
      typeof raw.url === 'string'
        ? (() => {
            try {
              const parsed = new URL(raw.url);
              return parsed.protocol === 'https:' &&
                parsed.hostname === 'api.open511.gov.bc.ca'
                ? parsed.href.slice(0, 500)
                : null;
            } catch {
              return null;
            }
          })()
        : null;
    events.push({
      id: raw.id.slice(0, 160),
      headline: text(raw.headline, 100),
      status: raw.status === 'ACTIVE' ? 'ACTIVE' : 'UNKNOWN',
      eventType: text(raw.event_type, 80),
      subtypes: Array.isArray(raw.event_subtypes)
        ? raw.event_subtypes
            .filter((item) => typeof item === 'string')
            .slice(0, 8)
            .map((item) => item.slice(0, 80))
        : [],
      severity: text(raw.severity, 40),
      description: text(raw.description, 1200),
      updated: text(raw.updated, 64),
      url,
      geometry,
    });
  }
  return { events, partial: payload.events.length >= MAX_EVENTS };
}

/** Public, keyless DriveBC Open511 snapshot; the host is fixed to BC's endpoint. */
export function createDriveBcSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      if (cached && now() - cached.fetchedAt < CACHE_TTL_MS)
        return {
          ...cached.snapshot,
          stale: false,
          fetchedAt: cached.fetchedAt,
        };
      const upstreamSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
        : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
      const url = new URL(BASE);
      url.search = new URLSearchParams({
        format: 'json',
        status: 'ACTIVE',
        limit: String(MAX_EVENTS),
      }).toString();
      try {
        const response = await fetchImpl(url.href, {
          signal: upstreamSignal,
          redirect: 'error',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`DriveBC HTTP ${response.status}`);
        }
        const payload = await readResponseJsonCapped(
          response,
          MAX_BODY_BYTES,
          upstreamSignal,
        );
        upstreamSignal.throwIfAborted();
        const snapshot = normalizeDriveBcSnapshot(payload);
        cached = { snapshot, fetchedAt: now() };
        return { ...snapshot, stale: false, fetchedAt: cached.fetchedAt };
      } catch (error) {
        signal?.throwIfAborted();
        if (cached && now() - cached.fetchedAt <= 5 * 60_000)
          return {
            ...cached.snapshot,
            stale: true,
            fetchedAt: cached.fetchedAt,
          };
        throw error;
      }
    },
  };
}
