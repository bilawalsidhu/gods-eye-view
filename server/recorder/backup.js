/**
 * @module recorder/backup
 * @description Whole-database backups of the SQLite history, and restoring one.
 * A backup is a complete copy made while recording (SQLite's VACUUM INTO), so
 * it opens as a history on its own. A restore never overwrites the live file:
 * the backup is copied beside it under a new name and recording switches to
 * that copy, so the file it replaced is still there.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PREFIX = 'gev-history-backup-';
const EXT = '.sqlite';

const pad = (n) => String(n).padStart(2, '0');

/** "20261117-093005" in UTC, so names sort by time. */
export function stamp(date = new Date()) {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** Backups go in a "backups" folder beside the history file unless told otherwise. */
export const defaultBackupFolder = (historyFile) =>
  path.join(path.dirname(historyFile), 'backups');

/** The backups in a folder, newest first: [{ name, path, bytes, modified }]. */
export function listBackups(folder, limit = 20) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.startsWith(PREFIX) && name.endsWith(EXT))
    .map((name) => {
      const full = path.join(folder, name);
      const info = statSync(full);
      return { name, path: full, bytes: info.size, modified: info.mtimeMs };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1))
    .slice(0, limit);
}

/**
 * Whether a file is a history database: opened read-only, so a file that is
 * not one (or is damaged) is refused without being changed.
 * @returns {{ok: true, count: number} | {ok: false, error: string}}
 */
export function inspectHistory(file) {
  if (!existsSync(file) || !statSync(file).isFile())
    return { ok: false, error: 'That file was not found' };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const has = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='positions'",
      )
      .get();
    if (!has)
      return { ok: false, error: 'That file is not a recorded history' };
    return {
      ok: true,
      count: Number(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n),
    };
  } catch {
    return { ok: false, error: 'That file is not a readable history database' };
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing to close.
    }
  }
}

/**
 * Copies the history into `folder` and checks the copy holds every position.
 * `store` is the live SQLite store, already flushed.
 */
export function makeBackup({ store, folder, date = new Date() }) {
  mkdirSync(folder, { recursive: true });
  const target = path.join(folder, `${PREFIX}${stamp(date)}${EXT}`);
  if (existsSync(target))
    throw new Error('A backup with that time already exists');
  const expected = store.range().count;
  store.copyTo(target);
  const check = inspectHistory(target);
  if (!check.ok || check.count < expected)
    throw new Error('The backup came out incomplete and was not kept');
  return { path: target, count: check.count, bytes: statSync(target).size };
}

/**
 * Copies a backup beside the live history under a new name, ready to switch
 * to. Returns its path. The source must be a history database.
 */
export function stageRestore({ source, historyFile, date = new Date() }) {
  const check = inspectHistory(source);
  if (!check.ok) throw new TypeError(check.error);
  const target = path.join(
    path.dirname(historyFile),
    `history-restored-${stamp(date)}${EXT}`,
  );
  if (existsSync(target))
    throw new Error('A restore with that time already exists');
  copyFileSync(source, target);
  return { path: target, count: check.count };
}
