import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  defaultBackupFolder,
  inspectHistory,
  listBackups,
  makeBackup,
  stageRestore,
  stamp,
} from './backup.js';
import { openHistoryStore } from './store.js';

const row = (o) => ({ id: 'a', layer: 'air', lat: 1, lon: 2, alt: 0, heading: 0, speed: 0, ts: 1000, ...o });
const scratch = () => mkdtempSync(path.join(tmpdir(), 'gev-backup-'));

test('stamps sort by time and backups go beside the history', () => {
  assert.equal(stamp(new Date(Date.UTC(2026, 10, 17, 9, 5, 3))), '20261117-090503');
  assert.equal(
    defaultBackupFolder(path.join('data', 'history.sqlite')),
    path.join('data', 'backups'),
  );
});

test('a backup holds every position, is listed newest first, and can be restored', () => {
  const dir = scratch();
  try {
    const historyFile = path.join(dir, 'history.sqlite');
    const store = openHistoryStore(historyFile);
    store.insertMany([row({ id: 'a' }), row({ id: 'b', ts: 1010 }), row({ id: 'c', ts: 1020 })]);
    const folder = defaultBackupFolder(historyFile);
    const first = makeBackup({ store, folder, date: new Date(Date.UTC(2026, 0, 1)) });
    const second = makeBackup({ store, folder, date: new Date(Date.UTC(2026, 0, 2)) });
    assert.equal(first.count, 3);
    assert.deepEqual(
      listBackups(folder).map((b) => b.path),
      [second.path, first.path],
    );
    store.insertMany([row({ id: 'd', ts: 1030 })]);
    const staged = stageRestore({
      source: first.path,
      historyFile,
      date: new Date(Date.UTC(2026, 0, 3)),
    });
    assert.equal(staged.count, 3);
    const restored = openHistoryStore(staged.path);
    assert.equal(restored.range().count, 3);
    assert.equal(store.range().count, 4, 'the live file is left as it was');
    restored.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that is not a history is refused and left alone', () => {
  const dir = scratch();
  try {
    const junk = path.join(dir, 'notes.sqlite');
    writeFileSync(junk, 'this is not a database');
    assert.equal(inspectHistory(junk).ok, false);
    assert.throws(
      () => stageRestore({ source: junk, historyFile: path.join(dir, 'history.sqlite') }),
      TypeError,
    );
    assert.equal(inspectHistory(path.join(dir, 'missing.sqlite')).ok, false);
    assert.equal(existsSync(path.join(dir, 'history-restored-x.sqlite')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recording carries on into a restored copy, and the old file stays', async () => {
  const { createRecorder } = await import('./recorder.js');
  const dir = scratch();
  let rec;
  try {
    const historyFile = path.join(dir, 'history.sqlite');
    rec = createRecorder({ file: historyFile, retentionSec: 0 });
    rec.ingestMany([row({ id: 'a' }), row({ id: 'b', ts: 1010 })]);
    await rec.flush();
    const backup = makeBackup({ store: rec.store, folder: defaultBackupFolder(historyFile) });
    rec.ingestMany([row({ id: 'late', ts: 2000 })]);
    await rec.flush();
    const staged = stageRestore({ source: backup.path, historyFile });
    const old = await rec.switchStore(openHistoryStore(staged.path, { createFolder: false }));
    assert.equal(rec.store.range().count, 2, 'the restored history is in use');
    assert.equal(old.range().count, 3, 'what it replaced is intact');
    old.close();
    rec.ingestMany([row({ id: 'after', ts: 3000 })]);
    await rec.flush();
    assert.equal(rec.store.range().count, 3, 'new points go to the restored file');
    assert.ok(existsSync(historyFile));
  } finally {
    await rec?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
