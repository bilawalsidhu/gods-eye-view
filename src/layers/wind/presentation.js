import { formatWindSpeed, WIND_UNITS } from './inspection.js';
import { formatNumber, formatUtcDayMonth, t } from '../../i18n/index.js';
import { formatQuantity, unitLabel } from '../../ui/unitLabels.js';

/** Reformat a captured sample; changing units never samples the map again. */
export function formatWindReading(reading, units) {
  if (!reading) return null;
  return {
    ...reading,
    units,
    scalarValue:
      reading.scalarKind === 'speed'
        ? formatWindSpeed(reading.speed, units)
        : reading.scalarValue,
    wind: Number.isFinite(reading.speed)
      ? `${formatWindSpeed(reading.speed, units)}${reading.from === 'Calm' ? ' · calm' : ` from ${reading.from}`}`
      : reading.wind,
  };
}

export function windUnitChips(units) {
  return Object.keys(WIND_UNITS).map((value) => ({
    id: `units-${value}`,
    label: unitLabel(value),
    active: units === value,
    params: { units: value },
    title: t('Wind speed units'),
  }));
}

/** formatWindSpeed's value in the active language: "22,0 км/ч". */
function displaySpeed(speed, units) {
  const unit = Object.hasOwn(WIND_UNITS, units) ? units : 'km/h';
  return formatQuantity(speed * WIND_UNITS[unit], unit, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** "1012.4 hPa" / "-3.0 °C" from the reading's number, in the active language. */
function displayScalar(reading) {
  if (reading.scalarKind === 'speed' && Number.isFinite(reading.speed))
    return displaySpeed(reading.speed, reading.units);
  if (!Number.isFinite(reading.scalar)) return reading.scalarValue;
  return formatQuantity(
    reading.scalar,
    reading.scalarKind === 'temperature' ? '°C' : 'hPa',
    { minimumFractionDigits: 1, maximumFractionDigits: 1 },
  );
}

/**
 * One wind sample in the active language: "12,0 km/h from NW", or calm.
 * @param {number} speed Metres per second.
 * @param {string} from A compass point from windFrom, or 'Calm'.
 * @param {string} [units]
 */
export function windValueText(speed, from, units = 'km/h') {
  const shown = displaySpeed(speed, units);
  return from === 'Calm'
    ? `${shown}${t(' · calm')}`
    : `${shown}${t(' from {direction}', { direction: t(from) })}`;
}

/** The wind line in the active language; the reading itself stays English. */
function windText(reading) {
  if (!Number.isFinite(reading.speed)) return t(reading.wind);
  return windValueText(reading.speed, reading.from, reading.units);
}

/** "29.93°N 97.74°W" from the reading's degrees, in the active language. */
function displayCoordinates(lat, lon) {
  const part = (value, hemisphere) => {
    const amount = formatNumber(Math.abs(value), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: false,
    });
    switch (hemisphere) {
      case 'N':
        return t('{value}°N', { value: amount });
      case 'S':
        return t('{value}°S', { value: amount });
      case 'E':
        return t('{value}°E', { value: amount });
      default:
        return t('{value}°W', { value: amount });
    }
  };
  return `${part(lat, lat < 0 ? 'S' : 'N')} ${part(lon, lon < 0 ? 'W' : 'E')}`;
}

/** "2026-10-14 14:00 UTC" from the reading, as "10-14 14:00 UTC" / "14.10 …". */
function displayValidTime(validTime) {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/.exec(validTime || '');
  if (!match) return validTime?.replace(/^\d{4}-/, '');
  return `${formatUtcDayMonth(match[1])} ${match[2]} UTC`;
}

/** Portable result block consumed by the WEATHER card. */
export function windReadingResult(reading) {
  const coordinates = Number.isFinite(reading.lat)
    ? displayCoordinates(reading.lat, reading.lon)
    : t(reading.coordinates);
  return {
    id: 'reading',
    label: t('WIND AT {coordinates}', { coordinates }),
    lines: [
      {
        id: 'wind',
        text: windText(reading),
      },
      {
        id: 'meta',
        text: t('{model} · valid {time}', {
          model: reading.model,
          time: displayValidTime(reading.validTime),
        }),
      },
      ...(reading.scalarValue
        ? [
            {
              id: 'scalar',
              text: `${t(reading.scalarLabel)} · ${displayScalar(reading)}`,
            },
          ]
        : []),
      { id: 'explanation', text: t(reading.explanation) },
    ],
    clear: { params: { inspect: false } },
  };
}
