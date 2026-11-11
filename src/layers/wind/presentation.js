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

/** "1012.4 hPa" / "-3.0 °C" from the English reading, in the active language. */
function displayScalar(reading) {
  if (reading.scalarKind === 'speed' && Number.isFinite(reading.speed))
    return displaySpeed(reading.speed, reading.units);
  const match = /^(-?\d+(?:\.\d+)?) (°C|hPa)$/.exec(reading.scalarValue);
  if (!match) return reading.scalarValue;
  const decimals = match[1].split('.')[1]?.length || 0;
  return formatQuantity(Number(match[1]), match[2], {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** The wind line in the active language; the reading itself stays English. */
function windText(reading) {
  if (!Number.isFinite(reading.speed))
    return reading.wind === 'Aim the map center at Earth'
      ? t('Aim the map center at Earth')
      : reading.wind;
  const speed = displaySpeed(reading.speed, reading.units);
  return reading.from === 'Calm'
    ? `${speed}${t(' · calm')}`
    : `${speed}${t(' from {direction}', { direction: t(reading.from) })}`;
}

/** "29.93°N · 97.74°W" from the English reading, in the active language. */
function displayCoordinates(coordinates) {
  const match = /^(\d+(?:\.\d+)?)°([NS]) · (\d+(?:\.\d+)?)°([EW])$/.exec(
    coordinates,
  );
  if (!match) return coordinates.replace(' · ', ' ');
  const part = (value, hemisphere) => {
    const decimals = value.split('.')[1]?.length || 0;
    const amount = formatNumber(Number(value), {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
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
  return `${part(match[1], match[2])} ${part(match[3], match[4])}`;
}

/** "2026-10-14 14:00 UTC" from the reading, as "10-14 14:00 UTC" / "14.10 …". */
function displayValidTime(validTime) {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/.exec(validTime || '');
  if (!match) return validTime?.replace(/^\d{4}-/, '');
  return `${formatUtcDayMonth(match[1])} ${match[2]} UTC`;
}

/** Portable result block consumed by the WEATHER card. */
export function windReadingResult(reading) {
  const coordinates =
    reading.coordinates === 'No surface reading'
      ? t('No surface reading')
      : displayCoordinates(reading.coordinates);
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
