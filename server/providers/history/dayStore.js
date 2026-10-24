import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  HISTORY_IDENTIFIER_BYTES,
  HISTORY_PROVENANCES,
  HISTORY_TIME_KINDS,
  compareUtf8,
  mergeHistoryCoverage,
  normalizeHistoryCoverage,
  normalizeHistoryRecord,
  validHistoryTime,
} from '../../../src/data/historyRecords.js';

// A recorded-history store on node:sqlite with one database file per UTC day,
// `YYYY-MM-DD.sqlite`. Retention deletes whole files: dropping a day is a file
// removal, while deleting a day's rows from one large database takes seconds
// and leaves the file its old size. WAL mode, one writer per directory, any
// number of read-only openers (another process may read while a recorder
// writes). Writes are atomic per day file.

const DAY_MS = 86_400_000;
const DAY_FILE = /^(\d{4})-(\d\d)-(\d\d)\.sqlite$/;
const SCHEMA_VERSION = 1;
const TIME_KINDS = Object.keys(HISTORY_TIME_KINDS);
const MAX_LIMIT = 10_000;
const MAX_KEYS = 1_000;
const MAX_STATEMENTS = 64;
/** SQLITE_CORRUPT and SQLITE_NOTADB: the file is damaged or not a database. */
const DAMAGED = new Set([11, 26]);
const damaged = (error) => DAMAGED.has(error?.errcode & 0xff);
const COLUMNS =
  'source, key, t, lat, lon, height_m, bearing_deg, received_at, time_kind, provenance, flags';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fixes (
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  t REAL NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  height_m REAL,
  bearing_deg REAL,
  received_at REAL,
  time_kind INTEGER NOT NULL,
  provenance INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  PRIMARY KEY (source, key, t)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS fixes_by_time ON fixes (source, t, key);
CREATE TABLE IF NOT EXISTS coverage (
  source TEXT NOT NULL,
  from_ms REAL NOT NULL,
  to_ms REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS coverage_by_source ON coverage (source, from_ms);
`;

/** A refused call; `code` is stable, the message is for people. */
export class HistoryStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'HistoryStoreError';
    this.code = code;
  }
}

const dayOf = (ms) => Math.floor(ms / DAY_MS);
const dayName = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
/** The UTC day a `YYYY-MM-DD.sqlite` name stands for, or null. */
function parseDayFile(name) {
  const match = DAY_FILE.exec(name);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const day = ms / DAY_MS;
  return Number.isInteger(day) && dayName(day) === name.slice(0, 10)
    ? day
    : null;
}
const nan = (value) => (Number.isNaN(value) ? null : value);
const number = (value) => (value === null ? NaN : value);

function rowRecord(row) {
  return {
    source: row.source,
    key: row.key,
    t: row.t,
    lat: row.lat,
    lon: row.lon,
    heightM: number(row.height_m),
    bearingDeg: number(row.bearing_deg),
    receivedAt: number(row.received_at),
    timeKind: TIME_KINDS[row.time_kind],
    provenance: HISTORY_PROVENANCES[row.provenance],
    flags: row.flags,
  };
}
const same = (a, b) =>
  Object.is(a.lat, b.lat) &&
  Object.is(a.lon, b.lon) &&
  Object.is(a.heightM, b.heightM) &&
  Object.is(a.bearingDeg, b.bearingDeg) &&
  Object.is(a.receivedAt, b.receivedAt) &&
  a.timeKind === b.timeKind &&
  a.provenance === b.provenance &&
  a.flags === b.flags;

function encodeCursor(record, query) {
  return Buffer.from(
    JSON.stringify({ v: 1, t: record.t, key: record.key, q: query }),
  ).toString('base64url');
}
function decodeCursor(cursor, query) {
  let value;
  try {
    value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString());
  } catch {
    throw new HistoryStoreError('invalid_cursor');
  }
  if (
    value?.v !== 1 ||
    !validHistoryTime(value.t) ||
    typeof value.key !== 'string' ||
    typeof value.q !== 'string'
  )
    throw new HistoryStoreError('invalid_cursor');
  if (value.q !== query)
    throw new HistoryStoreError(
      'cursor_mismatch',
      'The cursor belongs to a different query',
    );
  return value;
}

function validIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.isWellFormed() &&
    Buffer.byteLength(value) <= HISTORY_IDENTIFIER_BYTES
  );
}

/**
 * Open (or, unless read-only, create) a day-partitioned history store.
 * @param {object} options
 * @param {string} options.dir - The directory that holds the day files.
 * @param {boolean} [options.readOnly] - Never create, write or delete.
 * @param {number} [options.retentionDays] - Days kept by `prune`, today included.
 * @param {number} [options.maxBytes] - Size `prune` keeps the files under.
 * @param {number} [options.futureToleranceMs] - How far past `now` a time may be.
 * @param {number} [options.maxOpenDays] - Day databases kept open at once.
 * @param {() => number} [options.now]
 */
export function openHistoryDayStore({
  dir,
  readOnly = false,
  retentionDays = 7,
  maxBytes = Infinity,
  futureToleranceMs = 10_000,
  maxOpenDays = 4,
  now = () => Date.now(),
} = {}) {
  if (typeof dir !== 'string' || !dir)
    throw new TypeError('A history store needs a directory');
  if (!Number.isInteger(retentionDays) || retentionDays < 1)
    throw new RangeError('retentionDays must be a positive integer');
  if (!(maxBytes > 0)) throw new RangeError('maxBytes must be positive');
  if (!Number.isInteger(maxOpenDays) || maxOpenDays < 1)
    throw new RangeError('maxOpenDays must be a positive integer');
  const root = path.resolve(dir);
  if (!readOnly) mkdirSync(root, { recursive: true });
  /** day → {db, statements} for open, readable day databases, LRU order. */
  const open = new Map();
  /** day → reason, for files found damaged after they opened. */
  const broken = new Map();
  let closed = false;

  const fileOf = (day) => path.join(root, `${dayName(day)}.sqlite`);
  function listDays() {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => parseDayFile(entry.name))
      .filter((day) => day !== null)
      .sort((a, b) => a - b);
  }
  function release(day) {
    const entry = open.get(day);
    if (!entry) return;
    open.delete(day);
    try {
      entry.db.close();
    } catch (error) {
      if (!damaged(error)) throw error;
    }
  }
  /**
   * Run `work` on one day's database. Damage found on the way (a corrupt
   * page the open checks did not reach) closes the day and marks it
   * unreadable for the life of this store; any other error is thrown.
   * @returns {boolean} Whether `work` completed.
   */
  function useDay(entry, work) {
    try {
      work();
      return true;
    } catch (error) {
      if (!damaged(error)) throw error;
      release(entry.day);
      broken.set(entry.day, 'corrupt');
      return false;
    }
  }
  /**
   * The open database for one day, `{unreadable: reason}` for a file that is
   * not a day database of this schema, or null for a day with no file.
   */
  function dayDb(day, { create = false } = {}) {
    if (broken.has(day)) return { unreadable: broken.get(day) };
    const cached = open.get(day);
    if (cached) {
      open.delete(day);
      open.set(day, cached);
      return cached;
    }
    const file = fileOf(day);
    let exists = true;
    try {
      statSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      exists = false;
    }
    if (!exists && !create) return null;
    let db;
    try {
      db = new DatabaseSync(file, { readOnly });
      // Wait out another process's write lock instead of failing.
      db.exec('PRAGMA busy_timeout = 5000');
      // A file with no tables (empty, or cut off while being created) is
      // still a new day; any other file must carry this schema.
      const fresh =
        !exists ||
        db.prepare('SELECT count(*) AS n FROM sqlite_master').get().n === 0;
      if (fresh && readOnly) {
        db.close();
        return null;
      }
      if (!fresh) {
        const meta = new Map(
          db
            .prepare('SELECT name, value FROM meta')
            .all()
            .map((row) => [row.name, row.value]),
        );
        // A file renamed to another day would serve the wrong records.
        const reason =
          meta.get('schema_version') !== SCHEMA_VERSION
            ? 'schema'
            : meta.get('day') !== dayName(day)
              ? 'misnamed'
              : null;
        // The writer checks every page of a file it did not create before
        // adding to it; readers find damage as they read.
        const check =
          !reason && !readOnly
            ? db.prepare('PRAGMA quick_check(1)').get()?.quick_check
            : 'ok';
        if (reason || check !== 'ok') {
          db.close();
          return { unreadable: reason ?? 'corrupt' };
        }
      }
      if (!readOnly) db.exec('PRAGMA synchronous = NORMAL');
      if (fresh) {
        // One transaction: each DDL statement alone would sync on its own.
        db.exec('PRAGMA journal_mode = WAL');
        db.exec(`BEGIN; ${SCHEMA}`);
        db.prepare('INSERT INTO meta (name, value) VALUES (?, ?), (?, ?)').run(
          'schema_version',
          SCHEMA_VERSION,
          'day',
          dayName(day),
        );
        db.exec('COMMIT');
      }
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Already closed.
      }
      // A busy or unwritable file is not a damaged one: report it as it is.
      // Another SQLite database, without this schema's tables.
      if (/no such table/.test(error?.message)) return { unreadable: 'schema' };
      // A busy or unwritable file is not a damaged one: report it as it is.
      if (!damaged(error)) throw error;
      return { unreadable: 'corrupt' };
    }
    const entry = { day, db, statements: new Map() };
    open.set(day, entry);
    while (open.size > maxOpenDays) release(open.keys().next().value);
    return entry;
  }
  function statement(entry, sql) {
    let prepared = entry.statements.get(sql);
    if (!prepared) {
      // Key-list lengths vary, so the cache is bounded.
      if (entry.statements.size >= MAX_STATEMENTS) entry.statements.clear();
      prepared = entry.db.prepare(sql);
      entry.statements.set(sql, prepared);
    }
    return prepared;
  }
  function transaction(entry, work) {
    entry.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      entry.db.exec('COMMIT');
    } catch (error) {
      try {
        entry.db.exec('ROLLBACK');
      } catch {
        // A damaged file may refuse even this; the caller handles the error.
      }
      throw error;
    }
  }
  function guard({ write = false } = {}) {
    if (closed) throw new HistoryStoreError('closed');
    if (write && readOnly) throw new HistoryStoreError('read_only');
  }

  /** Write one day's records; counts reach `result` only once committed. */
  function writeRecords(entry, batch, result) {
    const tally = { accepted: 0, repeats: 0, conflicts: 0 };
    const insert = statement(
      entry,
      `INSERT INTO fixes (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    const find = statement(
      entry,
      `SELECT ${COLUMNS} FROM fixes WHERE source = ? AND key = ? AND t = ?`,
    );
    transaction(entry, () => {
      for (const { record } of batch) {
        const changes = insert.run(
          record.source,
          record.key,
          record.t,
          record.lat,
          record.lon,
          nan(record.heightM),
          nan(record.bearingDeg),
          nan(record.receivedAt),
          TIME_KINDS.indexOf(record.timeKind),
          HISTORY_PROVENANCES.indexOf(record.provenance),
          record.flags,
        ).changes;
        if (changes) tally.accepted += 1;
        else if (
          same(rowRecord(find.get(record.source, record.key, record.t)), record)
        )
          tally.repeats += 1;
        else tally.conflicts += 1;
      }
    });
    for (const field of Object.keys(tally)) result[field] += tally[field];
  }
  /** Store one day's piece of an interval, joined with what it touches. */
  function writeCoverage(entry, { source, fromMs, toMs }) {
    const overlapping = statement(
      entry,
      'SELECT rowid, from_ms, to_ms FROM coverage WHERE source = ? AND from_ms <= ? AND to_ms >= ?',
    );
    const remove = statement(entry, 'DELETE FROM coverage WHERE rowid = ?');
    const insert = statement(
      entry,
      'INSERT INTO coverage (source, from_ms, to_ms) VALUES (?, ?, ?)',
    );
    transaction(entry, () => {
      let from = fromMs,
        to = toMs;
      for (const row of overlapping.all(source, toMs, fromMs)) {
        from = Math.min(from, row.from_ms);
        to = Math.max(to, row.to_ms);
        remove.run(row.rowid);
      }
      insert.run(source, from, to);
    });
  }

  function checkQuery({ source, fromMs, toMs }) {
    if (!validIdentifier(source)) throw new HistoryStoreError('invalid_source');
    if (!validHistoryTime(fromMs) || !validHistoryTime(toMs) || fromMs > toMs)
      throw new HistoryStoreError('invalid_range');
  }
  /**
   * Call `visit` with each readable day database from `fromMs` to `toMs`, in
   * day order, opening each only as it is visited (the LRU may close the
   * ones before), until `visit` returns false; later days are still opened to
   * report every unreadable day in the range. Returns those day names.
   */
  function eachDay(fromMs, toMs, visit) {
    const first = dayOf(fromMs),
      last = dayOf(toMs);
    const unreadableDays = [];
    let visiting = true;
    for (const day of listDays()) {
      if (day < first || day > last) continue;
      const entry = dayDb(day);
      if (!entry) continue;
      if (!entry.unreadable && visiting) {
        let more = true;
        if (useDay(entry, () => (more = visit(entry) !== false))) {
          visiting = more;
          continue;
        }
      }
      if (entry.unreadable || broken.has(day))
        unreadableDays.push(dayName(day));
    }
    return unreadableDays;
  }

  const store = {
    dir: root,
    readOnly,
    /**
     * Write records and coverage intervals. Each record lands in the file of
     * its UTC day; one that repeats a stored record exactly is a repeat, one
     * that names a stored (source, key, t) with other values is a conflict,
     * and the stored one stays. Rejected entries are listed by index.
     * @param {{records?: object[], coverage?: object[]}} batch
     */
    write({ records = [], coverage = [] } = {}) {
      guard({ write: true });
      const notAfterMs = now() + futureToleranceMs;
      const result = {
        accepted: 0,
        repeats: 0,
        conflicts: 0,
        rejected: [],
        coverage: { accepted: 0, rejected: [] },
      };
      const byDay = new Map();
      records.forEach((input, index) => {
        const { record, reason } = normalizeHistoryRecord(input, {
          notAfterMs,
        });
        if (!record) return result.rejected.push({ index, reason });
        const day = dayOf(record.t);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push({ index, record });
      });
      for (const [day, batch] of [...byDay].sort((a, b) => a[0] - b[0])) {
        const entry = dayDb(day, { create: true });
        if (
          entry.unreadable ||
          !useDay(entry, () => writeRecords(entry, batch, result))
        )
          for (const { index } of batch)
            result.rejected.push({ index, reason: 'unreadable_day' });
      }
      coverage.forEach((input, index) => {
        const { interval, reason } = normalizeHistoryCoverage(input, {
          notAfterMs,
        });
        if (!interval) return result.coverage.rejected.push({ index, reason });
        const days = [];
        for (let d = dayOf(interval.fromMs); d <= dayOf(interval.toMs); d++)
          days.push(d);
        const refuse = () =>
          result.coverage.rejected.push({ index, reason: 'unreadable_day' });
        // Every day must be writable before any piece is written. Each day
        // is opened again as it is written: the LRU may have closed it.
        if (days.some((day) => dayDb(day, { create: true }).unreadable))
          return refuse();
        for (const day of days) {
          const entry = dayDb(day, { create: true });
          const piece = {
            source: interval.source,
            fromMs: Math.max(interval.fromMs, day * DAY_MS),
            toMs: Math.min(interval.toMs, (day + 1) * DAY_MS),
          };
          if (
            entry.unreadable ||
            !useDay(entry, () => writeCoverage(entry, piece))
          )
            return refuse();
        }
        result.coverage.accepted += 1;
      });
      result.rejected.sort((a, b) => a.index - b.index);
      return result;
    },
    /**
     * One page of records of one source from `fromMs` to `toMs` (both
     * inclusive), ordered by time and then key in UTF-8 byte order. Pass
     * `nextCursor` back with the same query for the next page; it is null on
     * the last page. Only `observed` records unless `provenance` says
     * otherwise. Days whose file cannot be read are named in
     * `unreadableDays`; their records are absent.
     */
    query({
      source,
      keys,
      fromMs,
      toMs,
      provenance = ['observed'],
      limit = 1000,
      cursor,
    } = {}) {
      guard();
      checkQuery({ source, fromMs, toMs });
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
        throw new HistoryStoreError('invalid_limit');
      if (
        !Array.isArray(provenance) ||
        !provenance.length ||
        !provenance.every((p) => HISTORY_PROVENANCES.includes(p))
      )
        throw new HistoryStoreError('invalid_provenance');
      if (
        keys !== undefined &&
        (!Array.isArray(keys) ||
          !keys.length ||
          keys.length > MAX_KEYS ||
          !keys.every(validIdentifier))
      )
        throw new HistoryStoreError('invalid_keys');
      const kinds = [...new Set(provenance)]
        .map((p) => HISTORY_PROVENANCES.indexOf(p))
        .sort();
      const keyList = keys && [...new Set(keys)].sort(compareUtf8);
      const fingerprint = JSON.stringify([
        source,
        fromMs,
        toMs,
        kinds,
        keyList ?? null,
      ]);
      const after = cursor == null ? null : decodeCursor(cursor, fingerprint);
      const sql = [
        `SELECT ${COLUMNS} FROM fixes WHERE source = ? AND t >= ? AND t <= ?`,
        after ? 'AND (t > ? OR (t = ? AND key > ?))' : '',
        `AND provenance IN (${kinds.map(() => '?').join(', ')})`,
        keyList ? `AND key IN (${keyList.map(() => '?').join(', ')})` : '',
        'ORDER BY t, key LIMIT ?',
      ].join(' ');
      const records = [];
      const unreadableDays = eachDay(fromMs, toMs, (entry) => {
        if (after && entry.day < dayOf(after.t)) return true;
        const wanted = limit + 1 - records.length;
        const rows = statement(entry, sql).all(
          source,
          fromMs,
          toMs,
          ...(after ? [after.t, after.t, after.key] : []),
          ...kinds,
          ...(keyList ?? []),
          wanted,
        );
        for (const row of rows) records.push(rowRecord(row));
        return records.length <= limit;
      });
      const more = records.length > limit;
      if (more) records.length = limit;
      return {
        records,
        nextCursor: more ? encodeCursor(records.at(-1), fingerprint) : null,
        unreadableDays,
      };
    },
    /**
     * The merged intervals during which the recorder ran for `source`,
     * clipped to `fromMs`–`toMs`.
     */
    coverage({ source, fromMs, toMs } = {}) {
      guard();
      checkQuery({ source, fromMs, toMs });
      const pieces = [];
      const unreadableDays = eachDay(fromMs, toMs, (entry) => {
        for (const row of statement(
          entry,
          'SELECT from_ms, to_ms FROM coverage WHERE source = ? AND from_ms <= ? AND to_ms >= ?',
        ).all(source, toMs, fromMs))
          pieces.push({
            fromMs: Math.max(fromMs, row.from_ms),
            toMs: Math.min(toMs, row.to_ms),
          });
      });
      return { intervals: mergeHistoryCoverage(pieces), unreadableDays };
    },
    /** Each day file, oldest first, with its size including WAL files. */
    days() {
      guard();
      return listDays().map((day) => ({
        day: dayName(day),
        bytes: ['', '-wal', '-shm'].reduce((sum, suffix) => {
          try {
            return sum + statSync(fileOf(day) + suffix).size;
          } catch (error) {
            if (error.code === 'ENOENT') return sum;
            throw error;
          }
        }, 0),
      }));
    },
    /**
     * Delete day files older than `retentionDays`, then the oldest until the
     * rest fit in `maxBytes`. Today's file is never deleted, and no file but
     * a day file is touched.
     * @returns {{droppedDays: string[], bytes: number, overBudget: boolean}}
     */
    prune() {
      guard({ write: true });
      const today = dayOf(now());
      for (const entry of open.values())
        entry.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const droppedDays = [];
      const drop = (day) => {
        release(day);
        for (const suffix of ['', '-wal', '-shm'])
          try {
            unlinkSync(fileOf(day) + suffix);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        droppedDays.push(dayName(day));
      };
      for (const day of listDays()) if (day <= today - retentionDays) drop(day);
      const files = store.days();
      let bytes = files.reduce((sum, file) => sum + file.bytes, 0);
      for (const file of files) {
        if (bytes <= maxBytes) break;
        const day = parseDayFile(`${file.day}.sqlite`);
        if (day >= today) break;
        drop(day);
        bytes -= file.bytes;
      }
      return { droppedDays, bytes, overBudget: bytes > maxBytes };
    },
    close() {
      if (closed) return;
      for (const day of [...open.keys()]) release(day);
      closed = true;
    },
  };
  return store;
}
