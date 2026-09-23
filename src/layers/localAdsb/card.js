import { HEARD_BY_RECEIVER, LOCAL_ADSB_COLOR } from './policy.js';

const DASH = '—';

function rounded(value, digits = 0) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function grouped(value) {
  return value === null ? DASH : value.toLocaleString('en-US');
}

/**
 * Title of a locally heard aircraft: callsign when decoded, else ICAO hex.
 * @param {object} record Local ADS-B record.
 * @returns {string}
 */
export function localAdsbTitle(record) {
  return record?.callsign || String(record?.icao || '').toUpperCase();
}

/**
 * Click-card presentation for one locally heard aircraft.
 * @param {object} record Local ADS-B record.
 * @param {number} nowMs Current epoch ms, for the position age.
 * @returns {{title:string, details:string[], accent:string}}
 */
export function localAdsbCardModel(record, nowMs) {
  const icao = String(record?.icao || '').toUpperCase();
  const altitude = rounded(record?.altitudeFt);
  const speed = rounded(record?.groundSpeedKt);
  const track = rounded(record?.trackDeg);
  const vertical = rounded(record?.verticalRateFpm);
  const ageS = Number.isFinite(record?.lastPositionAt)
    ? Math.max(0, Math.round((nowMs - record.lastPositionAt) / 1000))
    : null;
  const messages = Math.max(0, Math.trunc(Number(record?.messageCount) || 0));
  return {
    title: localAdsbTitle(record),
    details: [
      `ICAO ${icao} · ${record?.callsign || 'NO CALLSIGN'}`,
      `ALT ${grouped(altitude)} FT · GS ${speed === null ? DASH : speed} KT · TRK ${track === null ? DASH : `${track}°`}`,
      `V/S ${vertical === null ? DASH : `${vertical > 0 ? '+' : ''}${grouped(vertical)} FPM`}`,
      `POSITION ${ageS === null ? DASH : `${ageS} S AGO`} · ${messages} ${messages === 1 ? 'MSG' : 'MSGS'}`,
      HEARD_BY_RECEIVER,
    ],
    accent: LOCAL_ADSB_COLOR,
  };
}
