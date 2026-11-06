import { t } from '../../i18n/index.js';

export function intervalLabel(value) {
  if (!value) return t('No ocean data at this point');
  if (value.kind === 'below')
    return t('At or below {value} °C', { value: value.high });
  if (value.kind === 'above')
    return t('At or above {value} °C', { value: value.low });
  return `[${value.low}, ${value.high}) °C`;
}

export function oceanControls({
  mode,
  date,
  dates,
  palette,
  loading,
  error,
  reading,
  armed,
  showNino34,
}) {
  const index = dates.indexOf(date);
  const modeChips = ['anomaly', 'sst'].map((value) => ({
    id: value,
    label:
      value === 'sst' ? t('Sea surface temperature') : t('Temperature anomaly'),
    active: mode === value,
    params: { mode: value },
  }));
  const regionChip = {
    id: 'nino34',
    label: t('Niño 3.4 region'),
    active: showNino34,
    params: { showNino34: !showNino34 },
  };
  const actions = [
    {
      id: 'previous',
      label: t('Previous observation'),
      params: { step: -1 },
      disabled: loading || index <= 0,
    },
    {
      id: 'next',
      label: t('Next observation'),
      params: { step: 1 },
      disabled: loading || index < 0 || index >= dates.length - 1,
    },
    {
      id: 'latest',
      label: t('Latest'),
      params: { latest: true },
      disabled: loading || date === dates.at(-1),
    },
    {
      id: 'pick',
      label: armed ? t('Cancel') : t('Read ocean temperature at a point'),
      active: armed,
      params: { pick: !armed },
      disabled: loading || !date || !palette.length,
    },
  ];
  const entries = palette.filter((entry) => !entry.nodata);
  const legend = entries
    .filter(
      (_, index) =>
        index === 0 ||
        index === entries.length - 1 ||
        index % Math.max(1, Math.floor(entries.length / 8)) === 0,
    )
    .map((entry) => ({
      color: `#${entry.rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`,
      // Bare numbers: the legend appends its own unit. Open ends keep ≤/≥.
      label:
        entry.low === -Infinity
          ? `≤${entry.high}`
          : entry.high === Infinity
            ? `≥${entry.low}`
            : String(entry.low),
    }));
  return {
    readout: true,
    chips: [...modeChips, regionChip, ...actions],
    legend,
    summary: {
      label: t('Ocean Temperature'),
      coverage: t('Global · 0.25° analysis'),
      units: '°C',
      detail: date ? `${t('Daily analysis')} · ${date} UTC` : t('Unavailable'),
      status: loading
        ? t('Loading ocean temperature')
        : error
          ? t(error)
          : armed
            ? t('Click Earth to read temperature · Esc to cancel')
            : null,
      settings: [
        { id: 'mode', label: t('PRODUCT'), chips: modeChips },
        { id: 'context', label: t('CONTEXT'), chips: [regionChip] },
      ],
      actions,
      lines: [
        { id: 'source', text: 'JPL MUR25 · NASA GIBS' },
        {
          id: 'baseline',
          text:
            mode === 'anomaly'
              ? t('Anomaly relative to 2003–2014 climatology')
              : t('Daily satellite and in-situ blended analysis'),
        },
        {
          id: 'quantization',
          text: t('Published color intervals, not exact point measurements'),
        },
      ],
      result: reading
        ? {
            id: 'reading',
            label: t('Ocean Temperature'),
            lines: [
              { id: 'value', text: intervalLabel(reading.value) },
              {
                id: 'coordinates',
                text: `${reading.lon.toFixed(2)}°, ${reading.lat.toFixed(2)}° · ${date} UTC`,
              },
            ],
            clear: { params: { inspect: false } },
          }
        : null,
    },
  };
}
