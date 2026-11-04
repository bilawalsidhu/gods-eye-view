import { createCachedCountyFeed, readPublicText } from './publicFeed.js';
import { digest } from './listFeeds.js';
export const LEBANON_PAGE = 'https://717alerts.com/county/lebanon';
// Public GET invoked by the site's live-incidents client. No account or API key.
export const LEBANON_FEED =
  'https://717alerts.com/_serverFn/25b6ea4fdc3fe03d835e4cc91c9fd2011347f2ed976a55322998dc87f7e6a8ec';

/** Decode the site's small data-only wire subset; never evaluate serialized code. */
export function decodePublicSnapshot(input) {
  let count = 0;
  function decode(node, depth = 0) {
    if (++count > 40000 || depth > 40 || !node || typeof node !== 'object')
      throw new Error('Invalid Lebanon data');
    if (node.t === 0 && Number.isFinite(node.s)) return node.s;
    if (node.t === 1 && typeof node.s === 'string') return node.s;
    if (node.t === 2 && [0, 1, 2, 3].includes(node.s))
      return [undefined, null, true, false][node.s];
    if (node.t === 9 && Array.isArray(node.a))
      return node.a.map((item) => decode(item, depth + 1));
    if (
      [10, 11].includes(node.t) &&
      Array.isArray(node.p?.k) &&
      Array.isArray(node.p?.v) &&
      node.p.k.length === node.p.v.length
    ) {
      return Object.fromEntries(
        node.p.k.map((key, index) => {
          if (
            typeof key !== 'string' ||
            ['__proto__', 'constructor', 'prototype'].includes(key)
          )
            throw new Error('Invalid public key');
          return [key, decode(node.p.v[index], depth + 1)];
        }),
      );
    }
    throw new Error('Unsupported Lebanon data schema');
  }
  const envelope = decode(input);
  if (envelope.error || !envelope.result)
    throw new Error('Lebanon snapshot unavailable');
  return envelope.result;
}
const clean = (value) => {
  const text =
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text.length > 500) throw new Error('Oversized Lebanon summary');
  return text;
};
/** Recent pager summaries have unknown active status; ignore raw notes and centroid pins. */
export function parseLebanonSnapshot(data, now = Date.now()) {
  const source = data?.sources?.find((source) => source.name === 'lcdes.org');
  const observedAt = Date.parse(data?.fetchedAt);
  if (
    source?.ok !== true ||
    !Number.isFinite(observedAt) ||
    !Array.isArray(data.incidents) ||
    data.incidents.length > 1000
  )
    throw new Error('Lebanon pager unavailable');
  const rows = [],
    seen = new Set();
  const candidates = data.incidents
    .filter((row) => row.county === 'lebanon')
    .toSorted((a, b) => b.dispatchedAt - a.dispatchedAt);
  for (const item of candidates) {
    if (
      !Number.isFinite(item.dispatchedAt) ||
      item.dispatchedAt > now + 60000 ||
      now - item.dispatchedAt > 7200000
    )
      continue;
    const key = clean(item.incidentNumber) || clean(item.id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (
      item.status === 'resolved' ||
      !['fire', 'ems', 'traffic'].includes(item.type) ||
      item.redacted === true
    )
      continue;
    const valid =
      item.type !== 'ems' &&
      item.geocodeSource === 'google' &&
      item.geocodeApprox !== true &&
      Number.isFinite(item.lat) &&
      Number.isFinite(item.lng) &&
      item.lat >= 40.13 &&
      item.lat <= 40.6 &&
      item.lng >= -76.8 &&
      item.lng <= -76.1;
    const units = Array.isArray(item.units)
      ? item.units.map(clean).filter(Boolean)
      : [];
    if (units.length > 128) throw new Error('Invalid Lebanon units');
    rows.push({
      id: 'lebanon-pa:' + item.type + ':' + digest(key),
      countyId: 'lebanon-pa',
      incidentNumber: null,
      category: item.type,
      type: clean(item.title),
      location: clean(item.location),
      municipality: '',
      station: '',
      dispatchedAt: null,
      receivedAt: item.dispatchedAt,
      timeBasis: 'received',
      timezoneAssumed: true,
      dispatched: new Date(item.dispatchedAt).toLocaleString('en-US', {
        timeZone: 'America/New_York',
      }),
      reportKind: 'dispatch',
      official: false,
      sourceName: '717 Alerts / Lebanon DES pager',
      assignedUnits: units,
      mapPosition: valid
        ? {
            lat: item.lat,
            lon: item.lng,
            kind: 'community-published',
            approximate: true,
          }
        : null,
      locationStatus: valid ? 'matched' : 'unmatched',
      detailUrl: LEBANON_PAGE,
    });
  }
  return {
    rows,
    observedAt,
    timestampBasis: 'retrieved',
    official: false,
    coverageKind: 'recent-dispatches',
    limited: true,
    recentWindowMinutes: 120,
  };
}
/** One public live snapshot only, without archive requests, credentials or TLS overrides. */
export function createLebanonCountyFeed({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  return createCachedCountyFeed({
    now,
    ttl: 60000,
    staleAfter: 180000,
    unavailable: 'Lebanon dispatches unavailable',
    load: async () =>
      parseLebanonSnapshot(
        decodePublicSnapshot(
          JSON.parse(await readPublicText(fetchImpl, LEBANON_FEED, 2048000)),
        ),
        now(),
      ),
  });
}
