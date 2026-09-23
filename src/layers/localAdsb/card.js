import { AIRCRAFT_CLASS_LABELS } from '../../data/aircraftClass.js';
import {
  BAND_LABELS,
  HEARD_BY_RECEIVER,
  LOCAL_ADSB_COLOR,
  SOURCE_LABELS,
} from './policy.js';

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

function recordBands(record) {
  if (Array.isArray(record?.bands) && record.bands.length) return record.bands;
  return record?.band ? [record.band] : [];
}

function recordSources(record) {
  if (Array.isArray(record?.sources) && record.sources.length)
    return record.sources;
  return record?.source ? [record.source] : [];
}

/**
 * Whether an aircraft was heard only on 978 MHz UAT (its marker gets the
 * UAT ring). One also heard on 1090 MHz draws as a 1090 aircraft.
 * @param {object} record Local ADS-B record.
 * @returns {boolean}
 */
export function localAdsbIsUat(record) {
  const bands = recordBands(record);
  return bands.includes('978') && !bands.includes('1090');
}

/**
 * Receiver line of the click card, e.g. "Heard by your receiver · 1090 MHz ·
 * browser SDR" or "… · 1090 MHz + 978 MHz UAT · browser SDR + decoder feed".
 * @param {object} record Local ADS-B record (merged: `bands`, `sources`).
 * @returns {string}
 */
export function localAdsbReceiverLine(record) {
  const bands = recordBands(record)
    .map((band) => BAND_LABELS[band])
    .filter(Boolean);
  const sources = recordSources(record)
    .map((source) => SOURCE_LABELS[source])
    .filter(Boolean);
  return [HEARD_BY_RECEIVER, bands.join(' + '), sources.join(' + ')]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Where a heard aircraft came from, for the entity context's source field.
 * @param {object} record Local ADS-B record.
 * @returns {string}
 */
export function localAdsbSourceText(record) {
  const sources = recordSources(record);
  if (sources.includes('webusb') && sources.includes('feed'))
    return 'Your RTL-SDR receiver and decoder feed';
  if (sources.includes('feed')) return 'Your decoder feed';
  return 'Your RTL-SDR receiver';
}

/**
 * Class line of the click card, e.g. "Helicopter · A7". Empty when neither an
 * ICAO type nor an emitter category backs the class.
 * @param {object} record Local ADS-B record.
 * @param {{klass?:string, evidence?:boolean}} [aircraftClass]
 * @returns {string}
 */
export function localAdsbClassLine(record, aircraftClass = {}) {
  if (!aircraftClass.evidence) return '';
  const label = AIRCRAFT_CLASS_LABELS[aircraftClass.klass];
  return [label, record?.category].filter(Boolean).join(' · ');
}

/**
 * Click-card presentation for one locally heard aircraft.
 * @param {object} record Local ADS-B record.
 * @param {number} nowMs Current epoch ms, for the position age.
 * @param {object} [extras]
 * @param {{klass:string, evidence:boolean}} [extras.aircraftClass] Class and
 *   whether a type or category backs it.
 * @param {object|null} [extras.meta] adsbdb metadata (typeCode, typeName,
 *   airline).
 * @param {object|null} [extras.route] A route already judged plausible.
 * @returns {{title:string, details:string[], accent:string}}
 */
export function localAdsbCardModel(
  record,
  nowMs,
  { aircraftClass = null, meta = null, route = null } = {},
) {
  const icao = String(record?.icao || '').toUpperCase();
  const altitude = rounded(record?.altitudeFt);
  const speed = rounded(record?.groundSpeedKt);
  const track = rounded(record?.trackDeg);
  const vertical = rounded(record?.verticalRateFpm);
  const ageS = Number.isFinite(record?.lastPositionAt)
    ? Math.max(0, Math.round((nowMs - record.lastPositionAt) / 1000))
    : null;
  const messages = Math.max(0, Math.trunc(Number(record?.messageCount) || 0));
  // Same identity and route lines the public flight card shows.
  const identity = [meta?.airline, meta?.typeName || meta?.typeCode]
    .filter(Boolean)
    .join(' · ');
  const routeLine =
    route?.origin?.code && route?.destination?.code
      ? `${route.origin.code} → ${route.destination.code}`
      : '';
  return {
    title: localAdsbTitle(record),
    details: [
      `ICAO ${icao} · ${record?.callsign || 'NO CALLSIGN'}`,
      localAdsbClassLine(record, aircraftClass || {}),
      identity,
      routeLine,
      `ALT ${grouped(altitude)} FT · GS ${speed === null ? DASH : speed} KT · TRK ${track === null ? DASH : `${track}°`}`,
      `V/S ${vertical === null ? DASH : `${vertical > 0 ? '+' : ''}${grouped(vertical)} FPM`}`,
      `POSITION ${ageS === null ? DASH : `${ageS} S AGO`} · ${messages} ${messages === 1 ? 'MSG' : 'MSGS'}`,
      localAdsbReceiverLine(record),
    ].filter(Boolean),
    accent: LOCAL_ADSB_COLOR,
  };
}
