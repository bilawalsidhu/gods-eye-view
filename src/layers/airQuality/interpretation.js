/** Portable, per-pollutant interpretation. Never an overall station AQI.
 * EEA revised hourly bands: https://airindex.eea.europa.eu/AQI/
 * Upper bounds are inclusive; decimal values are not rounded into a lower band.
 */
const msg = (text) => text;
export const EEA_HOURLY_LIMITS = Object.freeze({
  'PM2.5': [5, 15, 50, 90, 140],
  PM10: [15, 45, 120, 195, 270],
  NO2: [10, 25, 60, 100, 150],
  O3: [60, 100, 120, 160, 180],
  SO2: [20, 40, 125, 190, 275],
});
export const EEA_HOURLY_BANDS = Object.freeze([
  { label: msg('Good'), color: '#50c9b5' },
  { label: msg('Fair'), color: '#a3cf62' },
  { label: msg('Moderate'), color: '#f2d45c' },
  { label: msg('Poor'), color: '#f29457' },
  { label: msg('Very poor'), color: '#e96070' },
  { label: msg('Extremely poor'), color: '#bb6bbd' },
]);
const usual = msg('Usual outdoor activities are appropriate.');
const symptomatic = msg(
  'If you notice symptoms, ease strenuous outdoor activity.',
);
export const EEA_GENERAL_GUIDANCE = [
  usual,
  usual,
  usual,
  symptomatic,
  symptomatic,
  msg('Reduce strenuous outdoor activity.'),
];
export const EEA_SENSITIVE_GUIDANCE = [
  usual,
  usual,
  symptomatic,
  msg('Consider less physical activity outdoors, especially with symptoms.'),
  msg('Reduce physical activity outdoors, especially with symptoms.'),
  msg('Avoid physical activity outdoors.'),
];

export function massConcentrationFactor(units) {
  const normalized = String(units).replaceAll('μ', 'µ').replaceAll('³', '3');
  if (['µg/m3', 'ug/m3'].includes(normalized)) return 1;
  if (normalized === 'mg/m3') return 1000;
  return null;
}
export function hourlyLegend(parameter) {
  const limits = EEA_HOURLY_LIMITS[parameter];
  if (!limits) return [];
  return EEA_HOURLY_BANDS.map((band, i) => ({
    ...band,
    range:
      i === 5
        ? `>${limits[4]} µg/m³`
        : `${i ? `>${limits[i - 1]}` : '0'}–${limits[i]} µg/m³`,
  }));
}
/** Unknown, flagged, incomplete and incompatible readings never turn green. */
export function interpretHourly(reading) {
  const limits = EEA_HOURLY_LIMITS[reading.parameter];
  let reason = null;
  if (!limits)
    reason =
      reading.parameter === 'CO2'
        ? msg(
            'CO₂ concentration is not an emissions rate and has no category on this scale.',
          )
        : msg('This pollutant has no category on the EEA hourly scale.');
  else if (reading.averagingMinutes !== 60)
    reason = msg('A verified one-hour average is needed to rate this reading.');
  else if (reading.qualityFlagged)
    reason = msg(
      'The source flagged this measurement; no health category is assigned.',
    );
  else if (
    reading.coveragePercent !== undefined &&
    (!Number.isFinite(reading.coveragePercent) || reading.coveragePercent < 100)
  )
    reason = msg(
      'The hourly average is incomplete; no health category is assigned.',
    );
  const factor = massConcentrationFactor(reading.units);
  if (!reason && factor === null)
    reason = msg(
      'These units cannot be compared without additional conversion data.',
    );
  if (!reason && (!Number.isFinite(reading.value) || reading.value < 0))
    reason = msg('No usable measurement.');
  if (reason) return { ...reading, assessment: { reason }, color: '#8cb4ce' };
  const value = reading.value * factor;
  let severity = limits.findIndex((limit) => value <= limit);
  if (severity < 0) severity = 5;
  const band = EEA_HOURLY_BANDS[severity];
  return {
    ...reading,
    color: band.color,
    assessment: {
      ...band,
      severity,
      method: msg('EEA hourly pollutant bands'),
      basis: 'calculated',
      concentration: value,
      units: 'µg/m³',
      range: hourlyLegend(reading.parameter)[severity].range,
      general: EEA_GENERAL_GUIDANCE[severity],
      sensitive: EEA_SENSITIVE_GUIDANCE[severity],
    },
  };
}
