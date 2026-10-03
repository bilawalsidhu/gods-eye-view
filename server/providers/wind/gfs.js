import { readWindBody } from '../../../src/sources/windBody.js';
/**
 * Parse a GFS `.idx` inventory into ordered message records.
 *
 * Each line is `msgNumber:byteOffset:d=YYYYMMDDHH:VAR:LEVEL:...:`. Malformed
 * lines are skipped; a payload with no valid lines is rejected so callers never
 * treat an HTML error page as an empty inventory.
 *
 * @param {string} text - Raw `.idx` body.
 * @returns {{ messages: Array<{index: number, offset: number, variable: string, level: string}> }}
 */
export function parseGfsIdx(text) {
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
 * Byte ranges for the two 10 m wind components. A message runs from its own
 * offset to one byte before the next message in file order.
 *
 * @param {{messages: Array<object>}} parsed - {@link parseGfsIdx} result.
 * @param {{level?: string}} [options]
 * @returns {{u: {start: number, end: number}, v: {start: number, end: number}}}
 */
export function windMessageRanges(
  parsed,
  { level = '10 m above ground', overlay = 'none' } = {},
) {
  weatherScalarMetadata(overlay);
  const range = (variable, fieldLevel = level) => {
    const index = parsed.messages.findIndex(
      (message) =>
        message.variable === variable && message.level === fieldLevel,
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

/** Fetch a bounded text response as a Buffer. */
export async function fetchText({ url, fetchImpl = fetch, signal }) {
  const response = await fetchImpl(url, { signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Wind upstream unavailable');
  }
  return Buffer.from(await readWindBody(response, 2 * 1024 * 1024, signal));
}

/**
 * Fetch one bounded byte range. Rejects oversized ranges, non-206 responses
 * (except a whole-object 200 starting at zero), and short bodies.
 */
export async function fetchRange({
  url,
  start,
  end,
  fetchImpl = fetch,
  signal,
  maxBytes = 8 * 1024 * 1024,
}) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end - start + 1 > maxBytes
  )
    throw new Error('range too large');
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
  const buffer = Buffer.from(
    await readWindBody(response, end - start + 1, signal),
  );
  if (buffer.length !== end - start + 1)
    throw new Error('invalid range length');
  return buffer;
}

/** A bounded optional request may fail without cancelling valid wind siblings. */
export async function loadOptionalScalar({
  range,
  url,
  fetchImpl,
  decodeImpl,
  signal,
  timeoutMs = 12_000,
}) {
  if (!range) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
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

import {
  GFS_BUCKET,
  gfsObjectKey,
  selectLatestGfsCycle,
  nearestGfsStep,
} from './catalog.js';
import { decodeWindGribMessage } from './decode.js';
import { resampleWeatherSnapshot, weatherScalarMetadata } from './grid.js';

/** Fetch and decode the GFS 10 m wind field valid closest to now. */
export async function fetchGfsWind({
  fetchImpl = fetch,
  now = () => Date.now(),
  targetDx = 1,
  decodeImpl = decodeWindGribMessage,
  signal,
  overlay = 'none',
} = {}) {
  weatherScalarMetadata(overlay);
  const nowMs = now();
  const cycle = selectLatestGfsCycle(nowMs);
  const runMs = Date.UTC(
    Number(cycle.date.slice(0, 4)),
    Number(cycle.date.slice(4, 6)) - 1,
    Number(cycle.date.slice(6, 8)),
    cycle.hour,
  );
  // Pick the forecast step whose valid time is closest to now, so the layer
  // shows the freshest field the cycle offers instead of the analysis.
  const forecastHour = nearestGfsStep((nowMs - runMs) / 3600_000);
  const base = `https://${GFS_BUCKET}.s3.amazonaws.com/${gfsObjectKey({ ...cycle, forecastHour })}`;
  const index = await fetchText({ url: `${base}.idx`, fetchImpl, signal });
  const inventory = parseGfsIdx(index.toString());
  const ranges = windMessageRanges(inventory);
  let scalarRange;
  if (overlay !== 'none') {
    try {
      scalarRange = windMessageRanges(inventory, { overlay }).scalar;
    } catch {
      /* A missing optional field does not discard valid wind. */
    }
  }
  // All selected messages come from this one issue/valid-time object.
  const load = async (range) =>
    decodeImpl(await fetchRange({ url: base, ...range, fetchImpl, signal }));
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
  const fields = resampleWeatherSnapshot({ u, v, scalar, overlay, targetDx });
  const runIso = new Date(runMs).toISOString();
  const validIso = new Date(runMs + forecastHour * 3600_000).toISOString();
  return {
    cycle: { ...cycle, forecastHour, runIso, validIso },
    level: '10 m above ground',
    units: 'm/s',
    ...fields,
  };
}
