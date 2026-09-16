import net from 'node:net';
import tls from 'node:tls';
import { parseAprsLine, parseAprsTelemetry } from './aprs-parser.js';

const MAX = 2000;
const STALE = 30 * 60_000;
const HISTORY_MAX_SAMPLES = 64;
const HISTORY_MAX_VESSELS = 5000;
const TELEMETRY_MAX_SAMPLES = 32;
const FILTER_MIN_INTERVAL_MS = 5_000;
const DEFAULT_FILTER = 'r/0/0/180';
const REFERENCE_RE = /^[A-Za-z0-9:_-]{1,64}$/;

const records = new Map();
const histories = new Map();
const telemetry = new Map();

let socket = null;
let timer = null;
let attempt = 0;
let state = 'idle';
let nextAttemptAt = null;
let activeFilter = null;
let lastFilterAt = 0;

function configured() {
  return Boolean(
    process.env.APRS_IS_HOST || process.env.APRS_IS_ENABLED === '1',
  );
}
function envFilter() {
  return process.env.APRS_IS_FILTER || DEFAULT_FILTER;
}
/** The filter currently in force (viewport-derived once one has arrived). */
export function currentFilter() {
  return activeFilter ?? envFilter();
}

/**
 * Build APRS-IS area filters for a geographic viewport.
 *
 * APRS-IS expresses an area as `a/latN/lonW/latS/lonE`. A viewport that crosses
 * the antimeridian cannot be one box, so it is split into two. Anything
 * malformed or degenerate falls back to the configured filter.
 * @param {?{west:number,south:number,east:number,north:number}} viewport
 * @returns {string[]} One or two `a/...` filters, or the configured fallback.
 */
export function aprsAreaFilters(viewport) {
  const fallback = envFilter();
  if (!viewport) return [fallback];
  const read = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const west = read(viewport.west),
    south = read(viewport.south),
    east = read(viewport.east),
    north = read(viewport.north);
  if ([west, south, east, north].some((v) => v === null)) return [fallback];
  const w = Math.max(-180, Math.min(180, west));
  const e = Math.max(-180, Math.min(180, east));
  const s = Math.max(-90, Math.min(90, south));
  const n = Math.max(-90, Math.min(90, north));
  if (s >= n || w === e) return [fallback];
  const box = (westEdge, eastEdge) =>
    `a/${n.toFixed(3)}/${westEdge.toFixed(3)}/${s.toFixed(3)}/${eastEdge.toFixed(3)}`;
  if (w > e) return [box(w, 180), box(-180, e)];
  return [box(w, e)];
}

/**
 * Adopt a viewport-derived filter on the live connection without reconnecting.
 * Coalesced by both a change check and a minimum interval so camera movement
 * cannot flood APRS-IS with filter commands.
 * @returns {boolean} True when the filter actually changed.
 */
export function updateViewportFilter(viewport, nowMs = Date.now()) {
  const next = aprsAreaFilters(viewport).join(' ');
  if (next === currentFilter()) return false;
  if (nowMs - lastFilterAt < FILTER_MIN_INTERVAL_MS) return false;
  activeFilter = next;
  lastFilterAt = nowMs;
  if (socket?.writable) socket.write(`filter ${next}\n`);
  return true;
}

function recordHistory(reference, lat, lon, tSec) {
  let history = histories.get(reference);
  if (!history) {
    if (histories.size >= HISTORY_MAX_VESSELS)
      histories.delete(histories.keys().next().value);
    history = [];
    histories.set(reference, history);
  }
  const last = history[history.length - 1];
  if (last && last.lat === lat && last.lon === lon && last.t === tSec) return;
  history.push({ lat, lon, t: tSec });
  if (history.length > HISTORY_MAX_SAMPLES) history.shift();
}

function recordTelemetry(reference, sample) {
  let entry = telemetry.get(reference);
  if (!entry) {
    entry = { latest: null, samples: [] };
    telemetry.set(reference, entry);
  }
  entry.latest = sample;
  entry.samples.push(sample);
  if (entry.samples.length > TELEMETRY_MAX_SAMPLES) entry.samples.shift();
}

/** Ingest one APRS-IS line into the bounded position, history and telemetry stores. */
export function ingestAprsLine(line, nowMs = Date.now()) {
  const telemetrySample = parseAprsTelemetry(line, nowMs);
  if (telemetrySample) {
    recordTelemetry(telemetrySample.reference, telemetrySample);
    return;
  }
  const row = parseAprsLine(line, nowMs);
  if (!row) return;
  const tSec = Math.floor(nowMs / 1000);
  // Emit the provider-neutral vessel field names the client normalizer expects
  // (`input_identifier`, `last_position_epoch`) so APRS beacons, which have no
  // MMSI, are not rejected downstream.
  const identifier = row.mmsi || row.callsign || row.reference;
  records.set(row.reference, {
    mmsi: row.mmsi,
    input_identifier: identifier,
    reference: row.reference,
    name: row.name || row.callsign || `MMSI ${row.mmsi}`,
    lat: row.lat,
    lon: row.lon,
    course: row.course,
    speed: row.speed,
    last_position_epoch: tSec,
    source: row.source,
    transport: row.transport,
    protocol: row.metadata?.protocol ?? null,
    _updatedAt: nowMs,
  });
  if (Number.isFinite(row.lat) && Number.isFinite(row.lon))
    recordHistory(row.reference, row.lat, row.lon, tSec);
  prune(nowMs);
}

/** Chronological position samples for one reference, oldest first. */
export function aprsTrack(reference) {
  const history = histories.get(reference);
  return history
    ? history.map((sample) => ({
        lat: sample.lat,
        lon: sample.lon,
        t: sample.t,
      }))
    : [];
}

/** Latest telemetry for one reference, or null. */
export function aprsTelemetry(reference) {
  return telemetry.get(reference) ?? null;
}

function prune(nowMs = Date.now()) {
  const cutoff = nowMs - STALE;
  for (const [key, row] of records)
    if (row._updatedAt < cutoff) {
      records.delete(key);
      histories.delete(key);
      telemetry.delete(key);
    }
  while (records.size > MAX) records.delete(records.keys().next().value);
  while (histories.size > HISTORY_MAX_VESSELS)
    histories.delete(histories.keys().next().value);
}

function connect() {
  if (!configured() || socket) return;
  state = 'connecting';
  const host = process.env.APRS_IS_HOST || 'rotate.aprs2.net';
  const port = Number(process.env.APRS_IS_PORT || 14580);
  socket = (process.env.APRS_IS_TLS === '1' ? tls : net).connect(
    { host, port, timeout: 20_000 },
    () => {
      state = 'live';
      attempt = 0;
      socket.write(
        `user ${process.env.APRS_IS_CALLSIGN || 'N0CALL'} pass ${process.env.APRS_IS_PASSCODE || '-1'} vers gods-eye-view 1.0\nfilter ${currentFilter()}\n`,
      );
    },
  );
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      ingestAprsLine(line);
    }
  });
  const retry = () => {
    socket = null;
    state = 'down';
    const delay = Math.min(300_000, 2_000 * 2 ** Math.min(attempt++, 7));
    nextAttemptAt = Date.now() + delay;
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
    timer.unref?.();
  };
  socket.on('error', retry);
  socket.on('close', retry);
  socket.on('timeout', () => socket.destroy());
}

function json(res, value, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

function viewportFromQuery(url) {
  const read = (key) => {
    const raw = url.searchParams.get(key);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const west = read('west'),
    south = read('south'),
    east = read('east'),
    north = read('north');
  if ([west, south, east, north].some((value) => value === null)) return null;
  return { west, south, east, north };
}

function trackResponse(res, url) {
  const reference = url.searchParams.get('reference') || '';
  if (!REFERENCE_RE.test(reference))
    return json(res, { error: 'invalid_reference' }, 400);
  return json(res, {
    samples: aprsTrack(reference),
    telemetry: aprsTelemetry(reference),
    source: 'APRS-IS',
    complete: false,
    status: state,
    configured: configured(),
  });
}

/** Connect middleware for the mounted `/api/aprs-live` path. */
export function aprsLiveHandler(req, res) {
  const url = new URL(req.url || '', 'http://localhost');
  if (url.pathname === '/track' || url.pathname === '/track/')
    return trackResponse(res, url);
  const maxRows = Math.min(
    2000,
    Math.max(
      1,
      Number.parseInt(url.searchParams.get('maxRows') || '2000', 10) || 2000,
    ),
  );
  const viewport = viewportFromQuery(url);
  if (viewport) updateViewportFilter(viewport);
  const rows = [...records.values()]
    .sort((a, b) => b._updatedAt - a._updatedAt)
    .slice(0, maxRows)
    .map(({ _updatedAt, ...row }) => {
      const entry = telemetry.get(row.reference);
      return entry?.latest ? { ...row, telemetry: entry.latest } : row;
    });
  json(
    res,
    {
      rows,
      source: 'APRS-IS',
      status: state,
      configured: configured(),
      nextAttemptAt,
      filter: currentFilter(),
    },
    configured() ? 200 : 503,
  );
}

export function aprsLiveProxy() {
  return {
    name: 'aprs-live-proxy',
    configureServer(server) {
      server.middlewares.use('/api/aprs-live', aprsLiveHandler);
      connect();
      server.httpServer?.on('close', dispose);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/aprs-live', aprsLiveHandler);
      connect();
      server.httpServer?.on('close', dispose);
    },
    closeBundle: dispose,
  };
}

function dispose() {
  if (timer) clearTimeout(timer);
  timer = null;
  socket?.destroy();
  socket = null;
  state = 'idle';
}

/** Test seam: drop all accumulated state and the active filter. */
export function resetAprsStateForTest() {
  records.clear();
  histories.clear();
  telemetry.clear();
  activeFilter = null;
  lastFilterAt = 0;
  nextAttemptAt = null;
  state = 'idle';
}

export { parseAprsLine } from './aprs-parser.js';
