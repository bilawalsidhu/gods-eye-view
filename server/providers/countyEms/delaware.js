import { easternTime } from '../chesterCountyEms/parser.js';
import { createCachedCountyFeed, readPublicText } from './publicFeed.js';

export const DELCO_PAGE = 'https://delcodispat.ch/d/pa/delco';
export const DELCO_FEED =
  'https://api.delcodispat.ch/api/d/pa/delco?pagingToken=&isDescending=true';
const clean = (value) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const MAX_AGE = 2 * 3600000;

/** Public recent pages are not a county active-incident feed. Never return raw messages/notes. */
export function parseDelcoPages(data, now = Date.now()) {
  if (!Array.isArray(data?.pages) || data.pages.length > 100)
    throw new Error('Invalid Delco pages');
  const reports = new Map();
  for (const page of data.pages.slice(0, 20)) {
    if (typeof page?.isStationPrivate !== 'boolean')
      throw new Error('Unknown Delco privacy schema');
    if (page.isStationPrivate) continue;
    const category = { Fire: 'fire', EMS: 'ems', Medic: 'ems' }[
      page.stationType?.name
    ];
    if (!category) continue;
    if (!/^\d{1,12}$/.test(String(page.pageId)))
      throw new Error('Invalid Delco page');
    const date = clean(page.dateReceived),
      time = clean(page.timeReceived);
    let receivedAt;
    try {
      receivedAt = easternTime(date + ' ' + time);
    } catch {
      throw new Error('Invalid Delco received time');
    }
    if (now - receivedAt > MAX_AGE || receivedAt > now + 60000) continue;
    const rawNumber = clean(page.incidentNumber);
    const number = /^[A-Za-z0-9-]{1,24}$/.test(rawNumber) ? rawNumber : '';
    const key = number || 'page-' + page.pageId;
    const id = 'delaware-pa:' + category + ':' + key;
    const nature = clean(page.nature),
      location = clean(page.location),
      municipality = clean(page.municipality),
      station = clean(page.station);
    if ([nature, location, municipality, station].some((s) => s.length > 500))
      throw new Error('Oversized Delco summary');
    const fields = Array.isArray(page.additionalFields)
      ? page.additionalFields
      : [];
    if (fields.length > 100) throw new Error('Oversized Delco fields');
    const field = (key) => clean(fields.find((f) => f.key === key)?.value);
    const lat = Number(field('Latitude')),
      lon = Number(field('Longitude'));
    const valid =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= 39.78 &&
      lat <= 40.12 &&
      lon >= -75.65 &&
      lon <= -75.17;
    const trucks = field('Trucks');
    const assignedUnits = trucks
      ? trucks.split(',').map(clean).filter(Boolean)
      : [];
    if (assignedUnits.length > 128 || assignedUnits.some((s) => s.length > 200))
      throw new Error('Oversized Delco units');
    const previous = reports.get(id);
    if (previous && previous.receivedAt > receivedAt) {
      previous.assignedUnits = [
        ...new Set([...previous.assignedUnits, ...assignedUnits]),
      ].slice(0, 128);
      continue;
    }
    reports.set(id, {
      id,
      incidentNumber: number || null,
      category,
      type: nature || 'Dispatch page',
      location,
      municipality,
      station,
      dispatched: date + ' ' + time,
      dispatchedAt: null,
      receivedAt,
      timeBasis: 'received',
      timezoneAssumed: true,
      reportKind: 'dispatch',
      official: false,
      sourceName: 'Delco Dispatch',
      assignedUnits: [
        ...new Set([...(previous?.assignedUnits || []), ...assignedUnits]),
      ].slice(0, 128),
      detailUrl: DELCO_PAGE,
      countyId: 'delaware-pa',
      county: 'Delaware County, PA',
      mapPosition: valid
        ? { lat, lon, kind: 'community-published', approximate: true }
        : null,
      locationStatus: valid ? 'matched' : 'unmatched',
    });
  }
  return {
    rows: [...reports.values()],
    observedAt: now,
    timestampBasis: 'retrieved',
    coverageKind: 'recent-dispatches',
    official: false,
    limited: true,
    sourceLimit: 20,
    recentWindowMinutes: 120,
  };
}
/** Read only the newest page; no pagination, history crawl or background collection. */
export function createDelawareCountyFeed({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  return createCachedCountyFeed({
    now,
    ttl: 60000,
    unavailable: 'Delaware County dispatches unavailable',
    load: async () => {
      const snapshot = parseDelcoPages(
        JSON.parse(await readPublicText(fetchImpl, DELCO_FEED)),
        now(),
      );
      return {
        ...snapshot,
        locationCoverage: {
          matched: snapshot.rows.filter((r) => r.mapPosition).length,
          unmatched: snapshot.rows.filter((r) => !r.mapPosition).length,
          unavailable: 0,
        },
      };
    },
  });
}
