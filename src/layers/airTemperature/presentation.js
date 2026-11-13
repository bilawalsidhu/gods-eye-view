import { t, formatNumber } from '../../i18n/index.js';
import { TEMPERATURE_STOPS } from './fields.js';
import { temperatureInUnits } from './model.js';

export function temperatureControls({
  snapshot,
  units,
  reading,
  loading,
  error,
  armed,
  history,
}) {
  const unitChips = ['°C', '°F'].map((value) => ({
    id: `units-${value}`,
    label: value,
    active: value === units,
    params: { units: value },
  }));
  const actions = [
    {
      id: 'read-center',
      label: t('Read temperature at map center'),
      params: { inspect: true },
      disabled: loading || !snapshot?.scalar,
    },
    {
      id: 'read-point',
      label: armed ? t('Cancel') : t('Read temperature at a point'),
      active: armed,
      params: { pick: !armed },
      disabled: loading || !snapshot?.scalar,
    },
  ];
  const status = loading
    ? t('Loading forecast')
    : error
      ? t(error)
      : snapshot?.unavailable
        ? t('Air temperature upstream unavailable')
        : snapshot?.stale
          ? t('Cached forecast · stale')
          : armed
            ? t('Click Earth to read temperature · Esc to cancel')
            : null;
  const cycle = snapshot?.cycle;
  return {
    readout: true,
    legendZeroIndex: 3,
    chips: [...unitChips, ...actions],
    legend: snapshot?.scalar
      ? TEMPERATURE_STOPS.map(({ value, color }) => ({
          color,
          label: formatNumber(temperatureInUnits(value, units), {
            useGrouping: false,
          }),
        }))
      : [],
    summary: {
      label: t('Air temperature · 2 m'),
      coverage: t('Global · 1° grid'),
      units,
      forecast: true,
      validTime: cycle?.validIso,
      issuedTime: cycle?.runIso,
      detail: t('Model forecast'),
      status,
      settings: [{ id: 'units', label: t('UNITS'), chips: unitChips }],
      actions,
      lines: [
        {
          id: 'model',
          text: t('NOAA GFS · forecast +{hour} h', {
            hour: cycle?.forecastHour ?? '—',
          }),
        },
        ...(history
          ? [
              {
                id: 'history',
                text: t('Forecast · does not follow history'),
                muted: true,
              },
            ]
          : []),
      ],
      result: reading
        ? {
            id: 'reading',
            label: t('Air temperature · 2 m'),
            lines: [
              {
                id: 'value',
                text: `${formatNumber(reading.celsius, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C / ${formatNumber(temperatureInUnits(reading.celsius, '°F'), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °F`,
              },
              {
                id: 'coordinates',
                text: `${t(reading.lat < 0 ? '{value}°S' : '{value}°N', { value: formatNumber(Math.abs(reading.lat), { maximumFractionDigits: 2 }) })} · ${t(reading.lon < 0 ? '{value}°W' : '{value}°E', { value: formatNumber(Math.abs(reading.lon), { maximumFractionDigits: 2 }) })}`,
              },
              { id: 'model', text: t('Model forecast') },
              {
                id: 'valid',
                text: t('GFS forecast, valid {time}', {
                  time: cycle?.validIso ?? t('Unavailable'),
                }),
              },
              {
                id: 'cycle',
                text: t('Issued: {time}', {
                  time: cycle?.runIso ?? t('Unavailable'),
                }),
              },
              {
                id: 'forecast-hour',
                text: t('NOAA GFS · forecast +{hour} h', {
                  hour: cycle?.forecastHour ?? '—',
                }),
              },
              {
                id: 'measurement-kind',
                text: t('Model analysis/forecast, not a station measurement'),
              },
              {
                id: 'explanation',
                text: t(
                  'Interpolated model forecast on an approximately 1° grid. Broad weather patterns, not a street-level measurement.',
                ),
              },
            ],
            clear: { params: { inspect: false } },
          }
        : null,
    },
  };
}
