import { msg } from '../../i18n/marker.js';

/**
 * KiwiSDR websocket protocol: message building and frame parsing.
 *
 * A receiver exposes two websockets, `/kiwi/<ts>/SND` (audio) and
 * `/kiwi/<ts>/W/F` (waterfall). Commands are text frames starting `SET `.
 * Server frames are binary: a 3-byte tag ("MSG", "SND", "W/F"), one separator
 * byte, then a tag-specific body. Pure functions only, so none of this needs a
 * live receiver to test.
 */

export const AUDIO_RATE = 12_000;
export const WATERFALL_BINS = 1024;
export const FULL_BANDWIDTH_KHZ = 30_000;
export const MAX_ZOOM = 14;

const TEXT = new TextDecoder();

/** Passband edges in Hz, relative to the carrier. */
export const MODES = Object.freeze({
  // i18n-ignore: radio mode code
  am: { label: 'AM', low: -4500, high: 4500 },
  // i18n-ignore: radio mode code
  amn: { label: 'AMn', low: -2500, high: 2500 },
  // i18n-ignore: radio mode code
  sam: { label: 'SAM', low: -4500, high: 4500 },
  // i18n-ignore: radio mode code
  usb: { label: 'USB', low: 300, high: 2700 },
  // i18n-ignore: radio mode code
  lsb: { label: 'LSB', low: -2700, high: -300 },
  // i18n-ignore: radio mode code
  cw: { label: 'CW', low: 300, high: 700 },
  // i18n-ignore: radio mode code
  nbfm: { label: 'FM', low: -6000, high: 6000 },
});
export const MODE_IDS = Object.freeze(Object.keys(MODES));

/** Sensible default mode for a frequency: LSB below 10 MHz, USB above, AM for broadcast. */
export function defaultModeFor(freqKhz) {
  if (freqKhz < 1800) return 'am';
  const broadcast = [
    [2300, 2495],
    [3200, 3400],
    [3900, 4000],
    [4750, 5060],
    [5900, 6200],
    [7200, 7450],
    [9400, 9900],
    [11600, 12100],
    [13570, 13870],
    [15100, 15800],
    [17480, 17900],
    [18900, 19020],
    [21450, 21850],
    [25600, 26100],
  ];
  if (broadcast.some(([lo, hi]) => freqKhz >= lo && freqKhz <= hi)) return 'am';
  return freqKhz < 10_000 ? 'lsb' : 'usb';
}

export function clampFrequencyKhz(freqKhz, lowHz = 0, highHz = 30_000_000) {
  const lo = lowHz / 1000;
  const hi = highHz / 1000;
  const n = Number(freqKhz);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

const fixed = (n) => Number(n).toFixed(3);

/** `SET` commands. Each returns the exact text frame to send. */
export const commands = Object.freeze({
  // '#' stands for "no password": the server's parser needs a non-empty token.
  auth: (password = '') => `SET auth t=kiwi p=${password || '#'}`,
  audioRate: (inRate, outRate) =>
    `SET AR OK in=${Math.round(inRate)} out=${Math.round(outRate)}`,
  tune: ({ mode, freqKhz }) => {
    const m = MODES[mode] || MODES.am;
    return `SET mod=${MODES[mode] ? mode : 'am'} low_cut=${m.low} high_cut=${m.high} freq=${fixed(freqKhz)}`;
  },
  agc: () => 'SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50',
  squelchOff: () => 'SET squelch=0 max=0',
  noCompression: () => 'SET compression=0',
  ident: (name) =>
    `SET ident_user=${encodeURIComponent(String(name || 'GodsEyeView').slice(0, 24))}`,
  keepalive: () => 'SET keepalive',
  waterfallView: ({ zoom, centerKhz }) =>
    `SET zoom=${Math.min(MAX_ZOOM, Math.max(0, Math.round(zoom)))} cf=${fixed(centerKhz)}`,
  waterfallRange: () => 'SET maxdb=0 mindb=-100',
  waterfallSpeed: (speed = 2) =>
    `SET wf_speed=${Math.min(4, Math.max(1, Math.round(speed)))}`,
  waterfallNoCompression: () => 'SET wf_comp=0',
});

/** Bandwidth in kHz that the waterfall covers at a zoom level. */
export function waterfallSpanKhz(zoom, fullKhz = FULL_BANDWIDTH_KHZ) {
  return fullKhz / 2 ** Math.min(MAX_ZOOM, Math.max(0, zoom));
}

/** Centre a zoomed view on a frequency without running off either band edge. */
export function waterfallCenterKhz(
  freqKhz,
  zoom,
  fullKhz = FULL_BANDWIDTH_KHZ,
) {
  const span = waterfallSpanKhz(zoom, fullKhz);
  const half = span / 2;
  return Math.min(fullKhz - half, Math.max(half, freqKhz));
}

/** Frequency under a horizontal fraction (0..1) of the waterfall. */
export function frequencyAtFraction(fraction, view) {
  const span = waterfallSpanKhz(view.zoom, view.fullKhz);
  const f = Math.min(1, Math.max(0, fraction));
  return view.centerKhz - span / 2 + f * span;
}

/** Horizontal fraction of a frequency in the waterfall, or null when off screen. */
export function fractionOfFrequency(freqKhz, view) {
  const span = waterfallSpanKhz(view.zoom, view.fullKhz);
  const f = (freqKhz - (view.centerKhz - span / 2)) / span;
  return f >= 0 && f <= 1 ? f : null;
}

function decodeValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** "a=1 b=hello%20there flag" -> { a: '1', b: 'hello there', flag: '' } */
export function parseMessageText(text) {
  const out = {};
  for (const token of String(text).split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq < 0) out[token] = '';
    else out[token.slice(0, eq)] = decodeValue(token.slice(eq + 1));
  }
  return out;
}

/**
 * Parse one binary server frame. Returns { kind: 'msg'|'snd'|'wf'|'unknown', ... }
 * and never throws: a malformed frame is skipped, not fatal to the stream.
 */
export function parseFrame(buffer) {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
  if (bytes.length < 4) return { kind: 'unknown' };
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  // MSG and W/F carry one filler byte after the tag; SND does not: its
  // header (flags, seq, S-meter) starts immediately after "SND". Matches the
  // reference client (kiwiclient: body[1:] for MSG and W/F, body as-is for SND).
  if (tag === 'SND') return parseSound(bytes.subarray(3));
  const body = bytes.subarray(4);
  if (tag === 'MSG')
    return { kind: 'msg', fields: parseMessageText(TEXT.decode(body)) };
  if (tag === 'W/F') return parseWaterfall(body);
  return { kind: 'unknown', tag };
}

const FLAG_STEREO = 0x08;
const FLAG_COMPRESSED = 0x10;
const FLAG_LITTLE_ENDIAN = 0x80;

function parseSound(body) {
  if (body.length < 7) return { kind: 'unknown', tag: 'SND' };
  const flags = body[0];
  const smeterRaw = (body[5] << 8) | body[6];
  let offset = 7;
  // IQ modes carry a GPS timestamp block ahead of the samples.
  if (flags & FLAG_STEREO) offset += 10;
  return {
    kind: 'snd',
    flags,
    compressed: Boolean(flags & FLAG_COMPRESSED),
    stereo: Boolean(flags & FLAG_STEREO),
    littleEndian: Boolean(flags & FLAG_LITTLE_ENDIAN),
    // Reported as dBm: 0.1 * raw - 127.
    dbm: 0.1 * smeterRaw - 127,
    data: body.subarray(offset),
  };
}

function parseWaterfall(body) {
  if (body.length < 12) return { kind: 'unknown', tag: 'W/F' };
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return {
    kind: 'wf',
    xBin: view.getUint32(0, true),
    flags: view.getUint32(4, true),
    seq: view.getUint32(8, true),
    // Each pixel is dB + 255, so 255 is 0 dB and 145 is -110 dB.
    bins: body.subarray(12),
  };
}

/** Raw PCM -> floats in [-1, 1). */
export function decodePcm16(data, littleEndian = false) {
  const count = data.length >> 1;
  const out = new Float32Array(count);
  const view = new DataView(data.buffer, data.byteOffset, count * 2);
  for (let i = 0; i < count; i++)
    out[i] = view.getInt16(i * 2, littleEndian) / 32768;
  return out;
}

const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8];

/**
 * Stateful IMA ADPCM decoder, low nibble first. Only used if a receiver
 * ignores the request for uncompressed audio.
 */
export function createAdpcmDecoder() {
  let predictor = 0;
  let index = 0;
  const nibble = (code) => {
    const step = STEP_TABLE[index];
    let diff = step >> 3;
    if (code & 4) diff += step;
    if (code & 2) diff += step >> 1;
    if (code & 1) diff += step >> 2;
    predictor += code & 8 ? -diff : diff;
    predictor = Math.max(-32768, Math.min(32767, predictor));
    index = Math.max(0, Math.min(88, index + INDEX_TABLE[code & 7]));
    return predictor / 32768;
  };
  return {
    decode(data) {
      const out = new Float32Array(data.length * 2);
      for (let i = 0; i < data.length; i++) {
        out[i * 2] = nibble(data[i] & 0x0f);
        out[i * 2 + 1] = nibble(data[i] >> 4);
      }
      return out;
    },
    reset() {
      predictor = 0;
      index = 0;
    },
  };
}

/** Test helper and reference encoder matching {@link createAdpcmDecoder}. */
export function encodeAdpcmForTest(samples) {
  let predictor = 0;
  let index = 0;
  const codes = [];
  for (const s of samples) {
    const target = Math.round(s * 32768);
    const step = STEP_TABLE[index];
    let diff = target - predictor;
    let code = 0;
    if (diff < 0) {
      code = 8;
      diff = -diff;
    }
    let temp = step;
    if (diff >= temp) ((code |= 4), (diff -= temp));
    temp >>= 1;
    if (diff >= temp) ((code |= 2), (diff -= temp));
    temp >>= 1;
    if (diff >= temp) code |= 1;
    // Reconstruct exactly as the decoder will.
    let delta = step >> 3;
    if (code & 4) delta += step;
    if (code & 2) delta += step >> 1;
    if (code & 1) delta += step >> 2;
    predictor += code & 8 ? -delta : delta;
    predictor = Math.max(-32768, Math.min(32767, predictor));
    index = Math.max(0, Math.min(88, index + INDEX_TABLE[code & 7]));
    codes.push(code);
  }
  const out = new Uint8Array(Math.ceil(codes.length / 2));
  codes.forEach((c, i) => {
    out[i >> 1] |= i % 2 ? c << 4 : c;
  });
  return out;
}

/** dBm -> "S7" / "S9+20" style readout (S9 = -73 dBm, 6 dB per S-unit). */
export function formatSmeter(dbm) {
  if (!Number.isFinite(dbm)) return '--';
  if (dbm >= -73) {
    const over = Math.round((dbm + 73) / 10) * 10;
    return over > 0 ? `S9+${over}` : 'S9';
  }
  return `S${Math.max(0, Math.round((dbm + 127) / 6))}`;
}

/** Interpret server MSG fields that mean the session cannot proceed. */
export function fatalReason(fields) {
  // Receivers also send harmless `badp=0` / `down=0` style fields; only the
  // non-zero forms are fatal.
  if ('too_busy' in fields && fields.too_busy !== '0')
    return msg('All listening slots on this receiver are in use.');
  // badp codes per the reference client (kiwiclient): 1 is "bad password OR
  // every password-free channel is busy", which is the common public-Kiwi case.
  const badp = {
    1: msg(
      'This receiver needs a password, or all its open channels are busy.',
    ),
    2: msg('This receiver is still starting up. Try again in a few moments.'),
    3: msg('This receiver refused the connection (admin address only).'),
    4: msg('This receiver refused the connection (local network only).'),
    5: msg('This receiver allows only one connection per IP address.'),
    6: msg('This receiver is updating its database. Try again in a minute.'),
    7: msg('This receiver refused the connection (admin session in use).'),
  }[fields.badp];
  if (badp) return badp;
  if ('down' in fields && fields.down !== '0')
    return msg('This receiver is down for maintenance.');
  if (fields.redirect) return msg('This receiver redirected elsewhere.');
  return null;
}

/** "7074.000" kHz -> "7.074 MHz" below/above 1 MHz readouts. */
export function formatFrequency(freqKhz) {
  if (!Number.isFinite(freqKhz)) return '--';
  return freqKhz >= 1000
    ? `${(freqKhz / 1000).toFixed(3)} MHz`
    : `${freqKhz.toFixed(2)} kHz`;
}

/** "29.3 kHz" / "1.88 MHz": how much spectrum the waterfall currently shows. */
export function formatSpan(spanKhz) {
  if (!Number.isFinite(spanKhz)) return '--';
  if (spanKhz >= 1000) return `${+(spanKhz / 1000).toFixed(2)} MHz`;
  if (spanKhz >= 10) return `${+spanKhz.toFixed(1)} kHz`;
  return `${+spanKhz.toFixed(2)} kHz`;
}

/**
 * How finely a click or arrow key should tune for a given visible span: the
 * full 30 MHz view cannot resolve better than 1 kHz, a few-kHz view can
 * resolve 10 Hz.
 */
export function tuneStepKhz(spanKhz) {
  if (spanKhz >= 2000) return 1;
  if (spanKhz >= 200) return 0.1;
  return 0.01;
}

/** Snap a frequency to the grid {@link tuneStepKhz} gives for this span. */
export function snapFrequencyKhz(freqKhz, spanKhz) {
  const step = tuneStepKhz(spanKhz);
  return Number((Math.round(freqKhz / step) * step).toFixed(3));
}

/**
 * Zoom one or more levels while keeping the frequency under the pointer where
 * it is on screen. Returns `{ zoom, centerKhz }`, or null when already at the
 * limit.
 */
export function zoomAround(view, fraction, delta) {
  const zoom = Math.min(MAX_ZOOM, Math.max(0, view.zoom + delta));
  if (zoom === view.zoom) return null;
  if (zoom === 0) return { zoom, centerKhz: view.fullKhz / 2 };
  const f = Math.min(1, Math.max(0, fraction));
  const anchor = frequencyAtFraction(f, view);
  const span = waterfallSpanKhz(zoom, view.fullKhz);
  return {
    zoom,
    centerKhz: waterfallCenterKhz(
      anchor - (f - 0.5) * span,
      zoom,
      view.fullKhz,
    ),
  };
}

/** New centre after dragging the picture `deltaFraction` of its width to the right. */
export function panCenterKhz(view, deltaFraction) {
  const span = waterfallSpanKhz(view.zoom, view.fullKhz);
  return waterfallCenterKhz(
    view.centerKhz - deltaFraction * span,
    view.zoom,
    view.fullKhz,
  );
}

/** Evenly spaced, round-numbered axis ticks for the visible span. */
export function axisTicks(view, target = 5) {
  const span = waterfallSpanKhz(view.zoom, view.fullKhz);
  const raw = span / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const start = view.centerKhz - span / 2;
  const first = Math.ceil(start / step) * step;
  const ticks = [];
  for (let f = first; f <= start + span + 1e-6; f += step) {
    ticks.push({
      fraction: (f - start) / span,
      label: f >= 1000 ? `${+(f / 1000).toFixed(3)}M` : `${+f.toFixed(1)}k`,
    });
  }
  return ticks;
}

/** Quick-tune presets: label, kHz. Mode follows {@link defaultModeFor}. */
export const PRESETS = Object.freeze([
  // i18n-ignore: band name
  { label: 'MW', freqKhz: 1000 },
  { label: '49m', freqKhz: 6000 },
  // i18n-ignore: band name
  { label: 'WWV 10', freqKhz: 10_000 },
  { label: '31m', freqKhz: 9600 },
  { label: '40m', freqKhz: 7150 },
  { label: '20m', freqKhz: 14_200 },
  { label: '15m', freqKhz: 21_200 },
]);
