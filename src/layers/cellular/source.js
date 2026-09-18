const MAX_VIEWPORT_DEGREES = 2;
const TECHNOLOGIES = new Set(['GSM', 'UMTS', 'LTE', 'NR', 'NBIOT', 'CDMA']);

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function siteCoordinates(element) {
  const lat = finite(element?.lat ?? element?.center?.lat);
  const lon = finite(element?.lon ?? element?.center?.lon);
  return lat !== null &&
    lon !== null &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
    ? { lat, lon }
    : null;
}

/** Infer mobile technologies only from explicit OSM tags/text; unknown stays unknown. */
export function technologiesFromOsmTags(tags = {}) {
  const explicit = [
    ['communication:gsm', 'GSM'],
    ['communication:umts', 'UMTS'],
    ['communication:lte', 'LTE'],
    ['communication:5g', 'NR'],
    ['communication:nr', 'NR'],
  ];
  const result = new Set();
  for (const [key, technology] of explicit) {
    const value = String(tags?.[key] ?? '')
      .trim()
      .toLowerCase();
    if (value && !['no', 'false', '0'].includes(value)) result.add(technology);
  }
  const blob = [
    tags?.['technology:mobile_phone'],
    tags?.technology,
    tags?.description,
    tags?.network,
    tags?.frequency,
    tags?.['communication:mobile_phone'],
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
  if (/\b(?:5G|NR)\b/.test(blob)) result.add('NR');
  if (/\b(?:4G|LTE)\b/.test(blob)) result.add('LTE');
  if (/\b(?:3G|UMTS|WCDMA|HSPA)\b/.test(blob)) result.add('UMTS');
  if (/\b(?:2G|GSM|EDGE|GPRS)\b/.test(blob)) result.add('GSM');
  return [...result];
}

function parseAzimuths(tags = {}) {
  const values = [
    tags['gsm:direction'],
    tags['umts:direction'],
    tags['lte:direction'],
    tags['5g:direction'],
    tags['nr:direction'],
    tags['antenna:direction'],
    tags.direction,
  ];
  const azimuths = new Set();
  for (const value of values) {
    for (const token of String(value ?? '').split(/[;,]/)) {
      const number = Number(token.trim().replace(/°$/, ''));
      if (Number.isFinite(number) && number >= 0 && number < 360)
        azimuths.add(Math.round(number * 10) / 10);
    }
  }
  return [...azimuths].sort((a, b) => a - b);
}

export function normalizeCellularSite(element, index = 0) {
  const coords = siteCoordinates(element);
  if (!coords) return null;
  const tags =
    element?.tags && typeof element.tags === 'object' ? element.tags : {};
  const osmType = text(element?.type) || 'feature';
  const osmId = text(element?.id) || String(index + 1);
  const operator = text(tags.operator || tags.brand || tags.network);
  const name = text(tags.name) || operator || 'Mapped cellular site';
  const heightM = finite(tags.height);
  return {
    id: `cellular:site:osm:${osmType}:${osmId}`,
    kind: 'site',
    latitude: coords.lat,
    longitude: coords.lon,
    name,
    operator,
    technologies: technologiesFromOsmTags(tags),
    structure: text(tags.man_made || tags['tower:type'] || tags.location),
    heightM:
      heightM !== null && heightM >= 0 && heightM < 2000 ? heightM : null,
    frequency: text(tags.frequency),
    ref: text(tags.ref),
    mcc: text(tags.MCC || tags.mcc),
    mnc: text(tags.MNC || tags.mnc),
    sectorAzimuths: parseAzimuths(tags),
    source: 'OpenStreetMap',
    sourceId: `${osmType}/${osmId}`,
  };
}

export function normalizeCellularCell(cell) {
  const latitude = finite(cell?.lat);
  const longitude = finite(cell?.lon);
  const mcc = finite(cell?.mcc);
  const mnc = finite(cell?.mnc);
  const cellId = finite(cell?.cellid);
  if (
    latitude === null ||
    longitude === null ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    mcc === null ||
    mnc === null ||
    cellId === null
  )
    return null;
  const radio = String(cell?.radio || '')
    .trim()
    .toUpperCase();
  if (radio && !TECHNOLOGIES.has(radio)) return null;
  const lac = finite(cell?.lac);
  const tac = finite(cell?.tac);
  const rangeM = finite(cell?.range);
  const samples = finite(cell?.samples);
  const signal = finite(cell?.averageSignalStrength);
  const unit = finite(cell?.unit);
  const pci = finite(
    cell?.pci ?? (radio === 'LTE' || radio === 'NR' ? cell?.unit : null),
  );
  const psc = finite(cell?.psc ?? (radio === 'UMTS' ? cell?.unit : null));
  const stableRadio = radio || 'UNKNOWN';
  const area = tac && tac > 0 ? tac : lac;
  return {
    id: `cellular:cell:${stableRadio}:${Math.trunc(mcc)}:${Math.trunc(mnc)}:${area ?? 'na'}:${Math.trunc(cellId)}`,
    kind: 'cell',
    latitude,
    longitude,
    radio: stableRadio,
    mcc: Math.trunc(mcc),
    mnc: Math.trunc(mnc),
    plmn: `${Math.trunc(mcc)}-${String(Math.trunc(mnc)).padStart(2, '0')}`,
    lac: lac !== null ? Math.trunc(lac) : null,
    tac: tac !== null && tac > 0 ? Math.trunc(tac) : null,
    cellId: Math.trunc(cellId),
    unit: unit !== null && unit >= 0 ? Math.trunc(unit) : null,
    pci: pci !== null && pci >= 0 ? Math.trunc(pci) : null,
    psc: psc !== null && psc >= 0 ? Math.trunc(psc) : null,
    rangeM: rangeM !== null && rangeM >= 0 ? Math.round(rangeM) : null,
    samples: samples !== null && samples >= 0 ? Math.trunc(samples) : null,
    averageSignalStrength: signal,
    source: 'OpenCellID',
  };
}

export function validCellularViewport(box) {
  const { south, west, north, east } = box || {};
  return (
    [south, west, north, east].every(Number.isFinite) &&
    south >= -90 &&
    north <= 90 &&
    west >= -180 &&
    east <= 180 &&
    north > south &&
    east > west &&
    north - south <= MAX_VIEWPORT_DEGREES &&
    east - west <= MAX_VIEWPORT_DEGREES
  );
}

export function createCellularNetworksSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  function buildQuery(box, radio, part) {
    const query = new URLSearchParams(
      Object.entries(box).map(([key, value]) => [
        key,
        Number(value).toFixed(6),
      ]),
    );
    if (radio !== 'ALL') query.set('radio', radio);
    if (part && part !== 'all') query.set('part', part);
    return query;
  }

  async function fetchPayload(
    box,
    { radio = 'ALL', part = 'all', signal } = {},
  ) {
    if (!validCellularViewport(box))
      throw new TypeError('A city-scale cellular viewport is required');
    const normalizedRadio = String(radio || 'ALL').toUpperCase();
    if (normalizedRadio !== 'ALL' && !TECHNOLOGIES.has(normalizedRadio))
      throw new TypeError('Unsupported cellular technology filter');
    signal?.throwIfAborted();
    const query = buildQuery(box, normalizedRadio, part);
    const response = await fetchImpl(`/api/cellular-networks?${query}`, {
      signal,
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Cellular network feed HTTP ${response.status}`);
    }
    signal?.throwIfAborted();
    if (!response.ok)
      throw new Error(
        body?.error || `Cellular network feed HTTP ${response.status}`,
      );
    return body;
  }

  function normalizeSites(body) {
    if (!Array.isArray(body?.elements))
      throw new Error('Malformed cellular site snapshot');
    return {
      sites: body.elements
        .map((entry, index) => normalizeCellularSite(entry, index))
        .filter(Boolean),
      sitesStatus: text(body.sitesStatus) || 'unknown',
      siteSaturated: body.siteSaturated === true,
      retrievedAt: text(body.retrievedAt),
    };
  }

  function normalizeCells(body) {
    if (!Array.isArray(body?.cells))
      throw new Error('Malformed cellular cell snapshot');
    return {
      cells: body.cells
        .map((entry) => normalizeCellularCell(entry))
        .filter(Boolean),
      cellStatus: text(body.cellStatus) || 'unknown',
      cellSaturated: body.cellSaturated === true,
      cellAreaKm2: finite(body.cellAreaKm2),
      cellTileCount: finite(body.cellTileCount),
      cellTilesQueried: finite(body.cellTilesQueried),
      cellCachedTiles: finite(body.cellCachedTiles),
      cellFailedTiles: finite(body.cellFailedTiles),
      cellSaturatedTiles: finite(body.cellSaturatedTiles),
      cellTileLimit: finite(body.cellTileLimit),
      cellViewportPartial: body.cellViewportPartial === true,
      retrievedAt: text(body.retrievedAt),
    };
  }

  return {
    async getSites(box, { signal } = {}) {
      return normalizeSites(
        await fetchPayload(box, { radio: 'ALL', part: 'sites', signal }),
      );
    },

    async getCells(box, { radio = 'ALL', signal } = {}) {
      return normalizeCells(
        await fetchPayload(box, { radio, part: 'cells', signal }),
      );
    },

    async getSnapshot(box, { radio = 'ALL', signal } = {}) {
      const body = await fetchPayload(box, { radio, part: 'all', signal });
      return {
        ...normalizeSites(body),
        ...normalizeCells(body),
      };
    },
  };
}
