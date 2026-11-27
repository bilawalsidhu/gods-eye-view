/**
 * Concentration units: the one conversion for every air-quality scale. Pure
 * and portable: no network, scene or UI imports.
 *
 * The layer's units are µg/m³, and mg/m³ for CO. Gases reported as mixing
 * ratios (ppb, ppm) convert at 25 °C and 1 atm, the US EPA's reference
 * conditions: µg/m³ = ppb × molar mass / 24.45.
 */

/** µg/m³ per ppb (CO: mg/m³ per ppm) at 25 °C, by the layer's pollutant id. */
export const EPA_GAS_FACTORS = Object.freeze({
  O3: 1.963,
  NO2: 1.882,
  SO2: 2.62,
  CO: 1.1456,
});

/** The layer's unit for a pollutant. */
export const layerUnits = (parameter) =>
  parameter === 'CO' ? 'mg/m³' : 'µg/m³';

const normalizedUnits = (units) =>
  String(units ?? '')
    .trim()
    .replaceAll('μ', 'µ')
    .replaceAll('³', '3')
    .toLowerCase();

/**
 * The factor from `units` to the layer's unit for `parameter` (µg/m³; CO
 * mg/m³), or null when the value cannot be converted: unknown units, or a
 * mixing ratio of a pollutant without a gas factor (particles).
 */
export function concentrationFactor(parameter, units) {
  const gas = EPA_GAS_FACTORS[parameter];
  // CO's layer unit is mg/m³ and its gas factor is per ppm; the others are
  // µg/m³ and per ppb.
  const milli = parameter === 'CO';
  switch (normalizedUnits(units)) {
    case 'µg/m3':
    case 'ug/m3':
      return milli ? 1e-3 : 1;
    case 'mg/m3':
      return milli ? 1 : 1000;
    case 'ppb':
      if (!gas) return null;
      return milli ? gas / 1000 : gas;
    case 'ppm':
      if (!gas) return null;
      return milli ? gas : gas * 1000;
    default:
      return null;
  }
}

/** A value in the layer's unit for `parameter`, or null if unconvertible. */
export function concentrationIn(parameter, value, units) {
  if (!Number.isFinite(value) || value < 0) return null;
  const factor = concentrationFactor(parameter, units);
  return factor === null ? null : value * factor;
}
