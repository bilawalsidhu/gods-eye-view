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
