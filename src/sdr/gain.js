/**
 * Tuner gain settings for the local RTL-SDR, remembered per receiver mode.
 *
 * `'auto'` hands gain to the tuner's AGC. Manual values are the R820T gain
 * steps librtlsdr and dump1090 expose, in dB. Receivers with an onboard LNA
 * (for example a Nooelec FlyCatcher with its LNA on) overload at AGC or high
 * gain, so the ADS-B default is a fixed mid step.
 */

export const SDR_GAIN_AUTO = 'auto';

/** R820T tuner gain steps in dB, as listed by librtlsdr. */
export const R820T_GAIN_STEPS_DB = Object.freeze([
  0.0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9,
  25.4, 28.0, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5,
  48.0, 49.6,
]);

export const SDR_GAIN_DEFAULTS = Object.freeze({
  fm: SDR_GAIN_AUTO,
  adsb: 20.7,
});

export const SDR_GAIN_STORAGE_KEY = 'gev:sdr:gain:v1';

/**
 * Normalize a requested gain to `'auto'` or the nearest listed R820T step.
 * @param {*} value `'auto'`, a dB number or a numeric string.
 * @returns {'auto'|number|null} Normalized setting, or null when invalid.
 */
export function normalizeSdrGain(value) {
  if (value === null || value === undefined || value === '') return null;
  if (String(value).trim().toLowerCase() === SDR_GAIN_AUTO)
    return SDR_GAIN_AUTO;
  const requested = Number(value);
  if (!Number.isFinite(requested)) return null;
  let nearest = R820T_GAIN_STEPS_DB[0];
  for (const step of R820T_GAIN_STEPS_DB) {
    if (Math.abs(step - requested) < Math.abs(nearest - requested))
      nearest = step;
  }
  return nearest;
}

/**
 * Read per-mode gain settings, falling back to the defaults.
 * @param {Storage|null} storage Browser storage or a test double.
 * @returns {{fm:'auto'|number, adsb:'auto'|number}}
 */
export function readSdrGainSettings(storage) {
  let stored = null;
  try {
    stored = JSON.parse(storage?.getItem?.(SDR_GAIN_STORAGE_KEY) || 'null');
  } catch {
    stored = null;
  }
  return Object.fromEntries(
    Object.entries(SDR_GAIN_DEFAULTS).map(([mode, fallback]) => [
      mode,
      normalizeSdrGain(stored?.[mode]) ?? fallback,
    ]),
  );
}

/**
 * Persist per-mode gain settings. Storage failures are ignored.
 * @param {Storage|null} storage Browser storage or a test double.
 * @param {{fm:'auto'|number, adsb:'auto'|number}} settings Settings to save.
 * @returns {boolean} Whether the write succeeded.
 */
export function writeSdrGainSettings(storage, settings) {
  try {
    storage?.setItem?.(
      SDR_GAIN_STORAGE_KEY,
      JSON.stringify({ fm: settings.fm, adsb: settings.adsb }),
    );
    return Boolean(storage?.setItem);
  } catch {
    return false;
  }
}

/**
 * The value handed to the tuner: null selects AGC.
 * @param {'auto'|number} setting Normalized gain setting.
 * @returns {number|null}
 */
export function tunerGainValue(setting) {
  return setting === SDR_GAIN_AUTO ? null : setting;
}
