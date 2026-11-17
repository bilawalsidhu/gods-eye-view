import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { PORT_SUPPLEMENTS } from './supplements.js';

/** NGA reference data, hosted by the US Department of Energy's NETL. */
export const PORTS_ENDPOINT =
  'https://arcgis.netl.doe.gov/server/rest/services/Hosted/CCS_EJ_SJ_Data/FeatureServer/17';
export const PORTS_REFERENCE = 'https://msi.nga.mil/Publications/WPI';
const PAGE_SIZE = 1000;
const MAX_PAGES = 6;
const MAX_BYTES = 4 * 1024 * 1024;
const DAY = 86400000;
const FACILITIES = Object.freeze({
  container: 'fac_container',
  bulk: 'fac_solidbulk',
  oil: 'fac_oilterm',
  lng: 'fac_lngterm',
});
const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 240) : '');

/** Normalize one WPI feature. Unknown facilities remain null, never false. */
export function normalizePort(feature) {
  const p = feature?.properties;
  const xy = feature?.geometry?.coordinates;
  if (
    !p ||
    feature?.geometry?.type !== 'Point' ||
    !Array.isArray(xy) ||
    !Number.isFinite(xy[0]) ||
    !Number.isFinite(xy[1]) ||
    Math.abs(xy[0]) > 180 ||
    Math.abs(xy[1]) > 90 ||
    !Number.isSafeInteger(p.wpinumber) ||
    p.wpinumber <= 0 ||
    !text(p.main_port_name)
  )
    return null;
  const facilities = Object.fromEntries(
    Object.entries(FACILITIES).map(([key, field]) => {
      const value = text(p[field]).toLowerCase();
      return [key, value === 'yes' ? true : value === 'no' ? false : null];
    }),
  );
  return {
    id: String(p.wpinumber),
    name: text(p.main_port_name),
    country: text(p.wpi_cc) || null,
    unlocode: text(p.unlocode).replace(/\s+/g, '') || null,
    lat: xy[1],
    lon: xy[0],
    facilities,
    // A positive terminal-depth field is not evidence of a terminal's status.
    facts: PORT_SUPPLEMENTS[String(p.wpinumber)] || {},
  };
}

/** Match both filters. Unknown facilities are included only by the all-types filter. */
export function filterPorts(rows, { country = '', facility = '' } = {}) {
  return rows.filter(
    (row) =>
      (!country || row.country === country) &&
      (!facility || row.facilities[facility] === true),
  );
}

/** Fetch bounded, ordered pages; cache only complete successful snapshots for a day. */
export function createPortsSource({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  let cached = null;
  async function read(url, signal) {
    const boundedSignal = AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(20000),
    ]);
    const response = await fetchImpl(url, {
      signal: boundedSignal,
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Port reference HTTP ${response.status}`);
    const value = await readResponseJsonCapped(
      response,
      MAX_BYTES,
      boundedSignal,
    );
    if (value?.error) throw new Error('Port reference service error');
    return value;
  }
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      if (cached && now() - cached.fetchedAt < DAY) return cached;
      const metadata = await read(`${PORTS_ENDPOINT}?f=json`, signal);
      if (
        metadata?.name !== 'World Port Index' ||
        metadata?.objectIdField !== 'objectid' ||
        !metadata?.advancedQueryCapabilities?.supportsPagination ||
        !metadata?.advancedQueryCapabilities?.supportsOrderBy
      )
        throw new Error('Invalid port reference metadata');
      const rows = new Map();
      let rejected = 0;
      let duplicates = 0;
      let received = 0;
      let lastObjectId = -1;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(`${PORTS_ENDPOINT}/query`);
        url.search = new URLSearchParams({
          where: '1=1',
          outFields:
            'objectid,wpinumber,main_port_name,wpi_cc,unlocode,fac_container,fac_solidbulk,fac_oilterm,fac_lngterm',
          outSR: '4326',
          f: 'geojson',
          orderByFields: 'objectid',
          resultOffset: String(received),
          resultRecordCount: String(PAGE_SIZE),
        });
        const payload = await read(url, signal);
        if (
          payload?.type !== 'FeatureCollection' ||
          !Array.isArray(payload.features) ||
          payload.features.length > PAGE_SIZE
        )
          throw new Error('Invalid port reference response');
        for (const feature of payload.features) {
          const objectId = feature?.properties?.objectid;
          if (!Number.isSafeInteger(objectId) || objectId <= lastObjectId)
            throw new Error(
              'Port reference pagination did not advance in objectid order',
            );
          lastObjectId = objectId;
          const row = normalizePort(feature);
          if (!row) {
            rejected++;
            continue;
          }
          if (!rows.has(row.id)) {
            rows.set(row.id, row);
          } else {
            duplicates++;
          }
        }
        received += payload.features.length;
        const more =
          payload.properties?.exceededTransferLimit === true ||
          payload.exceededTransferLimit === true;
        if (!more && payload.features.length < PAGE_SIZE) {
          if (!rows.size)
            throw new Error('Port reference returned no valid records');
          const snapshot = {
            rows: [...rows.values()],
            rejected,
            duplicates,
            received,
            fetchedAt: now(),
            sourceUpdatedAt: Number.isFinite(metadata.editingInfo?.lastEditDate)
              ? metadata.editingInfo.lastEditDate
              : null,
            sourceUrl: PORTS_ENDPOINT,
            referenceUrl: PORTS_REFERENCE,
            partial: rejected + duplicates > 0,
          };
          signal?.throwIfAborted();
          if (!snapshot.partial) cached = snapshot;
          return snapshot;
        }
        if (!payload.features.length)
          throw new Error('Port reference pagination did not advance');
      }
      throw new Error('Port reference exceeds the supported record limit');
    },
  };
}
