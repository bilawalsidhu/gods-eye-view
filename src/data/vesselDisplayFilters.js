import { normalizeVesselType } from './vesselTypes.js';

export const VESSEL_TYPES = Object.freeze([
  'CARGO',
  'TANKER',
  'PASSENGER',
  'FISHING',
  'SAILING',
  'PLEASURE',
  'MILITARY',
  'TOWING',
  'TUG',
  'PILOT',
  'HIGH-SPEED',
  'DREDGER',
  'DIVE OPS',
  'SAR',
  'PORT TENDER',
  'ANTI-POLLUTION',
  'LAW ENFORCE',
  'MEDICAL',
  'OTHER',
  'UNKNOWN',
]);
export const DEFAULT_VESSEL_FILTERS = Object.freeze({
  declutterEnabled: true,
  density: 'balanced',
  underwayOnly: false,
  typeFilterEnabled: false,
  types: Object.freeze(['CARGO', 'TANKER', 'PASSENGER']),
  speedFilterEnabled: false,
  minSpeedKn: 0,
  maxSpeedKn: 50,
});
/** Validate partial display preferences without changing the previous settings. */
export function normalizeVesselFilters(
  input = {},
  previous = DEFAULT_VESSEL_FILTERS,
) {
  if (!input || typeof input !== 'object') input = {};
  const next = { ...previous };
  for (const key of [
    'declutterEnabled',
    'underwayOnly',
    'typeFilterEnabled',
    'speedFilterEnabled',
  ])
    if (typeof input[key] === 'boolean') next[key] = input[key];
  if (['balanced', 'sparse'].includes(input.density))
    next.density = input.density;
  if (Array.isArray(input.types))
    next.types = VESSEL_TYPES.filter((type) => input.types.includes(type));
  for (const key of ['minSpeedKn', 'maxSpeedKn'])
    if (typeof input[key] === 'number' && Number.isFinite(input[key]))
      next[key] =
        Math.round(Math.max(0, Math.min(102.2, input[key])) * 10) / 10;
  if (next.minSpeedKn > next.maxSpeedKn)
    [next.minSpeedKn, next.maxSpeedKn] = [next.maxSpeedKn, next.minSpeedKn];
  return { ...next, types: [...next.types] };
}
/** Resolve numeric AIS codes and common type descriptions into checklist families. */
export function vesselFilterType(raw) {
  const type = normalizeVesselType(raw).toUpperCase();
  if (!type) return 'UNKNOWN';
  if (VESSEL_TYPES.includes(type)) return type;
  if (/tanker/.test(type.toLowerCase())) return 'TANKER';
  if (/cargo|container|bulk|carrier/i.test(type)) return 'CARGO';
  if (/passenger|ferry|cruise/i.test(type)) return 'PASSENGER';
  return 'OTHER';
}
/** AIS 102.3 denotes unavailable speed, rather than a fast vessel. */
export function vesselSpeedKn(record) {
  return Number.isFinite(record?.speed) &&
    record.speed >= 0 &&
    record.speed < 102.3
    ? record.speed
    : null;
}
/** Match manual filters; selected-contact exceptions belong to the display owner. */
export function vesselMatchesFilters(record, filters = DEFAULT_VESSEL_FILTERS) {
  const speed = vesselSpeedKn(record);
  if (filters.underwayOnly && (speed === null || speed <= 1)) return false;
  if (
    filters.typeFilterEnabled &&
    !filters.types.includes(vesselFilterType(record?.type))
  )
    return false;
  if (
    filters.speedFilterEnabled &&
    (speed === null || speed < filters.minSpeedKn || speed > filters.maxSpeedKn)
  )
    return false;
  return true;
}
function identityHash(id) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++)
    hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
/** Stable Earth-fixed cells prevent pan-driven reshuffling; near views retain all matches. */
export function selectVesselDisplay(
  candidates,
  { filters, altitudeM, metresPerPixel },
) {
  const allowed = new Set(),
    cells = new Map();
  const thin =
    filters.declutterEnabled && altitudeM >= 100000 && metresPerPixel > 0;
  const cellM = thin
    ? Math.max(
        1000,
        2 **
          Math.round(
            Math.log2(
              metresPerPixel * (filters.density === 'sparse' ? 80 : 44),
            ),
          ),
      )
    : 0;
  for (const candidate of candidates) {
    const { record, position } = candidate;
    if (candidate.protected) {
      allowed.add(record);
      continue;
    }
    if (!vesselMatchesFilters(record, filters)) continue;
    if (!thin) {
      allowed.add(record);
      continue;
    }
    const key = `${Math.floor(position.x / cellM)}:${Math.floor(position.y / cellM)}:${Math.floor(position.z / cellM)}`;
    const id = String(
        record.mmsi || record.reference || `${record.lat}:${record.lon}`,
      ),
      hash = identityHash(id);
    const previous = cells.get(key);
    if (
      !previous ||
      hash < previous.hash ||
      (hash === previous.hash && id < previous.id)
    )
      cells.set(key, { record, id, hash });
  }
  for (const winner of cells.values()) allowed.add(winner.record);
  return allowed;
}
