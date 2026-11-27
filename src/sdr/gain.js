/**
 * Local SDR gain settings. RTL-SDR remembers tuner gain per mode. HackRF One
 * shares its LNA, VGA and AMP settings across FM and ADS-B.
 *
 * `'auto'` hands gain to the tuner's AGC. Manual values are the R820T gain
 * steps librtlsdr and dump1090 expose, in dB. Receivers with an onboard LNA
 * (for example a Nooelec FlyCatcher with its LNA on) overload at AGC or high
 * gain, so the ADS-B default is a fixed step. It is 28.0 dB rather than the
 * lower steps dump1090 users pick because the WebUSB library maps dB to tuner
 * gain stages differently from librtlsdr: on a FlyCatcher, 20.7 dB here gave
 * about 1 msg/s and 28.0 dB about 9 msg/s on the same antenna.
 */

const SDR_GAIN_AUTO = 'auto';

/** R820T tuner gain steps in dB, as listed by librtlsdr. */
export const R820T_GAIN_STEPS_DB = Object.freeze([
  0.0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9,
  25.4, 28.0, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5,
  48.0, 49.6,
]);

export const SDR_GAIN_DEFAULTS = Object.freeze({
  fm: SDR_GAIN_AUTO,
  adsb: 28.0,
});

export const SDR_GAIN_STORAGE_KEY = 'gev:sdr:gain:v1';

const HACKRF_GAIN_STORAGE_KEY = 'gev:sdr:hackrf:gain:v1';

export const HACKRF_GAIN_DEFAULTS = Object.freeze({
  lna: 16,
  vga: 16,
  amp: false,
});

export const HACKRF_GAIN_STEPS_DB = Object.freeze({
  lna: Object.freeze([0, 8, 16, 24, 32, 40]),
  vga: Object.freeze(Array.from({ length: 32 }, (_, step) => step * 2)),
});

/** Accept only hardware-supported settings. Select inputs provide strings. */
export function normalizeHackrfGain(stage, value) {
  if (stage === 'amp') return typeof value === 'boolean' ? value : null;
  if (!Object.hasOwn(HACKRF_GAIN_STEPS_DB, stage)) return null;
  const gain =
    typeof value === 'string' && value.trim() ? Number(value) : value;
  return HACKRF_GAIN_STEPS_DB[stage].includes(gain) ? gain : null;
}

function readSettings(storage, key, defaults, normalize) {
  let stored = null;
  try {
    stored = JSON.parse(storage?.getItem?.(key) || 'null');
  } catch {
    /* Ignore unavailable storage or invalid JSON. */
  }
  return Object.fromEntries(
    Object.entries(defaults).map(([name, fallback]) => [
      name,
      normalize(name, stored?.[name]) ?? fallback,
    ]),
  );
}

function writeSettings(storage, key, value) {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
    return Boolean(storage?.setItem);
  } catch {
    return false;
  }
}

export function readHackrfGainSettings(storage) {
  return Object.freeze(
    readSettings(
      storage,
      HACKRF_GAIN_STORAGE_KEY,
      HACKRF_GAIN_DEFAULTS,
      normalizeHackrfGain,
    ),
  );
}

export function writeHackrfGainSettings(storage, settings) {
  writeSettings(storage, HACKRF_GAIN_STORAGE_KEY, settings);
}

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
  return readSettings(
    storage,
    SDR_GAIN_STORAGE_KEY,
    SDR_GAIN_DEFAULTS,
    (_, value) => normalizeSdrGain(value),
  );
}

/**
 * Persist per-mode gain settings. Storage failures are ignored.
 * @param {Storage|null} storage Browser storage or a test double.
 * @param {{fm:'auto'|number, adsb:'auto'|number}} settings Settings to save.
 * @returns {boolean} Whether the write succeeded.
 */
export function writeSdrGainSettings(storage, settings) {
  return writeSettings(storage, SDR_GAIN_STORAGE_KEY, {
    fm: settings.fm,
    adsb: settings.adsb,
  });
}

/**
 * The value handed to the tuner: null selects AGC.
 * @param {'auto'|number} setting Normalized gain setting.
 * @returns {number|null}
 */
export function tunerGainValue(setting) {
  return setting === SDR_GAIN_AUTO ? null : setting;
}
