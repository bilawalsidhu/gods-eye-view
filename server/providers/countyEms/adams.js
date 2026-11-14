import { easternTime } from '../chesterCountyEms/parser.js';
import { createCachedCountyFeed, readPublicText } from './publicFeed.js';
export const ADAMS_PAGE = 'https://incidents.adamscountypa.gov/';
export const ADAMS_FEED = ADAMS_PAGE + 'api/calls';
const clean = (value) => {
  const text =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).replace(/\s+/g, ' ').trim()
      : '';
  if (text.length > 500) throw new Error('Oversized Adams summary');
  return text;
};
const callTime = (value) => {
  const text = clean(value).replace(/^(\d{2})-(\d{2})-(\d{2}) /, '$1/$2/20$3 ');
  return easternTime(text);
};

/** Only explicitly recognizable public natures are classified; unknowns stay excluded. */
export function parseAdamsCalls(data) {
  if (
    data?.monitoring_active !== true ||
    data.system_error !== false ||
    data.data_degraded !== false ||
    !Array.isArray(data.calls) ||
    data.calls.length > 500
  )
    throw new Error('Adams monitoring unavailable');
  const observedAt = easternTime(clean(data.timestamp));
  const rows = [],
    seen = new Set();
  let excluded = 0;
  for (const call of data.calls) {
    const type = clean(call.nature_of_call);
    const category = /^(?:MVA|TRAFFIC|ROAD CLOSURE|VEHICLE ACCIDENT)\b/i.test(
      type,
    )
      ? 'traffic'
      : /^FIRE\b/i.test(type)
        ? 'fire'
        : /^(?:EMS|MEDICAL|AMBULANCE)\b/i.test(type)
          ? 'ems'
          : null;
    if (!category) {
      excluded++;
      continue;
    }
    const number = clean(call.call_number);
    if (
      !/^\d{1,16}$/.test(number) ||
      seen.has(number) ||
      !Array.isArray(call.unit_details) ||
      call.unit_details.length > 128
    )
      throw new Error('Invalid Adams call');
    seen.add(number);
    const units = call.unit_details.map((unit) => {
      const entered = clean(
        unit.clear_time || unit.arrive_time || unit.enroute_time,
      );
      return {
        unit: clean(unit.unit_id),
        description: clean(unit.unit_type),
        status: unit.clear_time
          ? 'Cleared'
          : unit.arrive_time
            ? 'On Scene'
            : unit.enroute_time
              ? 'En Route'
              : 'Dispatched',
        entered,
        enteredAt: entered ? callTime(entered) : null,
      };
    });
    rows.push({
      id: 'adams-pa:' + category + ':' + number,
      countyId: 'adams-pa',
      incidentNumber: number,
      category,
      type,
      location: clean(call.location),
      municipality: '',
      station: '',
      dispatched: clean(call.create_date_time),
      dispatchedAt: null,
      reportedAt: callTime(call.create_date_time),
      timeBasis: 'reported',
      mapPosition: null,
      locationStatus: 'not-published',
      detailUrl: ADAMS_PAGE + 'unit_details?call_number=' + number,
      units,
    });
  }
  return { rows, observedAt, limited: excluded > 0, excludedCount: excluded };
}
/** Fixed public snapshots require healthy monitoring, including for an empty list. */
export function createAdamsCountyFeed({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  return createCachedCountyFeed({
    now,
    ttl: 60000,
    staleAfter: 180000,
    unavailable: 'Adams incidents unavailable',
    load: async () =>
      parseAdamsCalls(JSON.parse(await readPublicText(fetchImpl, ADAMS_FEED))),
  });
}
/** Unit clocks are the public source's full local date/time, never retrieval time. */
export function createAdamsDetails({ getSnapshot }) {
  return async (id) => {
    const snapshot = await getSnapshot(),
      row = snapshot.rows.find((row) => row.id === id);
    if (!row)
      throw Object.assign(new Error('Incident is no longer listed'), {
        statusCode: 404,
      });
    return {
      id,
      incidentNumber: row.incidentNumber,
      observedAt: snapshot.observedAt,
      fetchedAt: snapshot.fetchedAt,
      stale: !!snapshot.stale,
      sourceUrl: row.detailUrl,
      units: row.units,
    };
  };
}
