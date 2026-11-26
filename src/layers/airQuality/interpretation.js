/** Portable, per-pollutant interpretation. Never an overall station AQI.
 * EEA revised hourly bands: https://airindex.eea.europa.eu/AQI/
 * Upper bounds are inclusive; decimal values are not rounded into a lower band.
 */
import { AIR_QUALITY_UNRATED_COLOR } from './model.js';
import { concentrationFactor, layerUnits } from './units.js';
import { AQI_CEILINGS, AQI_POLLUTANTS } from './usAqi.js';
const msg = (text) => text;
export const EEA_HOURLY_LIMITS = Object.freeze({
  'PM2.5': [5, 15, 50, 90, 140],
  PM10: [15, 45, 120, 195, 270],
  NO2: [10, 25, 60, 100, 150],
  O3: [60, 100, 120, 160, 180],
  SO2: [20, 40, 125, 190, 275],
  // CO is not in the EEA index. Its steps, in mg/m³, are the WHO 24-hour
  // guideline and interim target, then the 8-hour, 1-hour and 15-minute
  // guidelines, on the same six bands.
  CO: [4, 7, 10, 35, 100],
});
export const EEA_HOURLY_BANDS = Object.freeze([
  { label: msg('Good'), color: '#50c9b5' },
  { label: msg('Fair'), color: '#a3cf62' },
  { label: msg('Moderate'), color: '#f2d45c' },
  { label: msg('Poor'), color: '#f29457' },
  { label: msg('Very poor'), color: '#e96070' },
  {
    label: msg('Extremely poor'),
    // The tile card shows this short form; the legend the label.
    // i18n-ignore: EEA category; translated in layer presentation
    short: 'Extreme',
    color: '#bb6bbd',
  },
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

export function hourlyLegend(parameter) {
  const limits = EEA_HOURLY_LIMITS[parameter];
  if (!limits) return [];
  const units = layerUnits(parameter);
  return EEA_HOURLY_BANDS.map((band, i) => ({
    ...band,
    range:
      i === 5
        ? `>${limits[4]} ${units}`
        : `${i ? `>${limits[i - 1]}` : '0'}–${limits[i]} ${units}`,
  }));
}
/**
 * The EEA hourly band of a concentration in µg/m³ (its position 0 to 5), or
 * -1 for a pollutant the scale has no bands for.
 */
export function hourlyBandIndex(parameter, value) {
  const limits = EEA_HOURLY_LIMITS[parameter];
  if (!limits || !Number.isFinite(value)) return -1;
  const severity = limits.findIndex((limit) => value <= limit);
  return severity < 0 ? 5 : severity;
}

/** One fault ceiling per pollutant in every view. */
export function hourlyCeiling(parameter) {
  const ceiling = AQI_CEILINGS[AQI_POLLUTANTS[parameter]];
  return Number.isFinite(ceiling) ? ceiling : Infinity;
}

/** Minimum hourly data coverage (45 minutes). */
export const HOURLY_MIN_COVERAGE = 75;

/** Unknown, flagged, incomplete and incompatible readings never turn green. */
export function interpretHourly(reading) {
  const limits = EEA_HOURLY_LIMITS[reading.parameter];
  let reason = null;
  if (!limits)
    reason = msg('This pollutant has no category on the EEA hourly scale.');
  else if (reading.averagingMinutes !== 60)
    reason = msg('A verified one-hour average is needed to rate this reading.');
  else if (reading.qualityFlagged)
    reason = msg(
      'The source flagged this measurement; no health category is assigned.',
    );
  else if (
    reading.coveragePercent !== undefined &&
    (!Number.isFinite(reading.coveragePercent) ||
      reading.coveragePercent < HOURLY_MIN_COVERAGE)
  )
    reason = msg(
      'The hourly average is incomplete; no health category is assigned.',
    );
  // Mixing ratios of gases convert at 25 °C (units.js), as for the US AQI.
  const factor = concentrationFactor(reading.parameter, reading.units);
  if (!reason && factor === null)
    reason = msg(
      'These units cannot be compared without additional conversion data.',
    );
  if (!reason && (!Number.isFinite(reading.value) || reading.value < 0))
    reason = msg('No usable measurement.');
  const value = reason ? null : reading.value * factor;
  // Above the plausibility ceiling the AQI view uses, a value is taken to be
  // an instrument fault: unrated here too (`hourlyCeiling`).
  if (!reason && value > hourlyCeiling(reading.parameter))
    reason = msg(
      'Implausibly high for this pollutant; no health category is assigned.',
    );
  if (reason)
    return {
      ...reading,
      assessment: { reason },
      color: AIR_QUALITY_UNRATED_COLOR,
    };
  const severity = hourlyBandIndex(reading.parameter, value);
  const band = EEA_HOURLY_BANDS[severity];
  return {
    ...reading,
    color: band.color,
    assessment: {
      ...band,
      severity,
      // CO's bands are the WHO's guideline values, not the EEA's.
      method:
        reading.parameter === 'CO'
          ? msg('WHO-based carbon monoxide bands')
          : msg('EEA hourly pollutant bands'),
      basis: 'calculated',
      concentration: value,
      units: layerUnits(reading.parameter),
      range: hourlyLegend(reading.parameter)[severity].range,
      general: EEA_GENERAL_GUIDANCE[severity],
      sensitive: EEA_SENSITIVE_GUIDANCE[severity],
    },
  };
}
