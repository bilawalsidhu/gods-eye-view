/** A readsb rate field: a finite JSON number, else null. */
function rateField(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Vertical rate in ft/min from a readsb-style aircraft row (readsb, tar1090,
 * adsb.lol): the barometric `baro_rate`, else the GNSS-sourced `geom_rate`
 * readsb sends instead when it has no barometric rate. A barometric 0 is kept.
 * Only a finite number counts; null when neither field has one.
 * @param {object|null|undefined} row
 * @returns {number|null}
 */
export function readAdsbVerticalRateFpm(row) {
  return rateField(row?.baro_rate) ?? rateField(row?.geom_rate);
}

/** OpenSky's ICAO address, including contacts that have no current fix. */
export function openSkyAircraftId(row) {
  return Array.isArray(row) && typeof row[0] === 'string'
    ? row[0].trim().toLowerCase()
    : '';
}

/** The ICAO address of a state vector with a plottable position. */
export function positionedOpenSkyAircraftId(row) {
  if (!Array.isArray(row)) return '';
  const lon = row[5];
  const lat = row[6];
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return '';
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return '';
  return openSkyAircraftId(row);
}
