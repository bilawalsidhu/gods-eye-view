import { createEccodes } from '@meri-imperiumi/eccodes-wasm';
import {
  UPSTREAM_NOT_ALLOWED,
  createPacer,
  isUpstreamRefusal,
} from '../sourcePolicy.js';

/**
 * On-device wind: NOAA GFS 10 m wind via direct fetch + eccodes-wasm GRIB2 decode.
 *
 * Mirrors the server's `server/providers/wind/gfs.js` `fetchGfsWind` and
 * `server/providers/wind/decode.js` `decodeWindGribMessage`. Uses the shared
 * `resampleWeatherSnapshot` logic (duplicated here with canonical pointer to
 * `server/providers/wind/grid.js`).
 *
 * @module mobile/adapters/windDirect
 */

const GFS_BUCKET = 'noaa-gfs-bdp-pds';
const DEFAULT_MIN_INTERVAL_MS = 60_000; // Courtesy: one request per minute max
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_GRIB_BYTES = 8 * 1024 * 1024;

/**
 * Create the on-device wind direct source.
 * @param {{ fetchImpl?: Function, pacer?: { wait: Function }, decodeImpl?: Function }} options
 * @returns {{ getSnapshot: Function }}
 */
export function createWindDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  pacer = createPacer(DEFAULT_MIN_INTERVAL_MS),
  decodeImpl = decodeWindGribMessage,
} = {}) {
  const inFlight = new Map();

  /**
   * Fetch and decode the GFS 10 m wind field valid closest to now.
   * @param {{ overlay?: 'none'|'temperature'|'pressure', targetDx?: number, signal?: AbortSignal }} options
   * @returns {Promise<object>} Snapshot: { cycle, level, units, grid, scalar?, scalarError? }
   */
  async function getSnapshot({ overlay = 'none', targetDx = 1, signal } = {}) {
    const key = `wind:${overlay}:${targetDx}`;
    let inflight = inFlight.get(key);
    if (!inflight) {
      inflight = (async () => {
        try {
          await pacer.wait({ signal });
          signal?.throwIfAborted();

          const nowMs = Date.now();
          const cycle = selectLatestGfsCycle(nowMs);
          const runMs = Date.UTC(
            Number(cycle.date.slice(0, 4)),
            Number(cycle.date.slice(4, 6)) - 1,
            Number(cycle.date.slice(6, 8)),
            cycle.hour,
          );
          const forecastHour = nearestGfsStep((nowMs - runMs) / 3600_000);
          const base = `https://${GFS_BUCKET}.s3.amazonaws.com/${gfsObjectKey({ ...cycle, forecastHour })}`;

          const indexBytes = await fetchText({
            url: `${base}.idx`,
            fetchImpl,
            signal,
          });
          const inventory = parseGfsIdx(indexBytes.toString());
          const ranges = windMessageRanges(inventory, { overlay });

          let scalarRange;
          if (overlay !== 'none') {
            try {
              scalarRange = windMessageRanges(inventory, { overlay }).scalar;
            } catch {
              // Optional scalar field missing; wind still valid
            }
          }

          const load = async (range) => {
            const bytes = await fetchRange({
              url: base,
              ...range,
              fetchImpl,
              signal,
              maxBytes: MAX_GRIB_BYTES,
            });
            return decodeImpl(bytes);
          };

          const [u, v, scalar] = await Promise.all([
            load(ranges.u),
            load(ranges.v),
            loadOptionalScalar({
              range: scalarRange,
              url: base,
              fetchImpl,
              decodeImpl,
              signal,
            }),
          ]);

          signal?.throwIfAborted();

          const fields = resampleWeatherSnapshot({
            u,
            v,
            scalar,
            overlay,
            targetDx,
          });
          const runIso = new Date(runMs).toISOString();
          const validIso = new Date(
            runMs + forecastHour * 3600_000,
          ).toISOString();

          return {
            cycle: { ...cycle, forecastHour, runIso, validIso },
            level: '10 m above ground',
            units: 'm/s',
            ...fields,
          };
        } catch (error) {
          if (isUpstreamRefusal(error)) {
            return { unavailable: UPSTREAM_NOT_ALLOWED };
          }
          throw error;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, inflight);
    }

    return inflight;
  }

  return { getSnapshot };
}

/**
 * Fetch a bounded text response.
 * @param {{ url: string, fetchImpl: Function, signal?: AbortSignal }} options
 * @returns {Promise<Uint8Array>}
 */
async function fetchText({ url, fetchImpl, signal }) {
  const response = await fetchImpl(url, { signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Wind upstream unavailable');
  }
  return readResponseBytesCapped(response, 2 * 1024 * 1024, signal);
}

/**
 * Fetch one bounded byte range.
 * @param {{ url: string, start: number, end: number, fetchImpl: Function, signal?: AbortSignal, maxBytes?: number }} options
 * @returns {Promise<Uint8Array>}
 */
async function fetchRange({
  url,
  start,
  end,
  fetchImpl,
  signal,
  maxBytes = MAX_GRIB_BYTES,
}) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end - start + 1 > maxBytes
  ) {
    throw new Error('range too large');
  }
  const response = await fetchImpl(url, {
    signal,
    redirect: 'error',
    headers: { Range: `bytes=${start}-${end}` },
  });
  const validStatus =
    response.status === 206 || (response.status === 200 && start === 0);
  if (!validStatus || !response.ok) {
    await response.body?.cancel();
    throw new Error('Wind upstream unavailable');
  }
  const buffer = await readResponseBytesCapped(
    response,
    end - start + 1,
    signal,
  );
  if (buffer.length !== end - start + 1) {
    throw new Error('invalid range length');
  }
  return buffer;
}

/**
 * Bounded optional request for scalar field (temperature/pressure).
 * @param {{ range?: object, url: string, fetchImpl: Function, decodeImpl: Function, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<object|undefined>}
 */
async function loadOptionalScalar({
  range,
  url,
  fetchImpl,
  decodeImpl,
  signal,
  timeoutMs = 12_000,
}) {
  if (!range) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    signal?.throwIfAborted();
    const bytes = await fetchRange({
      url,
      ...range,
      fetchImpl,
      signal: controller.signal,
    });
    const value = await decodeImpl(bytes);
    controller.signal.throwIfAborted();
    return value;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Read response body with a hard byte cap.
 * @param {Response} response
 * @param {number} maxBytes
 * @param {AbortSignal} [signal]
 * @returns {Promise<Uint8Array>}
 */
async function readResponseBytesCapped(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  if (!response.body) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}

// --- Canonical pointer: server/providers/wind/decode.js ---
/**
 * Decode one bounded GRIB2 message in WASM memory without mounting the host filesystem.
 * Canonical implementation: server/providers/wind/decode.js
 * @param {Uint8Array|ArrayBuffer} buffer
 * @param {{ eccodesModule?: object }} [options]
 * @returns {Promise<object>}
 */
async function decodeWindGribMessage(buffer, { eccodesModule } = {}) {
  if (buffer.byteLength > MAX_GRIB_BYTES)
    throw new Error('Wind GRIB exceeds byte budget');
  const eccodes = eccodesModule ?? (await createEccodes());
  const file = '/gev-wind.grib2';
  let handle = null;
  try {
    eccodes.writeFile(file, buffer);
    handle = eccodes.openGrib(file);
    const ni = handle.getLong('Ni');
    const nj = handle.getLong('Nj');
    if (
      !Number.isInteger(ni) ||
      !Number.isInteger(nj) ||
      ni < 1 ||
      nj < 1 ||
      ni * nj > 2_000_000
    ) {
      throw new Error('Invalid wind GRIB geometry');
    }
    return {
      ni,
      nj,
      lo1: handle.getDouble('longitudeOfFirstGridPointInDegrees'),
      la1: handle.getDouble('latitudeOfFirstGridPointInDegrees'),
      di: handle.getDouble('iDirectionIncrementInDegrees'),
      dj: handle.getDouble('jDirectionIncrementInDegrees'),
      values: handle.getDoubleArray('values'),
      shortName: handle.getString('shortName'),
      level: handle.getLong('level'),
      units: handle.getString('units'),
    };
  } finally {
    handle?.delete();
    eccodes.writeFile(file, new Uint8Array(0));
  }
}

// --- Canonical pointer: server/providers/wind/gfs.js ---
/**
 * Parse a GFS `.idx` inventory into ordered message records.
 * Canonical implementation: server/providers/wind/gfs.js
 * @param {string} text - Raw `.idx` body.
 * @returns {{ messages: Array<{index: number, offset: number, variable: string, level: string}> }}
 */
function parseGfsIdx(text) {
  const messages = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split(':');
    if (
      parts.length < 6 ||
      !/^\d+$/.test(parts[0]) ||
      !/^\d+$/.test(parts[1]) ||
      !parts[3] ||
      !parts[4]
    )
      continue;
    messages.push({
      index: Number(parts[0]),
      offset: Number(parts[1]),
      variable: parts[3],
      level: parts[4],
    });
  }
  if (!messages.length) throw new Error('malformed GFS index');
  return { messages };
}

/**
 * Byte ranges for the two 10 m wind components.
 * Canonical implementation: server/providers/wind/gfs.js
 * @param {{messages: Array<object>}} parsed - parseGfsIdx result.
 * @param {{level?: string}} [options]
 * @returns {{u: {start: number, end: number}, v: {start: number, end: number}, scalar?: {start: number, end: number}}}
 */
function windMessageRanges(
  parsed,
  { level = '10 m above ground', overlay = 'none' } = {},
) {
  const weatherScalarMetadata = (ov) => {
    if (ov === 'none') return null;
    if (ov === 'temperature')
      return { kind: ov, units: '°C', level: '2 m above ground' };
    if (ov === 'pressure')
      return { kind: ov, units: 'hPa', level: 'mean sea level' };
    throw new Error('Unknown weather overlay');
  };
  weatherScalarMetadata(overlay);
  const range = (variable, fieldLevel = level) => {
    const index = parsed.messages.findIndex(
      (m) => m.variable === variable && m.level === fieldLevel,
    );
    const message = parsed.messages[index];
    const next = parsed.messages[index + 1];
    if (!message || !next)
      throw new Error(`missing ${variable} at ${fieldLevel}`);
    return { start: message.offset, end: next.offset - 1 };
  };
  return {
    u: range('UGRD'),
    v: range('VGRD'),
    ...(overlay === 'temperature'
      ? { scalar: range('TMP', '2 m above ground') }
      : {}),
    ...(overlay === 'pressure'
      ? { scalar: range('PRMSL', 'mean sea level') }
      : {}),
  };
}

/**
 * Build the public GFS object key.
 * Canonical implementation: server/providers/wind/catalog.js
 * @param {{ date: string, hour: number, forecastHour?: number }} params
 * @returns {string}
 */
function gfsObjectKey({ date, hour, forecastHour = 0 }) {
  const hh = String(hour).padStart(2, '0');
  return `gfs.${date}/${hh}/atmos/gfs.t${hh}z.pgrb2.0p25.f${String(forecastHour).padStart(3, '0')}`;
}

/**
 * Select the latest GFS cycle that should be available.
 * Canonical implementation: server/providers/wind/catalog.js
 * @param {number} nowMs
 * @param {{ availabilityLagMs?: number }} [options]
 * @returns {{ date: string, hour: number }}
 */
function selectLatestGfsCycle(
  nowMs,
  { availabilityLagMs = 5 * 3600_000 } = {},
) {
  const d = new Date(nowMs - availabilityLagMs);
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const hour = Math.floor(d.getUTCHours() / 6) * 6;
  date.setUTCHours(hour);
  return { date: date.toISOString().slice(0, 10).replaceAll('-', ''), hour };
}

/**
 * Round a time offset to the nearest published GFS forecast step.
 * Canonical implementation: server/providers/wind/catalog.js
 * @param {number} hours - Hours elapsed since the cycle run time.
 * @returns {number} A valid forecast step.
 */
function nearestGfsStep(hours) {
  const value = Math.max(0, Number.isFinite(hours) ? hours : 0);
  const step = value <= 120 ? Math.round(value) : Math.round(value / 3) * 3;
  return Math.max(0, Math.min(384, step));
}

// --- Canonical pointer: server/providers/wind/grid.js ---
/**
 * Resample a GRIB wind grid into a compact equirectangular grid.
 * Canonical implementation: server/providers/wind/grid.js
 * @param {{u: ArrayLike<number>, v: ArrayLike<number>, scalar?: ArrayLike<number>, ni: number, nj: number, lo1: number, la1: number, di: number, dj: number, dx?: number, dy?: number, overlay?: string, targetDx?: number}} input
 * @returns {{grid: object, scalar?: object}}
 */
function resampleWeatherSnapshot({
  u,
  v,
  scalar,
  overlay = 'none',
  targetDx = 1,
}) {
  const weatherScalarMetadata = (ov) => {
    if (ov === 'none') return null;
    if (ov === 'temperature')
      return { kind: ov, units: '°C', level: '2 m above ground' };
    if (ov === 'pressure')
      return { kind: ov, units: 'hPa', level: 'mean sea level' };
    throw new Error('Unknown weather overlay');
  };
  const metadata = weatherScalarMetadata(overlay);
  const fields = [u, v, ...(metadata ? [scalar] : [])];
  if (
    !u ||
    fields.some(
      (f) =>
        !f || ['ni', 'nj', 'lo1', 'la1', 'di', 'dj'].some((k) => f[k] !== u[k]),
    )
  ) {
    throw new Error('Mismatched weather grid geometry');
  }
  if (metadata && scalar.units !== (overlay === 'temperature' ? 'K' : 'Pa')) {
    throw new Error('Unexpected weather scalar units');
  }
  const grid = resampleWindGrid({
    u: u.values,
    v: v.values,
    ni: u.ni,
    nj: u.nj,
    lo1: u.lo1,
    la1: u.la1,
    di: u.di,
    dj: u.dj,
    dx: targetDx,
    dy: targetDx,
    ...(metadata
      ? {
          scalar: scalar.values,
          scalarScale: overlay === 'pressure' ? 0.01 : 1,
          scalarOffset: overlay === 'temperature' ? -273.15 : 0,
        }
      : {}),
  });
  return { grid, ...(metadata ? { scalar: metadata } : {}) };
}

/**
 * Resample a GRIB wind grid into a compact equirectangular grid.
 * Canonical implementation: server/providers/wind/grid.js
 * @param {{u: ArrayLike<number>, v: ArrayLike<number>, scalar?: ArrayLike<number>, ni: number, nj: number, lo1: number, la1: number, di: number, dj: number, dx?: number, dy?: number, scalarScale?: number, scalarOffset?: number}} params
 * @returns {{nx: number, ny: number, lo1: number, la1: number, dx: number, dy: number, u: Float32Array, v: Float32Array, scalar?: Float32Array}}
 */
function resampleWindGrid({
  u,
  v,
  scalar,
  scalarScale = 1,
  scalarOffset = 0,
  ni,
  nj,
  lo1,
  la1,
  di,
  dj,
  dx = 1,
  dy = 1,
}) {
  if (
    !Number.isInteger(ni) ||
    !Number.isInteger(nj) ||
    ni < 1 ||
    nj < 1 ||
    ni * nj > 2_000_000 ||
    u?.length !== ni * nj ||
    v?.length !== ni * nj ||
    (scalar !== undefined && scalar?.length !== ni * nj) ||
    ![lo1, la1, di, dj, dx, dy, scalarScale, scalarOffset].every(
      Number.isFinite,
    ) ||
    di <= 0 ||
    dj <= 0 ||
    dx < 0.25 ||
    dy < 0.25 ||
    dx > 180 ||
    dy > 180
  )
    throw new Error('Invalid wind grid geometry');
  for (const values of [u, v, ...(scalar === undefined ? [] : [scalar])]) {
    if (!Array.prototype.every.call(values, Number.isFinite))
      throw new Error('Invalid wind grid values');
  }
  const nx = Math.round(360 / dx);
  const ny = Math.round(180 / dy) + 1;
  if (nx * ny > 1_000_000)
    throw new Error('Resampled wind grid exceeds point budget');
  const outU = new Float32Array(nx * ny);
  const outV = new Float32Array(nx * ny);
  const outScalar = scalar === undefined ? null : new Float32Array(nx * ny);
  const sample = (source, lon, lat) => {
    const x = ((lon - lo1) / di + ni) % ni;
    const y = Math.max(0, Math.min(nj - 1, (la1 - lat) / dj));
    const x0 = Math.floor(x);
    const x1 = (x0 + 1) % ni;
    const y0 = Math.floor(y);
    const y1 = Math.min(nj - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const top = source[y0 * ni + x0] * (1 - fx) + source[y0 * ni + x1] * fx;
    const bottom = source[y1 * ni + x0] * (1 - fx) + source[y1 * ni + x1] * fx;
    return top * (1 - fy) + bottom * fy;
  };
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const index = y * nx + x;
      const lon = x * dx;
      const lat = 90 - y * dy;
      outU[index] = sample(u, lon, lat);
      outV[index] = sample(v, lon, lat);
      if (outScalar)
        outScalar[index] =
          sample(scalar, lon, lat) * scalarScale + scalarOffset;
    }
  }
  for (const values of [outU, outV, ...(outScalar ? [outScalar] : [])]) {
    if (!values.every(Number.isFinite))
      throw new Error('Invalid resampled wind values');
  }
  return {
    nx,
    ny,
    lo1: 0,
    la1: 90,
    dx,
    dy,
    u: outU,
    v: outV,
    ...(outScalar ? { scalar: outScalar } : {}),
  };
}
