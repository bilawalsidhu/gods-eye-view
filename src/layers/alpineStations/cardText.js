/**
 * The station text the Weather card and the globe labels print.
 *
 * Separate from `./records.js` because that module is portable: the proxy
 * imports it to merge network payloads, so it must not load the translation
 * catalogs. Everything here is presentation, in the reader's language.
 */

import { t } from '../../i18n/index.js';
import { formatQuantity } from '../../ui/unitLabels.js';
import { alpineNetwork } from './networks.js';
import {
  msToKmh,
  parameterDecimals,
  parameterValue,
  windCompass,
} from './parameters.js';
import { isReporting, isStale } from './records.js';

/** A reading and its unit in the active language, as "22 km/h" reads here. */
export function localizedReading(value, view) {
  if (!Number.isFinite(value)) return null;
  return formatQuantity(value, view.unit, readingDigits(view));
}

/**
 * A reading's number alone, for the open end of a range such as "4 to 76 km/h".
 *
 * Rounded and grouped exactly as `localizedReading` rounds and groups it, so
 * the two ends of one range cannot disagree. Formatting the open end with a
 * bare `formatNumber` printed "1,005.4 to 1025 hPa" in a single line.
 */
export function readingNumber(value, view) {
  if (!Number.isFinite(value)) return null;
  return formatQuantity(value, '', readingDigits(view));
}

function readingDigits(view) {
  const decimals = parameterDecimals(view);
  return {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  };
}

/** The presented value for a station under one view, formatted, or null. */
export function stationReading(station, view) {
  return localizedReading(parameterValue(station, view), view);
}

/** Wind as one phrase, in the meteorological reading the operator published. */
export function describeWind(station) {
  const kmh = msToKmh(station?.windSpeedMs);
  if (kmh === null) return null;
  const compass = windCompass(station.windDirDeg);
  const speed = formatQuantity(kmh, 'km/h', { maximumFractionDigits: 1 });
  const gustKmh = msToKmh(station.windGustMs);
  // A compass point is a code, so the reading composes without a phrase; the
  // gust is a word and carries its own entry.
  const reading = compass ? `${speed} ${compass}` : speed;
  if (gustKmh === null) return reading;
  const gust = t('gust {speed}', {
    speed: formatQuantity(gustKmh, 'km/h', { maximumFractionDigits: 1 }),
  });
  return `${reading} · ${gust}`;
}

/**
 * Card lines for one station.
 *
 * Every figure carries its unit and an absent reading is omitted entirely, so
 * a line is never printed for a measurement the station did not make.
 */
export function stationCardLines(station, view, { now = Date.now() } = {}) {
  if (!station) return [];
  const network = alpineNetwork(station.networkId);
  const lines = [];
  const place = [
    network?.label,
    station.region,
    Number.isFinite(station.elevationM)
      ? formatQuantity(Math.round(station.elevationM), 'm')
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (place) lines.push({ id: 'place', text: place, muted: true });
  if (!isReporting(station)) {
    lines.push({ id: 'silent', text: t('No current reading'), muted: true });
    return lines;
  }
  const selected = stationReading(station, view);
  lines.push({
    id: 'selected',
    // A label, a colon and a figure needs no phrase of its own; "not measured
    // here" is a sentence and carries one.
    text: selected
      ? `${t(view.label)}: ${selected}`
      : t('{parameter}: not measured here', { parameter: t(view.label) }),
    muted: !selected,
  });
  const wind = describeWind(station);
  if (wind && view.id !== 'wind')
    lines.push({ id: 'wind', text: t('Wind {reading}', { reading: wind }) });
  if (Number.isFinite(station.airTempC) && view.id !== 'temperature') {
    const air = formatQuantity(station.airTempC, '°C', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    lines.push({
      id: 'air',
      text: Number.isFinite(station.humidityPct)
        ? t('Air {reading} · {humidity}% RH', {
            reading: air,
            humidity: Math.round(station.humidityPct),
          })
        : t('Air {reading}', { reading: air }),
    });
  }
  if (Number.isFinite(station.snowDepthCm) && view.id !== 'snow') {
    lines.push({
      id: 'snow',
      text: t('Snow {reading}', {
        reading: formatQuantity(Math.round(station.snowDepthCm), 'cm'),
      }),
    });
  }
  if (station.measuredAt) {
    lines.push({
      id: 'measured',
      text: isStale(station, now)
        ? t('{time} · late', { time: utcMinute(station.measuredAt) })
        : utcMinute(station.measuredAt),
      muted: true,
    });
  }
  return lines;
}

/** `MM-DD HH:MM UTC`, the format the weather rail already reads in. */
export function utcMinute(iso) {
  const parsed = Date.parse(iso ?? '');
  if (!Number.isFinite(parsed)) return t('Unavailable');
  return `${new Date(parsed).toISOString().slice(5, 16).replace('T', ' ')} UTC`;
}
