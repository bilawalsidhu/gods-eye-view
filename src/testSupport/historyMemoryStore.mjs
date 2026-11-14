import {
  HISTORY_PROVENANCES,
  compareHistoryRecords,
  compareUtf8,
  mergeHistoryCoverage,
  normalizeHistoryCoverage,
  normalizeHistoryRecord,
  validHistoryTime,
} from '../data/historyRecords.js';

/**
 * The reference history store: the record contract kept in plain arrays,
 * written for obviousness rather than speed. The conformance suite runs on it
 * as well as on real stores, and the differential tests compare a real store
 * with it after random operations.
 */
const DAY_MS = 86_400_000;
const dayOf = (ms) => Math.floor(ms / DAY_MS);
const dayName = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

class HistoryReferenceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function createMemoryHistoryStore({
  retentionDays = 7,
  futureToleranceMs = 10_000,
  now = () => Date.now(),
} = {}) {
  let records = [];
  let coverage = [];
  const fail = (code) => {
    throw new HistoryReferenceError(code);
  };
  const identifier = (value) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.isWellFormed() &&
    !value.includes('\0') &&
    Buffer.byteLength(value) <= 256;
  const checkRange = ({ source, fromMs, toMs }) => {
    if (!identifier(source)) fail('invalid_source');
    if (!validHistoryTime(fromMs) || !validHistoryTime(toMs) || fromMs > toMs)
      fail('invalid_range');
  };
  return {
    write({ records: inputs = [], coverage: intervals = [] } = {}) {
      const notAfterMs = now() + futureToleranceMs;
      const result = {
        accepted: 0,
        repeats: 0,
        conflicts: 0,
        rejected: [],
        coverage: { accepted: 0, rejected: [] },
      };
      inputs.forEach((input, index) => {
        const { record, reason } = normalizeHistoryRecord(input, {
          notAfterMs,
        });
        if (!record) return result.rejected.push({ index, reason });
        const stored = records.find(
          (r) =>
            r.source === record.source &&
            r.key === record.key &&
            r.t === record.t,
        );
        if (!stored) {
          records.push(record);
          result.accepted += 1;
        } else if (JSON.stringify(stored) === JSON.stringify(record))
          // Both are normalised: same field order, NaN as null, no -0.
          result.repeats += 1;
        else result.conflicts += 1;
      });
      intervals.forEach((input, index) => {
        const { interval, reason } = normalizeHistoryCoverage(input, {
          notAfterMs,
        });
        if (!interval) return result.coverage.rejected.push({ index, reason });
        coverage.push(interval);
        result.coverage.accepted += 1;
      });
      return result;
    },
    query({
      source,
      keys,
      fromMs,
      toMs,
      provenance = ['observed'],
      limit = 1000,
      cursor,
    } = {}) {
      checkRange({ source, fromMs, toMs });
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
        fail('invalid_limit');
      if (
        !Array.isArray(provenance) ||
        !provenance.length ||
        !provenance.every((p) => HISTORY_PROVENANCES.includes(p))
      )
        fail('invalid_provenance');
      if (
        keys !== undefined &&
        (!Array.isArray(keys) ||
          !keys.length ||
          keys.length > 1000 ||
          !keys.every(identifier))
      )
        fail('invalid_keys');
      const query = JSON.stringify([
        source,
        fromMs,
        toMs,
        [...new Set(provenance)].sort(),
        keys ? [...new Set(keys)].sort(compareUtf8) : null,
      ]);
      let after = null;
      if (cursor != null) {
        try {
          after = JSON.parse(cursor);
        } catch {
          fail('invalid_cursor');
        }
        if (typeof after?.q !== 'string') fail('invalid_cursor');
        if (after.q !== query) fail('cursor_mismatch');
      }
      const matching = records
        .filter(
          (r) =>
            r.source === source &&
            r.t >= fromMs &&
            r.t <= toMs &&
            provenance.includes(r.provenance) &&
            (!keys || keys.includes(r.key)) &&
            (!after || compareHistoryRecords(r, after) > 0),
        )
        .sort(compareHistoryRecords);
      const page = matching.slice(0, limit).map((r) => ({ ...r }));
      const last = page.at(-1);
      return {
        records: page,
        nextCursor:
          matching.length > limit
            ? JSON.stringify({ t: last.t, key: last.key, q: query })
            : null,
        unreadableDays: [],
      };
    },
    coverage({ source, fromMs, toMs } = {}) {
      checkRange({ source, fromMs, toMs });
      return {
        intervals: mergeHistoryCoverage(
          coverage
            .filter(
              (c) =>
                c.source === source && c.fromMs <= toMs && c.toMs >= fromMs,
            )
            .map((c) => ({
              fromMs: Math.max(fromMs, c.fromMs),
              toMs: Math.min(toMs, c.toMs),
            })),
        ),
        unreadableDays: [],
      };
    },
    /** Retention only: the reference has no files and no byte size. */
    prune() {
      const cutoff = (dayOf(now()) - retentionDays + 1) * DAY_MS;
      const days = new Set([
        ...records.map((r) => dayOf(r.t)),
        ...coverage.flatMap((c) => {
          const out = [];
          for (let d = dayOf(c.fromMs); d <= dayOf(c.toMs); d++) out.push(d);
          return out;
        }),
      ]);
      const droppedDays = [...days]
        .filter((d) => d * DAY_MS < cutoff)
        .sort((a, b) => a - b)
        .map(dayName);
      records = records.filter((r) => r.t >= cutoff);
      coverage = coverage
        .filter((c) => c.toMs >= cutoff)
        .map((c) => ({ ...c, fromMs: Math.max(c.fromMs, cutoff) }));
      return { droppedDays };
    },
    close() {},
  };
}
