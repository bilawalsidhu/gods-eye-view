import { msg } from '../../i18n/marker.js';

export const SPC_REFRESH_MS = 300_000;
export const SPC_MAX_AGE_MS = 30 * 60_000;
export const SPC_BODY_LIMIT = 4 * 1024 * 1024;
export const SPC_SERVICE_URL =
  'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/FeatureServer';
export const SPC_PRODUCTS = Object.freeze({
  'day1-categorical': { layer: 1, day: 'day1', type: 'categorical' },
  'day1-tornado': { layer: 3, day: 'day1', type: 'tornado' },
  'day2-categorical': { layer: 9, day: 'day2', type: 'categorical' },
  'day2-tornado': { layer: 11, day: 'day2', type: 'tornado' },
});

// NOAA FeatureServer unique-value renderer (dn), verified 2026-10-21.
export const SPC_CATEGORICAL = Object.freeze([
  {
    dn: 2,
    code: 'TSTM',
    label: msg('General thunderstorms'),
    fill: '#c1e9c1',
    stroke: '#55bb55',
  },
  {
    dn: 3,
    code: 'MRGL',
    label: msg('Marginal'),
    fill: '#66a366',
    stroke: '#005500',
  },
  {
    dn: 4,
    code: 'SLGT',
    label: msg('Slight'),
    fill: '#ffe066',
    stroke: '#ddaa00',
  },
  {
    dn: 5,
    code: 'ENH',
    label: msg('Enhanced'),
    fill: '#ffa366',
    stroke: '#ff6600',
  },
  {
    dn: 6,
    code: 'MDT',
    label: msg('Moderate'),
    fill: '#e06666',
    stroke: '#cc0000',
  },
  {
    dn: 8,
    code: 'HIGH',
    label: msg('High'),
    fill: '#ee99ee',
    stroke: '#cc00cc',
  },
]);
export const SPC_TORNADO = Object.freeze([
  { dn: 2, code: '0.02', label: '2%', fill: '#79ba7a', stroke: '#1a731d' },
  { dn: 5, code: '0.05', label: '5%', fill: '#bd998a', stroke: '#7f3f27' },
  { dn: 10, code: '0.10', label: '10%', fill: '#ffe481', stroke: '#fd8a2b' },
  { dn: 15, code: '0.15', label: '15%', fill: '#ff8080', stroke: '#ff0000' },
  { dn: 30, code: '0.30', label: '30%', fill: '#ff80ff', stroke: '#ff00ff' },
  { dn: 45, code: '0.45', label: '45%', fill: '#c896f7', stroke: '#912cee' },
  { dn: 60, code: '0.60', label: '60%', fill: '#104e8b', stroke: '#104e8b' },
]);

/** Parse SPC's YYYYMMDDHHmm timestamps as UTC, rejecting calendar rollover. */
export function parseSpcTime(value) {
  if (typeof value !== 'string' || !/^\d{12}$/.test(value)) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:00.000Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso
    ? time
    : null;
}

/** Only the four audited public products can select an upstream route. */
export function spcProduct(day, type) {
  const key = `${day}-${type}`;
  return Object.hasOwn(SPC_PRODUCTS, key) ? key : null;
}

/** Official service legend shared by normalization and presentation. */
export function spcBands(type) {
  return type === 'tornado' ? SPC_TORNADO : SPC_CATEGORICAL;
}

/** Link to the authoritative current outlook for the selected forecast day. */
export function spcSourceLink(product) {
  return `https://www.spc.noaa.gov/products/outlook/${SPC_PRODUCTS[product]?.day === 'day2' ? 'day2otlk.html' : 'day1otlk.html'}`;
}

function polygonsFrom(geometry, budget) {
  const polygons =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : null;
  if (!Array.isArray(polygons) || !polygons.length)
    throw new Error('invalid_spc_geometry');
  for (const rings of polygons) {
    if (!Array.isArray(rings) || !rings.length)
      throw new Error('invalid_spc_geometry');
    for (const ring of rings) {
      if (
        !Array.isArray(ring) ||
        ring.length < 4 ||
        (budget.points += ring.length) > 100_000
      )
        throw new Error('invalid_spc_ring');
      for (const point of ring) {
        if (
          !Array.isArray(point) ||
          point.length !== 2 ||
          !Number.isFinite(point[0]) ||
          Math.abs(point[0]) > 180 ||
          !Number.isFinite(point[1]) ||
          Math.abs(point[1]) > 90
        )
          throw new Error('invalid_spc_coordinate');
      }
      if (
        ring[0][0] !== ring.at(-1)[0] ||
        ring[0][1] !== ring.at(-1)[1] ||
        new Set(ring.map((p) => p.join(','))).size < 3
      )
        throw new Error('invalid_spc_ring');
      let area = 0;
      for (let i = 1; i < ring.length; i++)
        area += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
      if (Math.abs(area) < 1e-12) throw new Error('invalid_spc_ring');
    }
  }
  return polygons;
}

/** Validate a complete GeoJSON issue. Never turn malformed/truncated hazard data into “empty”. */
export function normalizeSpcOutlook(payload, { product, fetchedAt } = {}) {
  const definition = Object.hasOwn(SPC_PRODUCTS, product)
    ? SPC_PRODUCTS[product]
    : null;
  if (
    !definition ||
    !Number.isFinite(fetchedAt) ||
    fetchedAt < 0 ||
    payload?.type !== 'FeatureCollection' ||
    !Array.isArray(payload.features) ||
    payload.features.length > 2000 ||
    payload.exceededTransferLimit === true ||
    payload.properties?.exceededTransferLimit === true ||
    payload.error ||
    payload.crs
  )
    throw new Error('invalid_spc_snapshot');
  const rows = [],
    ids = new Set(),
    budget = { points: 0 };
  let issuedAt = null,
    validFrom = null,
    validUntil = null;
  for (const feature of payload.features) {
    const p = feature?.properties;
    const band = spcBands(definition.type).find((item) => item.dn === p?.dn);
    const issue = parseSpcTime(p?.issue),
      valid = parseSpcTime(p?.valid),
      expire = parseSpcTime(p?.expire);
    const id = p?.objectid;
    const matchingLabel =
      band &&
      (definition.type === 'categorical'
        ? p.label === band.code
        : typeof p.label === 'string' &&
          /^0\.\d{1,2}$/.test(p.label) &&
          Number(p.label) === Number(band.code));
    if (
      feature?.type !== 'Feature' ||
      !Number.isSafeInteger(id) ||
      id < 0 ||
      ids.has(id) ||
      !matchingLabel ||
      issue === null ||
      valid === null ||
      expire === null ||
      valid >= expire ||
      issue >= expire ||
      expire - valid > 48 * 3600_000
    )
      throw new Error('invalid_spc_feature');
    if (
      issuedAt !== null &&
      (issuedAt !== issue || validFrom !== valid || validUntil !== expire)
    )
      throw new Error('mixed_spc_issues');
    ids.add(id);
    issuedAt = issue;
    validFrom = valid;
    validUntil = expire;
    rows.push({
      id: String(id),
      ...band,
      polygons: polygonsFrom(feature.geometry, budget),
    });
  }
  return {
    product,
    fetchedAt,
    issuedAt,
    validFrom,
    validUntil,
    rows,
    stale: payload.stale === true,
  };
}

/** Day 2 may start in the future; expiry, not start time, determines visibility. */
export function spcSnapshotState(snapshot, now = Date.now()) {
  if (!snapshot) return 'unavailable';
  if (snapshot.validUntil !== null && snapshot.validUntil <= now)
    return 'expired';
  if (
    !Number.isFinite(snapshot.fetchedAt) ||
    now - snapshot.fetchedAt >= SPC_MAX_AGE_MS ||
    snapshot.fetchedAt > now + 60_000 ||
    (snapshot.issuedAt !== null && snapshot.issuedAt > now + 300_000)
  )
    return 'unavailable';
  if (snapshot.stale || now - snapshot.fetchedAt >= SPC_REFRESH_MS * 2)
    return 'stale';
  return snapshot.rows.length ? 'ready' : 'empty';
}
