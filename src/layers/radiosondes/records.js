// SondeHub is CC BY-SA 2.0: runtime display only. Never put telemetry or
// tracks in bundled assets, exports, or Director packs. Receiver data is private.
export const SONDE_MAX_SERIALS = 2000;
export const SONDE_TRACK_MAX_POINTS = 1100;
export const SONDE_RETAIN_MS = 3 * 60 * 60_000;
export const SONDE_SERIAL_RE = /^[A-Za-z0-9_-]{3,24}$/;
// Silence changes what a last fix can claim, independently of receiver receipts.
export const RADIOSONDE_SILENT_MS = 10 * 60_000;
export const RADIOSONDE_INFERRED_LANDING_MAX_ALT_M = 2000;
// Reject small vertical-velocity and track-altitude changes as GPS noise.
export const RADIOSONDE_VERTICAL_NOISE_MPS = 0.5;
export const RADIOSONDE_TRACK_NOISE_M = 100;
const LANDING_OBSERVATION_MS = 120_000;
const LANDING_OBSERVED_MAX_ALT_M = 1500;
const LANDING_STILL_RANGE_M = 60;
const numeric = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value) =>
  typeof value === 'string' ? value.trim().slice(0, 80) || null : null;
const timestamp = (value) =>
  typeof value === 'number' ? numeric(value) : Date.parse(value);

/** Explicit projection, shared by ingest and the browser; never spread input. */
export function normalizeSondeFrame(raw, nowMs, { history = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const serial = text(raw.serial);
  const timeMs = timestamp(raw.timeMs ?? raw.datetime);
  const lat = numeric(raw.lat),
    lon = numeric(raw.lon);
  const altM = numeric(raw.altM ?? raw.alt);
  if (
    !SONDE_SERIAL_RE.test(serial || '') ||
    !Number.isFinite(timeMs) ||
    timeMs < 0 ||
    timeMs > nowMs + 60_000 ||
    (!history && timeMs < nowMs - SONDE_RETAIN_MS) ||
    lat === null ||
    lat < -90 ||
    lat > 90 ||
    lon === null ||
    lon < -180 ||
    lon > 180 ||
    altM === null ||
    altM < -500 ||
    altM > 50_000
  )
    return null;
  const received = timestamp(raw.receivedMs ?? raw.time_received);
  return {
    stableId: `sonde:${serial}`,
    serial,
    type: text(raw.type),
    subtype: text(raw.subtype),
    manufacturer: text(raw.manufacturer),
    timeMs,
    receivedMs:
      Number.isFinite(received) && received >= 0
        ? Math.min(received, nowMs)
        : nowMs,
    lat,
    lon,
    altM,
    vVelMps: numeric(raw.vVelMps ?? raw.vel_v),
    hVelMps: numeric(raw.hVelMps ?? raw.vel_h),
    headingDeg: numeric(raw.headingDeg ?? raw.heading),
    tempC: numeric(raw.tempC ?? raw.temp),
    humidityPct: numeric(raw.humidityPct ?? raw.humidity),
    pressureHpa: numeric(raw.pressureHpa ?? raw.pressure),
    frequencyMhz: numeric(raw.frequencyMhz ?? raw.frequency),
    battV: numeric(raw.battV ?? raw.batt),
    sats: numeric(raw.sats),
    burstTimerS: numeric(raw.burstTimerS ?? raw.burst_timer),
  };
}

/** Accept only a newer fix; equal-time receiver copies retain prior telemetry. */
export function mergeFrame(previous, next) {
  return next && (!previous || next.timeMs > previous.timeMs) ? next : previous;
}

/** Project a validated fix to the four fields retained in track history. */
export function trackPoint(frame) {
  return {
    timeMs: frame.timeMs,
    lat: frame.lat,
    lon: frame.lon,
    altM: frame.altM,
  };
}

/** Time-uniform sample, preserving endpoints and the observed altitude maximum. */
export function decimateTrack(track, limit = 2000) {
  const sorted = [
    ...new Map(track.map((p) => [p.timeMs, trackPoint(p)])).values(),
  ].sort((a, b) => a.timeMs - b.timeMs);
  if (sorted.length <= limit) return sorted;
  if (limit < 3)
    return limit === 1 ? sorted.slice(-1) : [sorted[0], sorted.at(-1)];
  let peak = 0;
  sorted.forEach((p, i) => {
    if (p.altM > sorted[peak].altM) peak = i;
  });
  const indices = new Set([0, peak, sorted.length - 1]);
  const start = sorted[0].timeMs,
    span = sorted.at(-1).timeMs - start;
  let cursor = 0;
  for (let i = 1; i < limit - 1 && indices.size < limit; i++) {
    const target = start + (span * i) / (limit - 1);
    while (cursor + 1 < sorted.length && sorted[cursor].timeMs < target)
      cursor++;
    indices.add(cursor);
  }
  for (let i = 1; indices.size < limit; i++) indices.add(i);
  return [...indices].sort((a, b) => a - b).map((i) => sorted[i]);
}

/** Whether an observed or inferred landing uses the shared surface treatment. */
export function isSondeLanded(phase) {
  return phase === 'landed' || phase === 'landed-inferred';
}
/** Whether a phase still represents an airborne contact with a current fix. */
export function isSondeAloft(phase) {
  return phase === 'ascending' || phase === 'descending' || phase === 'unknown';
}

/** Shared telemetry/clock classification; selection never changes its result. */
export function flightPhase(
  track,
  frame = track.at(-1),
  nowMs = frame?.timeMs,
) {
  if (!frame) return { phase: 'unknown', burstIndex: null };
  let peak = 0;
  let minAltM = frame.altM;
  track.forEach((p, i) => {
    if (p.altM > track[peak].altM) peak = i;
    minAltM = Math.min(minAltM, p.altM);
  });
  const quietStart = track.findLastIndex(
    (p) => p.timeMs <= frame.timeMs - LANDING_OBSERVATION_MS,
  );
  const quiet = quietStart >= 0 ? track.slice(quietStart) : [];
  let quietMin = Infinity,
    quietMax = -Infinity;
  for (const point of quiet) {
    quietMin = Math.min(quietMin, point.altM);
    quietMax = Math.max(quietMax, point.altM);
  }
  const stillTrack =
    quiet.length > 1 &&
    Math.abs(
      frame.vVelMps ??
        (frame.altM - quiet[0].altM) /
          ((frame.timeMs - quiet[0].timeMs) / 1000),
    ) <= RADIOSONDE_VERTICAL_NOISE_MPS &&
    quietMax - quietMin < LANDING_STILL_RANGE_M;
  const landed =
    frame.altM < LANDING_OBSERVED_MAX_ALT_M &&
    stillTrack &&
    quietMax < LANDING_OBSERVED_MAX_ALT_M;
  const fallingTrack =
    track.length > 1 &&
    track[peak].altM - frame.altM >= RADIOSONDE_TRACK_NOISE_M;
  const descending =
    fallingTrack || frame.vVelMps < -RADIOSONDE_VERTICAL_NOISE_MPS;
  const ascending =
    frame.vVelMps > RADIOSONDE_VERTICAL_NOISE_MPS ||
    frame.altM - minAltM >= RADIOSONDE_TRACK_NOISE_M;
  const still =
    stillTrack ||
    (Number.isFinite(frame.vVelMps) &&
      Math.abs(frame.vVelMps) <= RADIOSONDE_VERTICAL_NOISE_MPS);
  let phase = landed
    ? 'landed'
    : descending
      ? 'descending'
      : ascending
        ? 'ascending'
        : 'unknown';
  if (!landed && nowMs - frame.timeMs > RADIOSONDE_SILENT_MS)
    phase =
      frame.altM < RADIOSONDE_INFERRED_LANDING_MAX_ALT_M &&
      (descending || still)
        ? 'landed-inferred'
        : 'signal-lost';
  return {
    phase,
    burstIndex: fallingTrack ? peak : null,
  };
}
