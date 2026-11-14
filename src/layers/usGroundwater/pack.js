import { validateHistoricalWellPack } from './historicalPack.mjs';
/** Browser admission and display contract, not an upstream acquisition backend. */
export const WELL_LIMITS = Object.freeze({
  bytes: 8 * 1024 * 1024,
  sites: 2000,
  readings: 16,
});
const references = {
  72019: ['depth-below-land-surface', null],
  62610: ['water-level-elevation', 'NGVD29'],
  62611: ['water-level-elevation', 'NAVD88'],
};
const stationUrl = (id) =>
  `https://waterdata.usgs.gov/monitoring-location/${id}/`;
const finiteNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (
    typeof value !== 'string' ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  )
    return null;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : null;
};

/** Reject malformed packs at the browser trust boundary before creating entities. */
export function validateWellPack(pack) {
  if (
    pack?.acquisitions?.some?.(
      (a) => a?.collection === 'usgwd-historical-baseline',
    ) ||
    pack?.records?.some?.(
      (r) => typeof r?.id === 'string' && r.id.startsWith('USGWD-'),
    )
  )
    return validateHistoricalWellPack(pack, validateUsgsWellPack);
  return validateUsgsWellPack(pack);
}
function validateUsgsWellPack(pack) {
  const refuse = () => {
    throw new TypeError('Invalid U.S. groundwater well pack');
  };
  if (
    pack?.schemaVersion !== 1 ||
    pack.kind !== 'gev-us-groundwater-wells' ||
    pack.mode !== 'snapshot' ||
    pack.coverage?.complete !== false ||
    pack.coverage.country !== 'US' ||
    !Array.isArray(pack.records) ||
    pack.records.length > WELL_LIMITS.sites ||
    !Array.isArray(pack.acquisitions) ||
    pack.acquisitions.length < 1 ||
    pack.acquisitions.length > (pack.coverage.indexed ? 256 : 12)
  )
    refuse();
  const seen = new Set();
  const sourceQueries = new Map();
  for (const acq of pack.acquisitions) {
    if (
      ![
        'monitoring-locations',
        'latest-continuous',
        'field-measurements',
      ].includes(acq.collection) ||
      typeof acq.url !== 'string' ||
      !acq.url.startsWith(
        `https://api.waterdata.usgs.gov/ogcapi/v1/collections/${acq.collection}/items?`,
      ) ||
      /[#\\\r\n]/.test(acq.url) ||
      !Number.isFinite(Date.parse(acq.retrievedAt)) ||
      !/(?:Z|[+-]\d\d:\d\d)$/.test(acq.retrievedAt)
    )
      refuse();
    sourceQueries.set(`${acq.collection}:${acq.url}:${acq.retrievedAt}`, true);
  }
  for (const site of pack.records) {
    if (
      !/^USGS-\d{4,15}$/.test(site.id) ||
      seen.has(site.id) ||
      site.metadata?.id !== site.id ||
      site.metadata.agency_code !== 'USGS' ||
      site.metadata.country_code !== 'US' ||
      site.metadata.site_type_code !== 'GW' ||
      site.sourceUrl !== stationUrl(site.id) ||
      !Number.isFinite(site.longitude) ||
      site.longitude < -180 ||
      site.longitude > 180 ||
      !Number.isFinite(site.latitude) ||
      site.latitude < -90 ||
      site.latitude > 90 ||
      !sourceQueries.has(
        `monitoring-locations:${site.metadataSourceUrl}:${site.metadataRetrievedAt}`,
      ) ||
      !Array.isArray(site.readings) ||
      site.readings.length > WELL_LIMITS.readings
    )
      refuse();
    seen.add(site.id);
    const readings = new Set();
    for (const row of site.readings) {
      const collection =
        row.kind === 'continuous'
          ? 'latest-continuous'
          : row.kind === 'discrete'
            ? 'field-measurements'
            : null;
      const meaning = Object.hasOwn(references, row.parameterCode)
        ? references[row.parameterCode]
        : null;
      if (
        !collection ||
        !meaning ||
        meaning[0] !== row.reference ||
        meaning[1] !== row.datum ||
        typeof row.id !== 'string' ||
        !/^[\w-]{1,80}$/.test(row.id) ||
        readings.has(`${collection}:${row.id}`) ||
        row.raw?.monitoring_location_id !== site.id ||
        row.raw.parameter_code !== row.parameterCode ||
        !(
          row.value === null ||
          typeof row.value === 'string' ||
          (typeof row.value === 'number' && Number.isFinite(row.value))
        ) ||
        !(row.unit === null || typeof row.unit === 'string') ||
        row.value !== row.raw.value ||
        row.numericValue !== finiteNumber(row.value) ||
        row.observedAt !== row.raw.time ||
        row.unit !== row.raw.unit_of_measure ||
        row.sourceUrl !==
          `https://api.waterdata.usgs.gov/ogcapi/v1/collections/${collection}/items/${row.id}?f=json` ||
        !sourceQueries.has(
          `${collection}:${row.queryUrl}:${row.retrievedAt}`,
        ) ||
        !validObservationTime(row.observedAt, row.timePrecision) ||
        (row.kind === 'continuous' && row.timePrecision !== 'instant')
      )
        refuse();
      readings.add(`${collection}:${row.id}`);
    }
  }
  return pack;
}

function validObservationTime(value, precision) {
  if (typeof value !== 'string') return false;
  if (precision === 'year') return /^[1-9]\d{3}$/.test(value);
  if (precision === 'month')
    return /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
  if (precision === 'day' || precision === 'instant') {
    if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    if (
      year < 1 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    )
      return false;
    if (
      precision === 'instant' &&
      (Number(value.slice(11, 13)) > 23 ||
        Number(value.slice(14, 16)) > 59 ||
        Number(value.slice(17, 19)) > 59)
    )
      return false;
    return precision === 'day'
      ? value.length === 10
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
          value,
        ) && Number.isFinite(Date.parse(value));
  }
  return false;
}

/** Text nodes receive these strings; provider content is never HTML. */
export function wellDetails(site) {
  return {
    id: site.id,
    name: typeof site.name === 'string' ? site.name : site.id,
    sourceUrl: site.sourceUrl,
    metadataRetrievedAt: site.metadataRetrievedAt,
    readings: site.readings.map((row) => ({
      id: row.id,
      label: `${row.kind} · ${row.parameterCode}`,
      value:
        row.numericValue === null
          ? 'No numeric reading supplied'
          : `${row.value} ${row.unit ?? '(unit unknown)'}`,
      reference:
        row.reference === 'depth-below-land-surface'
          ? 'Depth below land surface; not map altitude or well construction depth'
          : `Water-level elevation · ${row.datum}; no datum conversion`,
      observed: `${row.observedAt} (${row.timePrecision} precision)`,
      retrieved: row.retrievedAt,
      approval: row.raw.approval_status ?? 'Unknown approval status',
      qualifiers:
        row.raw.qualifier === null || row.raw.qualifier === undefined
          ? 'Unknown / not supplied'
          : JSON.stringify(row.raw.qualifier),
      sourceDatum: row.raw.vertical_datum ?? 'Not supplied',
      sourceUrl: row.sourceUrl,
      raw: row.raw,
    })),
  };
}
