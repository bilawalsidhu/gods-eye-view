/** Rainfolk historical source admission for the existing GEV well layer.
 * Newly authored Rainfolk code, MIT, copyright 2026 Joshua Koelker.
 */
const resource = '8b02895f02c14dd1a749bcc5584a5c55';
const landing = `https://www.hydroshare.org/resource/${resource}/`;
const hex = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const zoned = (s) =>
  typeof s === 'string' &&
  /(?:Z|[+-]\d\d:\d\d)$/.test(s) &&
  Number.isFinite(Date.parse(s));
const numeric = (s) =>
  typeof s === 'string' &&
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s.trim())
    ? Number(s)
    : NaN;
const refuse = () => {
  throw new TypeError('Invalid historical well record pack');
};

export function displayCoordinate(longitude, latitude, state) {
  const lon = numeric(longitude),
    lat = numeric(latitude);
  let code, translation, accuracy;
  if (
    state === 'Hawaii' &&
    lon >= -160.31 &&
    lon <= -154.75 &&
    lat >= 18.86 &&
    lat <= 22.3
  ) {
    code = 'EPSG:1252';
    translation = [1, 1, -1];
    accuracy = 4;
  } else if (
    state === 'Alaska' &&
    lat >= 51.3 &&
    lat <= 54.34 &&
    ((lon >= 172.42 && lon <= 180) || (lon >= -180 && lon <= -164.84))
  ) {
    code = 'EPSG:1251';
    translation = [-2, 0, 4];
    accuracy = 8;
  } else if (
    state !== 'Hawaii' &&
    lon >= -172.54 &&
    lon <= -47.74 &&
    lat >= 23.81 &&
    lat <= 86.46
  ) {
    code = 'EPSG:1188';
    translation = [0, 0, 0];
    accuracy = 4;
  } else return null;
  const a = 6378137,
    f = 1 / 298.257222101,
    e = f * (2 - f),
    p = (lat * Math.PI) / 180,
    l = (lon * Math.PI) / 180;
  const n = a / Math.sqrt(1 - e * Math.sin(p) ** 2);
  const x = n * Math.cos(p) * Math.cos(l) + translation[0],
    y = n * Math.cos(p) * Math.sin(l) + translation[1],
    z = n * (1 - e) * Math.sin(p) + translation[2];
  const f2 = 1 / 298.257223563,
    e2 = f2 * (2 - f2),
    xy = Math.hypot(x, y);
  let phi = Math.atan2(z, xy * (1 - e2));
  for (let i = 0; i < 6; i++) {
    const n2 = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    phi = Math.atan2(z + e2 * n2 * Math.sin(phi), xy);
  }
  return {
    longitude: (Math.atan2(y, x) * 180) / Math.PI,
    latitude: (phi * 180) / Math.PI,
    code,
    translation,
    accuracy,
  };
}

// A ZIP URL is admissible only with explicit, closed derivation evidence.
function sourceArtifact(a) {
  const d = a.derivation;
  if (!Object.hasOwn(a, 'derivation'))
    return new RegExp(
      `^https://www\\.hydroshare\\.org/resource/${resource}/data/contents/USGWD-Tabular/USGWD_[A-Za-z_]+\\.csv$`,
    ).test(a.url);
  const match = new RegExp(
    `^https://www\\.hydroshare\\.org/resource/${resource}/data/contents/USGWD-Geospatial/USGWD_([A-Za-z_]+)\\.zip$`,
  ).exec(a.url);
  const keys = [
    'policy',
    'archiveSha256',
    'archiveMd5',
    'member',
    'memberSha256',
    'sourceCrs',
    'recordCount',
  ];
  return (
    !!match &&
    d &&
    typeof d === 'object' &&
    Object.keys(d).length === keys.length &&
    keys.every((k) => Object.hasOwn(d, k)) &&
    d.policy === 'usgwd-dbf-attributes-v1' &&
    d.sourceCrs === 'EPSG:4269' &&
    hex(d.archiveSha256) &&
    hex(d.memberSha256) &&
    typeof d.archiveMd5 === 'string' &&
    /^[a-f0-9]{32}$/.test(d.archiveMd5) &&
    d.member === `USGWD_${match[1].replaceAll('_', ' ')}.dbf` &&
    Number.isSafeInteger(d.recordCount) &&
    d.recordCount > 0 &&
    d.recordCount <= 2000000
  );
}

/** Every source has its own closed validator; mixed packs never bypass USGS admission. */
export function validateHistoricalWellPack(pack, validateUsgs) {
  if (
    pack?.schemaVersion !== 1 ||
    pack.kind !== 'gev-us-groundwater-wells' ||
    pack.mode !== 'snapshot' ||
    pack.coverage?.country !== 'US' ||
    pack.coverage.complete !== false ||
    !Array.isArray(pack.records) ||
    pack.records.length > 2000 ||
    !Array.isArray(pack.acquisitions) ||
    pack.acquisitions.length < 1 ||
    pack.acquisitions.length > (pack.coverage.indexed ? 256 : 12)
  )
    refuse();
  const source = [],
    legacy = [];
  for (const a of pack.acquisitions) {
    if (a?.collection !== 'usgwd-historical-baseline') {
      legacy.push(a);
      continue;
    }
    if (
      typeof a.url !== 'string' ||
      !sourceArtifact(a) ||
      !zoned(a.retrievedAt) ||
      !hex(a.releaseSha256) ||
      !hex(a.inputSha256) ||
      !hex(a.normalizationManifestSha256) ||
      a.license !== 'CC-BY-4.0' ||
      typeof a.attribution !== 'string' ||
      !a.attribution ||
      a.attribution.length > 4096
    )
      refuse();
    source.push(a);
  }
  if (!source.length) refuse();
  const seen = new Set(),
    oldRecords = [];
  for (const site of pack.records) {
    if (typeof site?.id !== 'string' || seen.has(site.id)) refuse();
    seen.add(site.id);
    if (site.id.startsWith('USGS-')) {
      oldRecords.push(site);
      continue;
    }
    const m = site.metadata,
      coords = m?.sourceCoordinates,
      operation = m?.coordinateOperation;
    if (
      !/^USGWD-[a-f0-9]{64}-[A-Za-z0-9_-]{1,64}$/.test(site.id) ||
      site.source !== 'USGWD' ||
      site.sourceUrl !== landing ||
      site.coordinateReference !== 'EPSG:4326' ||
      !Array.isArray(site.readings) ||
      site.readings.length ||
      m?.id !== site.id ||
      typeof m.sourceRecordId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(m.sourceRecordId) ||
      m.recordType !== 'historical-well-catalog-record' ||
      !hex(m.releaseSha256) ||
      site.id !== `USGWD-${m.releaseSha256}-${m.sourceRecordId}` ||
      coords?.crs !== 'EPSG:4269' ||
      coords.datum !== 'NAD83' ||
      coords.unit !== 'decimal-degrees' ||
      typeof m.sourceState !== 'string' ||
      !/^[A-Za-z ]{1,64}$/.test(m.sourceState) ||
      m.activeWellStatus !== 'not-verified' ||
      m.waterSafetyStatus !== 'not-assessed'
    )
      refuse();
    const projected = displayCoordinate(
      coords.longitude,
      coords.latitude,
      m.sourceState,
    );
    if (
      !projected ||
      !Number.isFinite(site.longitude) ||
      !Number.isFinite(site.latitude) ||
      Math.abs(projected.longitude - site.longitude) > 1e-9 ||
      Math.abs(projected.latitude - site.latitude) > 1e-9 ||
      operation?.operation !== projected.code ||
      operation.sourceCrs !== 'EPSG:4269' ||
      operation.targetCrs !== 'EPSG:4326' ||
      operation.method !== 'EPSG:9603' ||
      JSON.stringify(operation.translationMetres) !==
        JSON.stringify(projected.translation) ||
      operation.operationAccuracyMetres !== projected.accuracy ||
      operation.intermediateHeightMetres !== 0 ||
      operation.outputHeight !== null ||
      operation.epoch !== null
    )
      refuse();
    const flags = m.locationFlags;
    if (
      !flags ||
      !['Yes', 'No', 'Unknown'].includes(flags['Location Verified']?.trim()) ||
      !['Flag County', 'Flag State', 'Flag US'].every((k) =>
        ['0', '1', '2'].includes(flags[k]?.trim()),
      ) ||
      !['0', '1', '2', '3'].includes(flags['Flag Duplicate']?.trim()) ||
      flags['Flag State'].trim() === '1' ||
      flags['Flag US'].trim() === '1'
    )
      refuse();
    if (
      !hex(m.provenance?.inputSha256) ||
      !hex(m.normalizedContentSha256) ||
      !Number.isSafeInteger(m.provenance.sourceRow) ||
      m.provenance.sourceRow < 2 ||
      m.provenance.sourceRow > 2000001 ||
      m.provenance.releaseSha256 !== m.releaseSha256 ||
      !source.some(
        (a) =>
          a.url === site.metadataSourceUrl &&
          a.retrievedAt === site.metadataRetrievedAt &&
          a.releaseSha256 === m.releaseSha256 &&
          a.inputSha256 === m.provenance.inputSha256 &&
          a.url.endsWith(
            `/USGWD_${m.sourceState.replaceAll(' ', '_')}.${a.derivation ? 'zip' : 'csv'}`,
          ) &&
          (!a.derivation ||
            m.provenance.sourceRow <= a.derivation.recordCount + 1),
      )
    )
      refuse();
    if (!Array.isArray(m.quantityErrors) || m.quantityErrors.length > 5)
      refuse();
    for (const [key, unit] of [
      ['Well Depth (Feet)', 'ft'],
      ['Screen Depth (Feet)', 'ft'],
      ['Length of Screen (Feet)', 'ft'],
      ['Well Capacity (GPM)', 'gal/min'],
      ['Surface Elevation (Feet)', 'ft'],
    ]) {
      const q = m.quantities?.[key];
      if (
        !q ||
        q.unit !== unit ||
        !['valid', 'invalid', 'missing'].includes(q.quality)
      )
        refuse();
      if (q.quality === 'valid') {
        if (
          !Number.isFinite(q.value) ||
          (key !== 'Surface Elevation (Feet)' && q.value < 0) ||
          q.issue !== null
        )
          refuse();
      } else if (
        q.value !== null ||
        (q.quality === 'missing' && q.issue !== null) ||
        (q.quality === 'invalid' &&
          !['negative', 'nonfinite', 'not-numeric'].includes(q.issue))
      )
        refuse();
      const errors = m.quantityErrors.filter((e) => e.field === key);
      if (
        q.quality === 'invalid'
          ? errors.length !== 1 ||
            errors[0].reason !== q.issue ||
            typeof errors[0].rawValue !== 'string' ||
            errors[0].rawValue.length > 4096
          : errors.length !== 0
      )
        refuse();
    }
    if (m.quantityErrors.some((e) => !Object.hasOwn(m.quantities, e.field)))
      refuse();
  }
  if (legacy.length || oldRecords.length) {
    if (typeof validateUsgs !== 'function') refuse();
    validateUsgs({ ...pack, acquisitions: legacy, records: oldRecords });
  }
  return pack;
}

export function historicalWellDetails(site) {
  return {
    id: site.id,
    name: site.name,
    sourceUrl: site.sourceUrl,
    metadataRetrievedAt: site.metadataRetrievedAt,
    readings: [],
    warnings: [
      'Historical source record; physical-well identity unresolved.',
      'Location unverified; original NAD83 retained.',
      `${site.metadata.coordinateOperation.operation}: approximate datum conversion; source accuracy unknown.`,
      ...site.metadata.quantityErrors.map(
        (e) =>
          `${e.field}: invalid (${e.reason}); original ${e.rawValue.length > 80 ? e.rawValue.slice(0, 80) + '... (full value retained in evidence)' : e.rawValue}`,
      ),
    ],
  };
}
