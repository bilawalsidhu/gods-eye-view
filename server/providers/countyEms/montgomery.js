import { readResponseBytesCapped } from '../common/http.js';
import { easternTime } from '../chesterCountyEms/parser.js';

export const MONTGOMERY_PAGE =
  'https://webapp07.montcopa.org/eoc/cadinfo/livecad-incidents.asp';
export const MONTGOMERY_GIS =
  'https://gis.montcopa.org/arcgis/rest/services/Hosted/Montgomery_County_Active_CAD_Incidents_View/FeatureServer/0/query?where=1%3D1&outFields=incidentno,location,mun,updated_dt&returnGeometry=true&outSR=4326&f=geojson';
const text = (html) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[\da-f]+|\d+);/gi,
      (entity) => {
        if (entity.startsWith('&#')) {
          const hex = entity[2].toLowerCase() === 'x';
          const code = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
          return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        }
        return {
          '&amp;': '&',
          '&lt;': '<',
          '&gt;': '>',
          '&quot;': '"',
          '&apos;': "'",
          '&nbsp;': ' ',
        }[entity.toLowerCase()];
      },
    )
    .replace(/\s+/g, ' ')
    .trim();
const attribute = (html, key) =>
  html.match(new RegExp(key + '=["\']([^"\']+)["\']', 'i'))?.[1];
const field = (html, name) =>
  text(
    html.match(
      new RegExp(
        '<span class=["\']' + name + '["\'][^>]*>([\\s\\S]*?)<\\/span>',
        'i',
      ),
    )?.[1] || '',
  );
function dispatch(value) {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2}) @ (\d{2}:\d{2}:\d{2})$/);
  if (!m) throw new Error('Invalid Montgomery dispatch time');
  return easternTime(m[2] + '/' + m[3] + '/' + m[1] + ' ' + m[4]);
}
/** Parse the complete county list, retaining reports absent from its map. */
export function parseMontgomeryIncidents(html) {
  const clock = html.match(/Last updated\s*<strong>([^<]+)<\/strong>/i);
  const count = html.match(
    /Active Fire, EMS &amp; Traffic Incidents\s*<span class=['"]count['"]>(\d+)<\/span>/i,
  );
  if (!clock || !count || Number(count[1]) > 500)
    throw new Error('Invalid Montgomery snapshot');
  const rows = [],
    seen = new Set();
  for (const match of html.matchAll(
    /<button\b([^>]*\bclass=['"]inc['"][^>]*)>([\s\S]*?)<\/button>/gi,
  )) {
    const category = attribute(match[1], 'data-cat');
    const incidentNumber = attribute(match[1], 'data-num');
    const eid = attribute(match[1], 'data-eid');
    const id = 'montgomery-pa:' + category + ':' + incidentNumber;
    if (
      !['fire', 'ems', 'traffic'].includes(category) ||
      !/^[A-Z]\d{7,9}$/.test(incidentNumber || '') ||
      !/^\d{1,12}$/.test(eid || '') ||
      seen.has(id)
    )
      throw new Error('Invalid Montgomery identity');
    seen.add(id);
    const metadata =
      match[2].match(/<span class=['"]inc-meta['"]>([\s\S]*)<\/span>/i)?.[1] ||
      '';
    const fields = [
      ...metadata.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi),
    ].map((m) => text(m[1]));
    const type = field(match[2], 'inc-type'),
      location = field(match[2], 'inc-loc');
    if (
      fields.length !== 3 ||
      !type ||
      !location ||
      [type, location, ...fields].some((s) => !s || s.length > 500)
    )
      throw new Error('Invalid Montgomery incident');
    const dispatched = fields[2].replace(/^Dispatched\s+/, '');
    rows.push({
      id,
      incidentNumber,
      category,
      type,
      location,
      municipality: fields[0],
      station: fields[1].replace(/^(?:Station|Agency)\s+/, ''),
      dispatched,
      dispatchedAt: dispatch(dispatched),
      eid,
      detailUrl: MONTGOMERY_PAGE + '?incident=' + incidentNumber,
      countyId: 'montgomery-pa',
      county: 'Montgomery County, PA',
    });
  }
  if (rows.length !== Number(count[1]))
    throw new Error('Incomplete Montgomery list');
  return { observedAt: easternTime(text(clock[1])), rows };
}
/** Unit times have no date: keep their text without inventing a calendar date. */
export function parseMontgomeryUnits(html, incidentNumber, checkedAt) {
  if (!/<table\b[^>]*class=['"]u-table['"]/i.test(html)) {
    if (/No (?:units|unit information)/i.test(text(html)))
      return {
        incidentNumber,
        observedAt: checkedAt,
        timestampBasis: 'retrieved',
        units: [],
      };
    throw new Error('Missing public unit table');
  }
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const fields = (row) =>
    [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      text(m[1]),
    );
  if (
    JSON.stringify(fields(rows.shift()?.[1] || '')) !==
      JSON.stringify(['Unit', 'Status', 'Time']) ||
    rows.length > 128
  )
    throw new Error('Unknown Montgomery unit schema');
  const units = rows.map((row) => {
    const values = fields(row[1]);
    if (values.length !== 3 || values.some((s) => !s || s.length > 200))
      throw new Error('Invalid public unit');
    return {
      unit: values[0],
      status: values[1],
      entered: values[2],
      enteredAt: null,
    };
  });
  return {
    incidentNumber,
    observedAt: checkedAt,
    timestampBasis: 'retrieved',
    units,
  };
}
async function read(fetchImpl, url, cap) {
  const signal = AbortSignal.timeout(10000);
  const response = await fetchImpl(url, { signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Montgomery source unavailable');
  }
  return new TextDecoder('utf-8').decode(
    await readResponseBytesCapped(response, cap, signal),
  );
}
/** Share bounded on-demand county reads, keeping last-good reports on failure. */
export function createMontgomeryCountyFeed({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  let cached,
    pending,
    lastAttempt = -Infinity,
    failed = false;
  async function load() {
    lastAttempt = now();
    try {
      const [list, gis] = await Promise.allSettled([
        read(fetchImpl, MONTGOMERY_PAGE, 1024000),
        read(fetchImpl, MONTGOMERY_GIS, 1024000).then(JSON.parse),
      ]);
      if (list.status === 'rejected') throw list.reason;
      const snapshot = parseMontgomeryIncidents(list.value);
      const goodGis =
        gis.status === 'fulfilled' &&
        Array.isArray(gis.value?.features) &&
        !gis.value.error &&
        !gis.value.exceededTransferLimit &&
        gis.value.features.length <= 500;
      const mapped = new Map(
        goodGis
          ? gis.value.features.map((f) => [f.properties?.incidentno, f])
          : [],
      );
      const rows = snapshot.rows.map((row) => {
        const f = mapped.get(row.incidentNumber),
          p = f?.geometry?.coordinates;
        const sameLocation =
          f &&
          text(String(f.properties.location || '')).toUpperCase() ===
            row.location.toUpperCase() &&
          text(String(f.properties.mun || '')).toUpperCase() ===
            row.municipality.toUpperCase();
        const valid =
          sameLocation &&
          f?.geometry?.type === 'Point' &&
          Array.isArray(p) &&
          p.length >= 2 &&
          Number.isFinite(p[0]) &&
          Number.isFinite(p[1]) &&
          p[0] >= -75.75 &&
          p[0] <= -74.95 &&
          p[1] >= 39.95 &&
          p[1] <= 40.5;
        return {
          ...row,
          mapPosition: valid
            ? {
                lon: p[0],
                lat: p[1],
                kind: 'county-published',
                approximate: true,
              }
            : null,
          locationStatus: valid
            ? 'matched'
            : !goodGis
              ? 'unavailable'
              : 'unmatched',
        };
      });
      cached = {
        ...snapshot,
        rows,
        fetchedAt: now(),
        locationCoverage: {
          matched: rows.filter((r) => r.mapPosition).length,
          unmatched: rows.filter((r) => r.locationStatus === 'unmatched')
            .length,
          unavailable: rows.filter((r) => r.locationStatus === 'unavailable')
            .length,
        },
      };
      failed = false;
    } catch {
      failed = true;
      if (!cached) throw new Error('Montgomery County incidents unavailable');
    }
    return {
      ...cached,
      stale:
        failed ||
        now() - cached.observedAt > 720000 ||
        cached.observedAt > now() + 60000,
    };
  }
  return async () => {
    if (pending) return pending;
    if (now() - lastAttempt < 120000) {
      if (!cached) throw new Error('Montgomery County incidents unavailable');
      return {
        ...cached,
        stale:
          failed ||
          now() - cached.observedAt > 720000 ||
          cached.observedAt > now() + 60000,
      };
    }
    pending = load();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}
/** Only active IDs can select a fixed-origin public unit fragment. */
export function createMontgomeryCountyDetails({
  getSnapshot,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  const cache = new Map(),
    pending = new Map();
  return async (id) => {
    const snapshot = await getSnapshot();
    const active = new Set(snapshot.rows.map((r) => r.id));
    for (const key of cache.keys()) if (!active.has(key)) cache.delete(key);
    const row = snapshot.rows.find((r) => r.id === id);
    if (!row)
      throw Object.assign(new Error('Incident is no longer active'), {
        statusCode: 404,
      });
    const old = cache.get(id);
    if (snapshot.stale) {
      if (old?.data) return { ...old.data, stale: true };
      throw new Error('Incident details unavailable');
    }
    if (pending.has(id)) return pending.get(id);
    if (old && now() - old.attemptedAt < 60000) {
      if (!old.data) throw new Error('Incident details unavailable');
      return {
        ...old.data,
        stale: old.failed || now() - old.data.fetchedAt > 180000,
      };
    }
    if (pending.size >= 4) throw new Error('Incident details busy');
    const load = async () => {
      const entry = { attemptedAt: now(), data: old?.data, failed: true };
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(id, entry);
      try {
        if (
          !/^\d{1,12}$/.test(row.eid) ||
          !/^[A-Z]\d{7,9}$/.test(row.incidentNumber)
        )
          throw new Error('Invalid identity');
        const url =
          MONTGOMERY_PAGE +
          '?' +
          new URLSearchParams({
            units: '1',
            eid: row.eid,
            num: row.incidentNumber,
          });
        entry.data = {
          ...parseMontgomeryUnits(
            await read(fetchImpl, url, 256000),
            row.incidentNumber,
            now(),
          ),
          fetchedAt: now(),
          sourceUrl: row.detailUrl,
        };
        entry.failed = false;
        return { ...entry.data, stale: false };
      } catch {
        if (entry.data) return { ...entry.data, stale: true };
        throw new Error('Incident details unavailable');
      }
    };
    const work = load();
    pending.set(id, work);
    try {
      return await work;
    } finally {
      pending.delete(id);
    }
  };
}
