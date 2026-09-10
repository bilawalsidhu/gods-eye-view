/**
 * Web receiver tuning helpers — pure and isomorphic.
 *
 * Shared by the server-side directory proxy (band parsing), the Web Receivers
 * layer (filtering, ranking, tune URLs) and the voice tools. Nothing here
 * touches the DOM, Cesium or Node APIs.
 *
 * Three receiver families are understood, each with its own way of being
 * tuned from a URL:
 *   KiwiSDR    http://host:8073/?f=14233usbz10          (kHz + mode + zoom)
 *   WebSDR     http://host:8901/?tune=14233usb          (kHz + mode)
 *   OpenWebRX  http://host:8073/#freq=14233000,mod=usb  (Hz + mode)
 *
 * Spectrum-only views (no audio) are a KiwiSDR feature: its page also takes
 * `z=` (zoom level, span halves per step), `sp=1` (spectrum panel) and
 * `mute=1`. WebSDR and OpenWebRX pages accept neither zoom nor mute in the URL,
 * so a spectrum view on them is a normal tune with a warning that audio plays.
 */

export const RECEIVER_TYPES = Object.freeze(['kiwisdr', 'websdr', 'openwebrx']);

export const RECEIVER_TYPE_LABELS = Object.freeze({
  kiwisdr: 'KiwiSDR',
  websdr: 'WebSDR',
  openwebrx: 'OpenWebRX',
});

/** Canonical demodulation modes used inside GEV. */
export const RECEIVER_MODES = Object.freeze(['usb', 'lsb', 'am', 'cw', 'nfm', 'wfm']);

const MODE_ALIASES = new Map([
  ['usb', 'usb'], ['upper sideband', 'usb'], ['ssb', 'usb'],
  ['lsb', 'lsb'], ['lower sideband', 'lsb'],
  ['am', 'am'], ['sam', 'am'], ['amn', 'am'], ['synchronous am', 'am'],
  ['cw', 'cw'], ['cwn', 'cw'], ['morse', 'cw'],
  ['fm', 'nfm'], ['nfm', 'nfm'], ['nbfm', 'nfm'], ['narrow fm', 'nfm'], ['narrowband fm', 'nfm'],
  ['wfm', 'wfm'], ['wbfm', 'wfm'], ['wide fm', 'wfm'], ['wideband fm', 'wfm'], ['broadcast fm', 'wfm'],
]);

/** Per-family mode vocabularies. Missing entries fall back to the nearest supported mode. */
const MODE_BY_TYPE = Object.freeze({
  kiwisdr: Object.freeze({ usb: 'usb', lsb: 'lsb', am: 'am', cw: 'cw', nfm: 'nbfm', wfm: 'nbfm' }),
  websdr: Object.freeze({ usb: 'usb', lsb: 'lsb', am: 'am', cw: 'cw', nfm: 'fm', wfm: 'fm' }),
  openwebrx: Object.freeze({ usb: 'usb', lsb: 'lsb', am: 'am', cw: 'cw', nfm: 'nfm', wfm: 'wfm' }),
});

const HZ = 1;
const KHZ = 1_000;
const MHZ = 1_000_000;

/** Amateur allocations used for the "what mode would a human pick" default. */
const HAM_SSB_BANDS_HZ = Object.freeze([
  [1_800_000, 2_000_000], [3_500_000, 4_000_000], [5_250_000, 5_450_000], [7_000_000, 7_300_000],
  [10_100_000, 10_150_000], [14_000_000, 14_350_000], [18_068_000, 18_168_000], [21_000_000, 21_450_000],
  [24_890_000, 24_990_000], [28_000_000, 29_700_000], [50_000_000, 54_000_000],
]);

/** Named bands a receiver label may mention, in Hz. */
export const BAND_TABLE = Object.freeze([
  { keys: ['160m'], lowHz: 1_800_000, highHz: 2_000_000, label: '160 m' },
  { keys: ['80m'], lowHz: 3_500_000, highHz: 4_000_000, label: '80 m' },
  { keys: ['60m'], lowHz: 5_250_000, highHz: 5_450_000, label: '60 m' },
  { keys: ['40m'], lowHz: 7_000_000, highHz: 7_300_000, label: '40 m' },
  { keys: ['30m'], lowHz: 10_100_000, highHz: 10_150_000, label: '30 m' },
  { keys: ['20m'], lowHz: 14_000_000, highHz: 14_350_000, label: '20 m' },
  { keys: ['17m'], lowHz: 18_068_000, highHz: 18_168_000, label: '17 m' },
  { keys: ['15m'], lowHz: 21_000_000, highHz: 21_450_000, label: '15 m' },
  { keys: ['12m'], lowHz: 24_890_000, highHz: 24_990_000, label: '12 m' },
  { keys: ['11m', 'cb'], lowHz: 26_900_000, highHz: 27_500_000, label: '11 m / CB' },
  { keys: ['10m'], lowHz: 28_000_000, highHz: 29_700_000, label: '10 m' },
  { keys: ['6m'], lowHz: 50_000_000, highHz: 54_000_000, label: '6 m' },
  { keys: ['4m'], lowHz: 70_000_000, highHz: 70_500_000, label: '4 m' },
  { keys: ['2m'], lowHz: 144_000_000, highHz: 148_000_000, label: '2 m' },
  { keys: ['70cm'], lowHz: 430_000_000, highHz: 440_000_000, label: '70 cm' },
  { keys: ['23cm'], lowHz: 1_240_000_000, highHz: 1_300_000_000, label: '23 cm' },
  { keys: ['lw', 'longwave', 'long wave'], lowHz: 30_000, highHz: 300_000, label: 'LW' },
  { keys: ['mw', 'medium wave', 'mediumwave', 'am broadcast'], lowHz: 520_000, highHz: 1_710_000, label: 'MW' },
  { keys: ['hf', 'shortwave', 'short wave', 'sw', 'kw', 'kurzwelle'], lowHz: 1_600_000, highHz: 30_000_000, label: 'HF' },
  { keys: ['vhf'], lowHz: 30_000_000, highHz: 300_000_000, label: 'VHF' },
  { keys: ['uhf'], lowHz: 300_000_000, highHz: 3_000_000_000, label: 'UHF' },
  { keys: ['fm broadcast', 'fm radio', 'ukw', 'broadcast fm', 'fm band'], lowHz: 87_500_000, highHz: 108_000_000, label: 'FM broadcast' },
  { keys: ['airband', 'air band', 'aviation', 'aircraft'], lowHz: 118_000_000, highHz: 137_000_000, label: 'Airband' },
  { keys: ['marine', 'ais'], lowHz: 156_000_000, highHz: 162_500_000, label: 'Marine VHF' },
  { keys: ['pmr', 'pmr446'], lowHz: 446_000_000, highHz: 446_200_000, label: 'PMR446' },
  { keys: ['dab', 'dab+'], lowHz: 174_000_000, highHz: 240_000_000, label: 'DAB' },
  { keys: ['ads-b', 'adsb'], lowHz: 1_090_000_000, highHz: 1_090_000_000, label: 'ADS-B' },
]);

/** Panel/voice band filters. */
export const BAND_FILTERS = Object.freeze([
  { id: 'all', label: 'All bands', lowHz: 0, highHz: Number.POSITIVE_INFINITY },
  { id: 'lf-mw', label: 'LW / MW', lowHz: 30_000, highHz: 1_710_000 },
  { id: 'hf', label: 'Shortwave (HF)', lowHz: 1_600_000, highHz: 30_000_000 },
  { id: 'vhf', label: 'VHF', lowHz: 30_000_000, highHz: 300_000_000 },
  { id: 'uhf', label: 'UHF+', lowHz: 300_000_000, highHz: Number.POSITIVE_INFINITY },
]);

const BAND_FILTER_BY_ID = new Map(BAND_FILTERS.map((entry) => [entry.id, entry]));

const NUMBER_RE = /^-?\d+(?:[.,]\d+)?$/;

function cleanText(value, maxLength = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
}

function finiteOrNull(value) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

/** Map any spoken/typed mode onto the canonical set; null when unrecognized. */
export function normalizeReceiverMode(value) {
  const raw = cleanText(value, 40).toLowerCase();
  if (!raw) return null;
  return MODE_ALIASES.get(raw) || (RECEIVER_MODES.includes(raw) ? raw : null);
}

/** Mode a listener would pick with no other information. */
export function defaultModeForHz(hz) {
  const value = finiteOrNull(hz);
  if (value === null) return 'usb';
  if (value >= 87_500_000 && value <= 108_000_000) return 'wfm';
  if (value > 30_000_000) return 'nfm';
  if (HAM_SSB_BANDS_HZ.some(([low, high]) => value >= low && value <= high)) {
    return value < 10_000_000 ? 'lsb' : 'usb';
  }
  return 'am';
}

/**
 * Parse a frequency into Hz. Accepts numbers and strings with an optional
 * unit ("14233", "14233 kHz", "14.233 MHz", "145.500", "7,055 kHz").
 * `unitHint` ('hz' | 'khz' | 'mhz') applies to bare numbers. Without a hint a
 * bare number is read the way radio people say it: a decimal below 1000 is MHz,
 * anything else below one million is kHz, one million and up is Hz.
 */
export function parseFrequencyHz(value, unitHint = '') {
  if (value === null || value === undefined || value === '') return null;
  let text = cleanText(value, 40).toLowerCase().replace(/\s+/g, '');
  let unit = cleanText(unitHint, 8).toLowerCase();
  const unitMatch = text.match(/(ghz|mhz|khz|hz)$/);
  if (unitMatch) {
    unit = unitMatch[1];
    text = text.slice(0, -unit.length);
  }
  text = text.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  if (!NUMBER_RE.test(text)) return null;
  const number = Number(text.replace(',', '.'));
  if (!Number.isFinite(number) || number <= 0) return null;
  let hz;
  if (unit === 'ghz') hz = number * 1_000 * MHZ;
  else if (unit === 'mhz') hz = number * MHZ;
  else if (unit === 'khz') hz = number * KHZ;
  else if (unit === 'hz') hz = number * HZ;
  else if (number < 1_000 && /[.,]/.test(text)) hz = number * MHZ;
  else if (number < 1_000_000) hz = number * KHZ;
  else hz = number;
  hz = Math.round(hz);
  return hz >= 1_000 && hz <= 10_000 * MHZ ? hz : null;
}

/** Human frequency readout: kHz below 30 MHz, MHz above. */
export function formatFrequencyHz(hz) {
  const value = finiteOrNull(hz);
  if (value === null) return '';
  if (value < 30 * MHZ) {
    const kHz = value / KHZ;
    return `${kHz.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kHz`;
  }
  return `${(value / MHZ).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 4 })} MHz`;
}

function rangeLabel(lowHz, highHz) {
  const low = formatFrequencyHz(Math.max(lowHz, 1_000));
  const high = formatFrequencyHz(highHz);
  const lowUnit = low.split(' ').pop();
  const highUnit = high.split(' ').pop();
  return lowUnit === highUnit ? `${low.replace(/ \S+$/, '')}–${high}` : `${low}–${high}`;
}

/**
 * Extract frequency coverage from free text such as a receiver label:
 * explicit ranges ("0-30 MHz", "1.8–30MHz", "144-146 MHz") and named bands
 * ("20m", "2m/70cm", "HF", "airband"). Returns deduplicated Hz ranges.
 */
export function parseBandsFromText(text) {
  const source = cleanText(text, 400).toLowerCase();
  if (!source) return [];
  const bands = [];
  const seen = new Set();
  const push = (band) => {
    if (!band) return;
    const key = `${band.lowHz}-${band.highHz}`;
    if (seen.has(key)) return;
    seen.add(key);
    bands.push(Object.freeze(band));
  };
  const scaleOf = (unit) => (unit === 'ghz' ? 1_000 * MHZ : unit === 'khz' ? KHZ : unit === 'hz' ? HZ : MHZ);
  const rangeRe = /(\d+(?:[.,]\d+)?)\s*(ghz|mhz|khz|hz)?\s*(?:-|–|—|to|bis|\.\.)\s*(\d+(?:[.,]\d+)?)\s*(ghz|mhz|khz|hz)\b/g;
  let match;
  while ((match = rangeRe.exec(source))) {
    const low = Number(match[1].replace(',', '.'));
    const high = Number(match[3].replace(',', '.'));
    const lowHz = Math.round(low * scaleOf(match[2] || match[4]));
    const highHz = Math.round(high * scaleOf(match[4]));
    if (lowHz >= 0 && highHz > lowHz && highHz <= 10_000 * MHZ) {
      push({ lowHz, highHz, label: rangeLabel(lowHz, highHz) });
    }
  }
  const padded = ` ${source.replace(/[()[\]{}|,;:/\\]+/g, ' ')} `;
  for (const entry of BAND_TABLE) {
    for (const key of entry.keys) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(padded)) {
        push({ lowHz: entry.lowHz, highHz: entry.highHz, label: entry.label });
        break;
      }
    }
  }
  return bands;
}

/** True when any band contains the frequency. */
export function bandsCoverHz(bands, hz) {
  const value = finiteOrNull(hz);
  if (value === null || !Array.isArray(bands)) return false;
  return bands.some((band) => value >= band.lowHz && value <= band.highHz);
}

/** Coverage summary flags derived from the band list. */
export function coverageFlags(bands) {
  // Strict overlap: a receiver ending exactly at 30 MHz is HF, not VHF.
  const overlaps = (lowHz, highHz) => Array.isArray(bands)
    && bands.some((band) => band.lowHz < highHz && band.highHz > lowHz);
  return {
    lfmw: overlaps(30_000, 1_710_000),
    hf: overlaps(1_600_000, 30_000_000),
    vhf: overlaps(30_000_000, 300_000_000),
    uhf: overlaps(300_000_000, Number.POSITIVE_INFINITY),
  };
}

/** Whether a receiver's published coverage includes the frequency (null = coverage unknown). */
export function receiverCoversHz(receiver, hz) {
  if (!receiver?.bands?.length) return null;
  return bandsCoverHz(receiver.bands, hz);
}

/** "0–30 MHz · 2 m · 70 cm" for cards and narration. */
export function describeReceiverBands(receiver) {
  const bands = Array.isArray(receiver?.bands) ? receiver.bands : [];
  if (!bands.length) return 'coverage not published';
  return bands.slice(0, 6).map((band) => band.label || rangeLabel(band.lowHz, band.highHz)).join(' · ');
}

/** Build the receiver-specific tune URL, or null when the receiver cannot be tuned by URL. */
export function buildTuneUrl(receiver, { hz, mode = null } = {}) {
  const value = finiteOrNull(hz);
  if (!receiver?.url || !RECEIVER_TYPES.includes(receiver.type) || value === null || value <= 0) return null;
  let base;
  try {
    base = new URL(receiver.url);
  } catch {
    return null;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
  base.hash = '';
  base.search = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const canonical = normalizeReceiverMode(mode) || defaultModeForHz(value);
  const native = MODE_BY_TYPE[receiver.type][canonical];
  const kHz = Math.round(value) / KHZ;
  const kHzText = Number.isInteger(kHz) ? String(kHz) : kHz.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (receiver.type === 'kiwisdr') {
    const zoom = canonical === 'am' || canonical === 'wfm' ? 8 : 10;
    return `${base.href}?f=${kHzText}${native}z${zoom}`;
  }
  if (receiver.type === 'websdr') {
    return `${base.href}?tune=${kHzText}${native}`;
  }
  return `${base.href}#freq=${Math.round(value)},mod=${native}`;
}

/** Whether one published band contains the whole range (null = coverage unknown). */
export function receiverCoversRangeHz(receiver, lowHz, highHz) {
  if (!receiver?.bands?.length) return null;
  const low = finiteOrNull(lowHz);
  const high = finiteOrNull(highHz);
  if (low === null || high === null || high <= low) return false;
  return receiver.bands.some((band) => band.lowHz <= low && band.highHz >= high);
}

/** "10–15 MHz" / "7,000–7,200 kHz" for labels and narration. */
export function formatFrequencyRange(lowHz, highHz) {
  const low = formatFrequencyHz(lowHz);
  const high = formatFrequencyHz(highHz);
  const lowUnit = low.split(' ').pop();
  const highUnit = high.split(' ').pop();
  return lowUnit === highUnit ? `${low.replace(/ \S+$/, '')}–${high}` : `${low}–${high}`;
}

const KIWI_MAX_ZOOM = 14;

/**
 * Build a spectrum-only view of a frequency range.
 * KiwiSDR: waterfall zoomed so the range fits, spectrum panel on, audio muted.
 * WebSDR / OpenWebRX: their pages cannot be zoomed or muted from a URL, so the
 * receiver is tuned to the range centre and `muted` is false — callers must
 * say so. Returns null when the receiver cannot be driven at all.
 */
export function buildSpectrumUrl(receiver, { lowHz, highHz } = {}) {
  const low = finiteOrNull(lowHz);
  const high = finiteOrNull(highHz);
  if (!receiver?.url || !RECEIVER_TYPES.includes(receiver.type) || low === null || high === null || high <= low || low < 0) return null;
  let base;
  try {
    base = new URL(receiver.url);
  } catch {
    return null;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
  base.hash = '';
  base.search = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const centerHz = Math.round((low + high) / 2);
  const spanHz = high - low;
  const rangeLabel = formatFrequencyRange(low, high);
  if (receiver.type === 'kiwisdr') {
    const kiwiBand = (receiver.bands || []).find((band) => band.lowHz <= low && band.highHz >= high) || receiver.bands?.[0];
    const fullSpanHz = Math.max(30 * MHZ, kiwiBand ? kiwiBand.highHz - kiwiBand.lowHz : 0);
    const zoom = Math.max(0, Math.min(KIWI_MAX_ZOOM, Math.floor(Math.log2(fullSpanHz / spanHz))));
    const shownSpanHz = fullSpanHz / 2 ** zoom;
    const centerKhz = centerHz / KHZ;
    const centerText = Number.isInteger(centerKhz) ? String(centerKhz) : centerKhz.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return {
      url: `${base.href}?f=${centerText}amz${zoom}&sp=1&mute=1`,
      muted: true,
      zoom,
      centerHz,
      shownSpanHz,
      rangeLabel,
      note: `waterfall spans about ${formatFrequencyRange(Math.max(0, centerHz - shownSpanHz / 2), centerHz + shownSpanHz / 2)}, audio muted`,
    };
  }
  const centerKhz = centerHz / KHZ;
  const centerText = Number.isInteger(centerKhz) ? String(centerKhz) : centerKhz.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (receiver.type === 'websdr') {
    return {
      url: `${base.href}?tune=${centerText}am`,
      muted: false,
      zoom: null,
      centerHz,
      shownSpanHz: null,
      rangeLabel,
      note: 'WebSDR pages cannot be zoomed or muted from a URL: tuned to the range centre, use the page\'s mute box and zoom buttons',
    };
  }
  return {
    url: `${base.href}#freq=${centerHz},mod=am`,
    muted: false,
    zoom: null,
    centerHz,
    shownSpanHz: null,
    rangeLabel,
    note: 'OpenWebRX shows its current profile around the range centre; it cannot be zoomed or muted from a URL',
  };
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Panel filter: receiver family and band. */
export function receiverMatchesFilter(receiver, { type = 'all', band = 'all' } = {}) {
  if (!receiver) return false;
  if (type && type !== 'all' && receiver.type !== type) return false;
  const bandFilter = BAND_FILTER_BY_ID.get(band || 'all') || BAND_FILTER_BY_ID.get('all');
  if (bandFilter.id === 'all') return true;
  const bands = Array.isArray(receiver.bands) ? receiver.bands : [];
  if (!bands.length) return false;
  return bands.some((entry) => entry.lowHz < bandFilter.highHz && entry.highHz > bandFilter.lowHz);
}

/**
 * Rank receivers for a request: online first, then receivers that publish
 * coverage of the requested frequency, then free user slots, then distance.
 */
export function rankWebReceivers(receivers, {
  lat = null, lon = null, hz = null, rangeHz = null, type = 'all', band = 'all', requireCoverage = false, preferTypes = [], limit = 8,
} = {}) {
  const origin = finiteOrNull(lat) !== null && finiteOrNull(lon) !== null;
  const frequency = finiteOrNull(hz);
  const range = Array.isArray(rangeHz) && finiteOrNull(rangeHz[0]) !== null && finiteOrNull(rangeHz[1]) !== null
    ? [Number(rangeHz[0]), Number(rangeHz[1])]
    : null;
  const preference = Array.isArray(preferTypes) ? preferTypes : [];
  const rows = [];
  for (const receiver of Array.isArray(receivers) ? receivers : []) {
    if (!receiverMatchesFilter(receiver, { type, band })) continue;
    const covers = range
      ? receiverCoversRangeHz(receiver, range[0], range[1])
      : (frequency === null ? null : receiverCoversHz(receiver, frequency));
    if (requireCoverage && (frequency !== null || range) && covers === false) continue;
    const distanceKm = origin ? haversineKm(lat, lon, receiver.lat, receiver.lon) : null;
    const full = receiver.users !== null && receiver.usersMax !== null
      && receiver.users !== undefined && receiver.usersMax !== undefined
      && receiver.users >= receiver.usersMax;
    rows.push({ receiver, distanceKm, covers, full, online: receiver.online !== false });
  }
  rows.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const coverA = a.covers === true ? 0 : a.covers === null ? 1 : 2;
    const coverB = b.covers === true ? 0 : b.covers === null ? 1 : 2;
    if (coverA !== coverB) return coverA - coverB;
    if (preference.length) {
      const prefA = preference.indexOf(a.receiver.type);
      const prefB = preference.indexOf(b.receiver.type);
      const rankA = prefA < 0 ? preference.length : prefA;
      const rankB = prefB < 0 ? preference.length : prefB;
      if (rankA !== rankB) return rankA - rankB;
    }
    if (a.full !== b.full) return a.full ? 1 : -1;
    if (a.distanceKm !== null && b.distanceKm !== null && a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    return String(a.receiver.name).localeCompare(String(b.receiver.name));
  });
  return rows.slice(0, Math.max(1, Math.min(50, Number(limit) || 8)));
}
