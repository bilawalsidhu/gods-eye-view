/** Card model and labels for one selected turbulence record. Pure — no Cesium types. */

import { t } from '../../i18n/index.js';
import { formatQuantity } from '../../ui/unitLabels.js';
import { FL180_FT } from './records.js';
import { severityColor } from './model.js';

export const TURBULENCE_OVERLAY_SOURCE_ID = 'weather-turbulence';
const RAW_CARD_CHARS = 160;

/** The severity as shown: light, moderate, severe or extreme. */
export function severityLabel(severity) {
  switch (severity) {
    case 'light':
      return t('Light', { context: 'turbulence' });
    case 'severe':
      return t('Severe', { context: 'turbulence' });
    case 'extreme':
      return t('Extreme', { context: 'turbulence' });
    default:
      return t('Moderate', { context: 'turbulence' });
  }
}

/**
 * One altitude in aviation notation: SFC, a flight level from FL180, or feet
 * below it.
 */
export function altitudeLabel(feet, { surface = false } = {}) {
  if (surface || feet <= 0) return 'SFC'; // i18n-ignore: aviation abbreviation
  if (feet >= FL180_FT)
    return `FL${String(Math.round(feet / 100)).padStart(3, '0')}`; // i18n-ignore: flight level
  return formatQuantity(Math.round(feet / 100) * 100, 'ft', {
    useGrouping: true,
  });
}

/** "HH:MM UTC" of an epoch-ms time. */
export function utcTime(ms) {
  if (!Number.isFinite(ms)) return t('Unavailable');
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

function altitudeLine(record) {
  if (record.kind === 'report') return altitudeLabel(record.baseFt);
  const line = t('{lower} to {upper}', {
    lower: altitudeLabel(record.baseFt, { surface: record.baseIsSurface }),
    upper: altitudeLabel(record.topFt),
  });
  return record.topUnknown ? `${line} · ${t('Top unknown')}` : line;
}

function timeLine(record) {
  if (record.kind === 'forecast')
    return t('Valid {time}', { time: utcTime(record.validAt) });
  if (record.kind === 'warning')
    return t('Valid {from} to {to}', {
      from: utcTime(record.validFrom),
      to: utcTime(record.validTo),
    });
  const reported = t('Reported {time}', { time: utcTime(record.observedAt) });
  return record.aircraft ? `${reported} · ${record.aircraft}` : reported;
}

/** The card's title for a record. */
export function turbulenceTitle(record) {
  const severity = severityLabel(record.severity);
  if (record.kind === 'forecast')
    return t('Turbulence forecast · {severity}', { severity });
  if (record.kind === 'warning')
    return record.hazard === 'MTW'
      ? t('Mountain wave SIGMET · {severity}', { severity })
      : t('Turbulence SIGMET · {severity}', { severity });
  return t('Pilot report · {severity}', { severity });
}

/**
 * Build the overlay-host entry for one selected record. The caller supplies
 * `position` separately, so this model stays JSON-safe for tests.
 * @param {object} record - A normalized record (see records.js).
 * @returns {object} World-overlay entry without `position`.
 */
export function buildTurbulenceCard(record) {
  const details = [altitudeLine(record), timeLine(record)];
  if (record.region) details.push(record.region);
  if (record.raw)
    details.push(
      record.raw.length > RAW_CARD_CHARS
        ? `${record.raw.slice(0, RAW_CARD_CHARS - 1)}…`
        : record.raw,
    );
  details.push(t('Informational only · not for flight planning'));
  return {
    id: `weather-turbulence-card:${record.id}`,
    selected: true,
    interactive: false,
    title: turbulenceTitle(record).toUpperCase(),
    details,
    accent: severityColor(record.severity),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
