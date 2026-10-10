import { t } from '../../i18n/index.js';
import { formatWindSpeed, WIND_UNITS } from './inspection.js';

/** Reformat a captured sample; changing units never samples the map again. */
export function formatWindReading(reading, units) {
  if (!reading) return null;
  const speed = Number.isFinite(reading.speed)
    ? formatWindSpeed(reading.speed, units)
    : null;
  return {
    ...reading,
    units,
    scalarValue:
      reading.scalarKind === 'speed'
        ? formatWindSpeed(reading.speed, units)
        : reading.scalarValue,
    wind: speed
      ? reading.from === 'Calm'
        ? t('atmos.wind.reading.calm', { speed })
        : t('atmos.wind.reading.from', { speed, bearing: reading.from })
      : reading.wind,
  };
}

export function windUnitChips(units) {
  return Object.keys(WIND_UNITS).map((value) => ({
    id: `units-${value}`,
    label: value,
    active: units === value,
    params: { units: value },
    title: t('atmos.wind.chips.unitsTitle'),
  }));
}

/** Portable result block consumed by the WEATHER card. */
export function windReadingResult(reading) {
  return {
    id: 'reading',
    label: t('atmos.wind.reading.label', {
      coordinates: reading.coordinates.replace(' · ', ' '),
    }),
    lines: [
      {
        id: 'wind',
        text: reading.wind,
      },
      {
        id: 'meta',
        text: t('atmos.wind.reading.meta', {
          model: reading.model,
          time: reading.validTime?.replace(/^\d{4}-/, ''),
        }),
      },
      ...(reading.scalarValue
        ? [
            {
              id: 'scalar',
              text: t('atmos.wind.reading.scalar', {
                scalarLabel: reading.scalarLabel,
                scalarValue: reading.scalarValue,
              }),
            },
          ]
        : []),
      { id: 'explanation', text: reading.explanation },
    ],
    clear: { params: { inspect: false } },
  };
}
