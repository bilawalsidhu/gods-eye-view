import { FIX_FLAGS } from './contactPlayback.js';

/**
 * The record contract for recorded position history: what a recorder writes,
 * what a history store returns, and how both reach retained playback. No
 * storage, network or scene access; `server/providers/history/dayStore.js`
 * is one store that keeps it.
 *
 * A record is one observed (or derived, or simulated) position of one
 * contact at one time:
 *   {source, key, t, lat, lon, heightM, bearingDeg, receivedAt, timeKind,
 *    provenance, flags}
 * `t` is whole milliseconds since the Unix epoch on the clock named by `timeKind`:
 * the vehicle's own report time, the feed's time, or the time it was
 * received. `provenance` keeps observed positions apart from derived ones
 * (gap filling, dead reckoning) and simulated ones (exercises, scenarios), so
 * a replay never presents one as the other. Optional numbers are NaN when
 * absent; `flags` keeps only BREAK and FLOOR.
 *
 * Coverage is the other half of a recording: the intervals during which the
 * recorder was running for a source. Where there is no coverage there is no
 * information, so a track never interpolates across it.
 */
export const HISTORY_TIME_KINDS = Object.freeze({
  vehicle: FIX_FLAGS.VEHICLE_TIME,
  feed: FIX_FLAGS.FEED_TIME,
  receipt: FIX_FLAGS.RECEIPT_TIME,
});
export const HISTORY_PROVENANCES = Object.freeze([
  'observed',
  'derived',
  'simulated',
]);
/** The flags a record may carry; LIVE and the time kinds are not stored. */
export const HISTORY_STORED_FLAGS = FIX_FLAGS.BREAK | FIX_FLAGS.FLOOR;
/** One coverage interval spans at most a day. */
export const HISTORY_COVERAGE_MAX_SPAN_MS = 86_400_000;
/**
 * A `createTrack` policy for replaying recorded history. `advance` marks
 * motion stale when the newest report is more than `staleMs` behind the
 * wall clock, which every recorded track is; a replay judges gaps by BREAK
 * instead.
 */
export const HISTORY_REPLAY_POLICY = Object.freeze({ staleMs: Infinity });
/** Source and key are at most this many UTF-8 bytes. */
export const HISTORY_IDENTIFIER_BYTES = 256;
/** 9999-12-31T23:59:59.999Z: every record time has a four-digit UTC year. */
export const HISTORY_MAX_TIME_MS = 253402300799999;

const encoder = new TextEncoder();
/** An optional number: NaN when absent, undefined when present but wrong. */
const optional = (value, valid) =>
  value === null || value === undefined || Number.isNaN(value)
    ? NaN
    : typeof value === 'number' && valid(value)
      ? value
      : undefined;

/** Whether `value` may be a source or key: see the record contract. */
export function validHistoryIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    // A lone surrogate has no UTF-8 form: stores would turn it into U+FFFD
    // and two keys into one.
    value.isWellFormed() &&
    !value.includes('\0') &&
    encoder.encode(value).length <= HISTORY_IDENTIFIER_BYTES
  );
}

/**
 * Whether `ms` is a time a record or a query may name: whole milliseconds,
 * so every time has one ISO 8601 form and one place in the order.
 */
export function validHistoryTime(ms) {
  return Number.isInteger(ms) && ms >= 0 && ms <= HISTORY_MAX_TIME_MS;
}

/**
 * Validate one record. Returns `{record}` with a fresh normalised record, or
 * `{reason}` naming the first field that is wrong.
 * @param {object} input
 * @param {{notAfterMs?: number}} [options] - Times later than this are refused.
 */
export function normalizeHistoryRecord(input, { notAfterMs = Infinity } = {}) {
  if (!input || typeof input !== 'object') return { reason: 'malformed' };
  if (!validHistoryIdentifier(input.source)) return { reason: 'source' };
  if (!validHistoryIdentifier(input.key)) return { reason: 'key' };
  const t = input.t;
  if (typeof t !== 'number' || !validHistoryTime(t)) return { reason: 't' };
  if (t > notAfterMs) return { reason: 'future' };
  if (typeof input.lat !== 'number' || !(Math.abs(input.lat) <= 90))
    return { reason: 'lat' };
  if (typeof input.lon !== 'number' || !(Math.abs(input.lon) <= 180))
    return { reason: 'lon' };
  if (!Object.hasOwn(HISTORY_TIME_KINDS, input.timeKind))
    return { reason: 'timeKind' };
  if (!HISTORY_PROVENANCES.includes(input.provenance))
    return { reason: 'provenance' };
  const heightM = optional(input.heightM, Number.isFinite);
  if (heightM === undefined) return { reason: 'heightM' };
  const bearingDeg = optional(input.bearingDeg, (v) => v >= 0 && v < 360);
  if (bearingDeg === undefined) return { reason: 'bearingDeg' };
  const receivedAt = optional(input.receivedAt, validHistoryTime);
  if (receivedAt === undefined) return { reason: 'receivedAt' };
  const flags = input.flags ?? 0;
  if (!Number.isInteger(flags) || flags < 0) return { reason: 'flags' };
  return {
    record: {
      source: input.source,
      key: input.key,
      t: t + 0,
      // -0 becomes 0: a store need not keep the sign of zero.
      lat: input.lat + 0,
      lon: input.lon + 0,
      heightM: heightM + 0,
      bearingDeg: bearingDeg + 0,
      receivedAt: receivedAt + 0,
      timeKind: input.timeKind,
      provenance: input.provenance,
      flags: flags & HISTORY_STORED_FLAGS,
    },
  };
}

/**
 * Validate one coverage interval: the recorder ran for `source` from
 * `fromMs` to `toMs`, both inclusive, for at most a day. Returns
 * `{interval}` or `{reason}`.
 */
export function normalizeHistoryCoverage(
  input,
  { notAfterMs = Infinity } = {},
) {
  if (!input || typeof input !== 'object') return { reason: 'malformed' };
  if (!validHistoryIdentifier(input.source)) return { reason: 'source' };
  if (!validHistoryTime(input.fromMs) || !validHistoryTime(input.toMs))
    return { reason: 'time' };
  if (input.fromMs > input.toMs) return { reason: 'order' };
  if (input.toMs - input.fromMs > HISTORY_COVERAGE_MAX_SPAN_MS)
    return { reason: 'span' };
  if (input.toMs > notAfterMs) return { reason: 'future' };
  return {
    interval: {
      source: input.source,
      fromMs: input.fromMs + 0,
      toMs: input.toMs + 0,
    },
  };
}

/**
 * Sort and join intervals that overlap or lie within `toleranceMs` of each
 * other. Returns new `{fromMs, toMs}` objects.
 */
export function mergeHistoryCoverage(intervals, toleranceMs = 0) {
  const sorted = intervals
    .map(({ fromMs, toMs }) => ({ fromMs, toMs }))
    .sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs);
  const merged = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.fromMs <= last.toMs + toleranceMs)
      last.toMs = Math.max(last.toMs, interval.toMs);
    else merged.push(interval);
  }
  return merged;
}

/** Whether one merged interval holds all of `[fromMs, toMs]`. */
export function historyCovers(merged, fromMs, toMs) {
  return merged.some(
    (interval) => interval.fromMs <= fromMs && interval.toMs >= toMs,
  );
}

/**
 * Compare two strings by their UTF-8 bytes, the order every store returns
 * keys in. JavaScript's `<` compares UTF-16 code units, which puts astral
 * characters before U+E000–U+FFFF; UTF-8 bytes put them after.
 */
export function compareUtf8(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** The store order: time, then key by UTF-8 bytes. */
export function compareHistoryRecords(a, b) {
  return a.t - b.t || compareUtf8(a.key, b.key);
}

/**
 * When the recorder had a record in hand: its receipt time, or its own time
 * when it has none. Coverage is kept on this clock, the recorder's, not on
 * the vehicle's clock that `t` may be on.
 */
const receiptClock = (record) =>
  Number.isFinite(record.receivedAt) ? record.receivedAt : record.t;

/**
 * Turn one contact's records into fixes for `mergeHistory`. Each fix carries
 * its time kind as a flag, and BREAK where the store said so or where the
 * recorder was not running throughout the span between receiving the
 * previous fix and receiving this one, so playback holds the last position
 * through a recorder outage instead of drawing a straight line across it.
 *
 * The span is taken on the receipt clock because coverage is: a feed that
 * reports 30 s late delivers, after a 20 s outage, a fix whose own time
 * falls before the outage, while the fixes from the outage itself were never
 * received.
 * @param {object[]} records - One source, one key, one provenance.
 * @param {{coverage?: {fromMs: number, toMs: number}[], toleranceMs?: number}} [options]
 *   Without coverage every record starts a new segment.
 */
export function historyPlaybackFixes(
  records,
  { coverage = [], toleranceMs = 0 } = {},
) {
  const first = records[0];
  for (const record of records)
    if (
      record.source !== first.source ||
      record.key !== first.key ||
      record.provenance !== first.provenance
    )
      throw new TypeError(
        'Playback fixes need records of one source, key and provenance',
      );
  const merged = mergeHistoryCoverage(coverage, toleranceMs);
  const sorted = [...records].sort((a, b) => a.t - b.t);
  return sorted.map((record, i) => {
    const previous = sorted[i - 1];
    const a = previous && receiptClock(previous),
      b = receiptClock(record);
    const gap =
      previous && !historyCovers(merged, Math.min(a, b), Math.max(a, b));
    return {
      t: record.t,
      lat: record.lat,
      lon: record.lon,
      heightM: record.heightM,
      bearingDeg: record.bearingDeg,
      receivedAt: record.receivedAt,
      flags:
        (record.flags & HISTORY_STORED_FLAGS) |
        HISTORY_TIME_KINDS[record.timeKind] |
        (gap ? FIX_FLAGS.BREAK : 0),
    };
  });
}

/**
 * Export one contact's records as OGC Moving Features JSON 1.0: a
 * FeatureCollection with one Feature per continuous segment, each a linear
 * MovingPoint, split where `historyPlaybackFixes` would put a BREAK. A
 * single-fix segment is a Discrete MovingPoint.
 * @see https://docs.ogc.org/is/19-045r3/19-045r3.html
 */
export function historyMovingFeatures(records, options = {}) {
  if (!records.length) return { type: 'FeatureCollection', features: [] };
  const fixes = historyPlaybackFixes(records, options);
  const { source, key, provenance } = records[0];
  const kinds = new Map(records.map((r) => [r.t, r.timeKind]));
  const segments = [];
  for (const fix of fixes) {
    if (!segments.length || fix.flags & FIX_FLAGS.BREAK) segments.push([]);
    segments.at(-1).push(fix);
  }
  return {
    type: 'FeatureCollection',
    features: segments.map((segment) => {
      const heights = segment.every((f) => Number.isFinite(f.heightM));
      return {
        type: 'Feature',
        id: `${source}/${key}/${segment[0].t}`,
        properties: {
          source,
          key,
          provenance,
          timeKinds: [...new Set(segment.map((f) => kinds.get(f.t)))],
        },
        temporalGeometry: {
          type: 'MovingPoint',
          datetimes: segment.map((f) => new Date(f.t).toISOString()),
          coordinates: segment.map((f) =>
            heights ? [f.lon, f.lat, f.heightM] : [f.lon, f.lat],
          ),
          interpolation: segment.length > 1 ? 'Linear' : 'Discrete',
        },
      };
    }),
  };
}
