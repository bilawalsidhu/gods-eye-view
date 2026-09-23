import {
  RECEIVER_TYPES,
  RECEIVER_TYPE_LABELS,
  cleanReceiverText,
} from '../../sources/webReceivers.js';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Re-validate one broker row; the browser never trusts the wire blindly. */
export function isValidWebReceiver(row) {
  if (!row || typeof row !== 'object') return false;
  if (!/^[a-f0-9]{8,32}$/i.test(String(row.id || ''))) return false;
  if (!RECEIVER_TYPES.includes(row.type)) return false;
  if (!/^https?:\/\//i.test(String(row.url || ''))) return false;
  const lat = finiteNumber(row.lat);
  const lon = finiteNumber(row.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return false;
  if (lat === 0 && lon === 0) return false;
  return cleanReceiverText(row.name, 160).length > 0;
}

/** Freeze a validated row into the shape the layer, the panel and the voice tools use. */
export function freezeWebReceiver(row) {
  const bands = Array.isArray(row.bands)
    ? row.bands
        .filter(
          (band) =>
            finiteNumber(band?.lowHz) !== null &&
            finiteNumber(band?.highHz) !== null,
        )
        .map((band) =>
          Object.freeze({
            lowHz: Number(band.lowHz),
            highHz: Number(band.highHz),
            label: cleanReceiverText(band.label, 40),
          }),
        )
    : [];
  const users = finiteNumber(row.users);
  const usersMax = finiteNumber(row.usersMax);
  return Object.freeze({
    id: String(row.id).toLowerCase(),
    type: row.type,
    typeLabel: RECEIVER_TYPE_LABELS[row.type],
    name: cleanReceiverText(row.name, 160),
    site: cleanReceiverText(row.site, 160),
    url: String(row.url),
    lat: Number(row.lat),
    lon: Number(row.lon),
    bands: Object.freeze(bands),
    users: users === null ? null : Math.max(0, Math.round(users)),
    usersMax: usersMax === null ? null : Math.max(0, Math.round(usersMax)),
    online: row.online === false ? false : row.online === true ? true : null,
    antenna: cleanReceiverText(row.antenna, 160),
    sources: Object.freeze(
      Array.isArray(row.sources)
        ? row.sources.map((entry) => cleanReceiverText(entry, 20))
        : [],
    ),
  });
}

/** Accept a catalog body: valid rows become frozen receivers, the rest are dropped. */
export function acceptCatalogRows(body) {
  const rows = Array.isArray(body?.receivers) ? body.receivers : [];
  return rows.filter(isValidWebReceiver).map(freezeWebReceiver);
}
