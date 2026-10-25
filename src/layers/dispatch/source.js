import {
  DISPATCH_AGENCIES,
  MAX_DISPATCH_CALLS,
  epochToSeattleLocal,
  normalizeDispatchSnapshot,
  normalizeEverettPoliceSnapshot,
  normalizeReportingAreas,
  normalizeSheriffReports,
} from './records.js';

export const SEATTLE_FIRE_DISPATCH_URL =
  'https://data.seattle.gov/resource/kzjm-xkqj.json';
export const EVERETT_POLICE_URL =
  'https://data.everettwa.gov/resource/f6vp-3svh.json';
export const SHERIFF_REPORTS_URL =
  'https://data.kingcounty.gov/resource/4kmt-kfqf.json';
export const SHERIFF_AREAS_URL =
  'https://data.kingcounty.gov/resource/wab8-9yes.json';
/** How far back the map shows Seattle Fire calls. */
export const DISPATCH_WINDOW_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REPORTING_AREAS = 2000;

function socrataUrl(base, field, sinceMs) {
  const url = new URL(base);
  url.searchParams.set(
    '$where',
    `${field} > '${epochToSeattleLocal(sinceMs)}'`,
  );
  url.searchParams.set('$order', `${field} DESC`);
  url.searchParams.set('$limit', String(MAX_DISPATCH_CALLS));
  return url.toString();
}

/** Build the Socrata query for Seattle Fire calls dispatched after `sinceMs`. */
export function seattleFireDispatchUrl(sinceMs) {
  return socrataUrl(SEATTLE_FIRE_DISPATCH_URL, 'datetime', sinceMs);
}

/** Build the Socrata query for Everett Police calls received after `sinceMs`. */
export function everettPoliceUrl(sinceMs) {
  return socrataUrl(EVERETT_POLICE_URL, 'datetimereceived', sinceMs);
}

/**
 * Build the Socrata query for King County Sheriff offense rows after `sinceMs`.
 * Rows are one per offense, so the limit leaves room for multi-offense cases.
 */
export function sheriffReportsUrl(sinceMs) {
  const url = new URL(
    socrataUrl(SHERIFF_REPORTS_URL, 'incident_datetime', sinceMs),
  );
  url.searchParams.set('$limit', String(MAX_DISPATCH_CALLS * 2));
  return url.toString();
}

export function sheriffAreasUrl() {
  const url = new URL(SHERIFF_AREAS_URL);
  url.searchParams.set('$select', 'area,x_coord,y_coord');
  url.searchParams.set('$limit', String(MAX_REPORTING_AREAS));
  return url.toString();
}

async function fetchJson(fetchImpl, href, label, signal) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(href, {
    signal: combined,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  const body = await response.text();
  signal?.throwIfAborted();
  if (body.length > MAX_BODY_BYTES)
    throw new Error(`${label} response too large`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Malformed ${label} response`);
  }
}

function malformed(label) {
  return new Error(`Malformed ${label} response`);
}

/**
 * The feeds behind Emergency Services. Each has its own look-back window
 * (matched to how late the publisher posts) and its own refresh interval.
 */
export function createDispatchFeeds({ fetchImpl, now }) {
  let areas = null;
  async function reportingAreas(signal) {
    if (areas) return areas;
    const label = 'King County reporting areas';
    const parsed = normalizeReportingAreas(
      await fetchJson(fetchImpl, sheriffAreasUrl(), label, signal),
    );
    if (!parsed?.size) throw malformed(label);
    areas = parsed;
    return areas;
  }
  return [
    {
      agency: DISPATCH_AGENCIES.sfd,
      windowMs: DISPATCH_WINDOW_MS,
      refreshMs: 2 * MINUTE_MS,
      async load(signal) {
        const label = 'Seattle Fire 911';
        const calls = normalizeDispatchSnapshot(
          await fetchJson(
            fetchImpl,
            seattleFireDispatchUrl(now() - DISPATCH_WINDOW_MS),
            label,
            signal,
          ),
        );
        if (!calls) throw malformed(label);
        return calls;
      },
    },
    {
      agency: DISPATCH_AGENCIES.epd,
      // The city posts the previous day's calls once a day.
      windowMs: 48 * HOUR_MS,
      refreshMs: 15 * MINUTE_MS,
      async load(signal) {
        const label = 'Everett Police';
        const calls = normalizeEverettPoliceSnapshot(
          await fetchJson(
            fetchImpl,
            everettPoliceUrl(now() - 48 * HOUR_MS),
            label,
            signal,
          ),
          { now: now() },
        );
        if (!calls) throw malformed(label);
        return calls;
      },
    },
    {
      agency: DISPATCH_AGENCIES.kcso,
      // Only supervisor-approved reports are published, about a day late.
      windowMs: 72 * HOUR_MS,
      refreshMs: 30 * MINUTE_MS,
      async load(signal) {
        const label = 'King County Sheriff';
        const lookup = await reportingAreas(signal);
        const calls = normalizeSheriffReports(
          await fetchJson(
            fetchImpl,
            sheriffReportsUrl(now() - 72 * HOUR_MS),
            label,
            signal,
          ),
          lookup,
          { now: now() },
        );
        if (!calls) throw malformed(label);
        return calls;
      },
    },
  ];
}

/**
 * Emergency services calls from public open-data portals (Seattle Fire 911,
 * Everett Police, King County Sheriff). Every portal answers browsers directly
 * with CORS `*`.
 *
 * Each feed is fetched only when its own refresh interval has passed and keeps
 * its last good calls when a fetch fails. The snapshot rejects only when no
 * feed has ever loaded.
 * @returns {{getSnapshot: Function}}
 */
export function createEmergencyServicesSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  feeds = createDispatchFeeds({ fetchImpl, now }),
} = {}) {
  const cache = new Map();
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const at = now();
      const results = await Promise.allSettled(
        feeds.map(async (feed) => {
          const cached = cache.get(feed.agency.id);
          if (cached && at - cached.fetchedAt < feed.refreshMs) return;
          const calls = await feed.load(signal);
          cache.set(feed.agency.id, { calls, fetchedAt: at });
        }),
      );
      signal?.throwIfAborted();
      const failures = [];
      const calls = [];
      const windows = {};
      results.forEach((result, index) => {
        const feed = feeds[index];
        windows[feed.agency.id] = feed.windowMs;
        if (result.status === 'rejected')
          failures.push({
            agency: feed.agency.id,
            name: feed.agency.name,
            message:
              result.reason?.message || `${feed.agency.name} unavailable`,
          });
        const cached = cache.get(feed.agency.id);
        // Drop calls that aged out since their feed was last fetched.
        if (cached)
          for (const call of cached.calls)
            if (at - call.time <= feed.windowMs) calls.push(call);
      });
      if (!cache.size && failures.length)
        throw new Error(failures.map((failure) => failure.message).join('; '));
      return { calls, failures, windows };
    },
  };
}
