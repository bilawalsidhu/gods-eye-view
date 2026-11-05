import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkFolder,
  historyFileIn,
  listDrives,
  mountName,
} from './location.js';
import { createRecorder } from './recorder.js';
import { createUnavailableStore, openHistoryStore } from './store.js';

const temp = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gev-drive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const pt = (o) => ({
  id: 'a',
  layer: 'air',
  lat: 10,
  lon: 10,
  alt: 100,
  heading: 90,
  speed: 100,
  ts: 1000,
  ...o,
});

test('a folder is checked before recording goes there', (t) => {
  const dir = temp(t);
  assert.equal(checkFolder('relative/folder').ok, false, 'a full path is needed');
  assert.equal(checkFolder('').ok, false);
  const missingDrive = path.join(dir, 'no-such-drive', 'GEV History');
  const refused = checkFolder(missingDrive);
  assert.equal(refused.ok, false, 'a missing parent means the drive is not there');
  assert.equal(existsSync(path.join(dir, 'no-such-drive')), false, 'nothing was created');
  const ok = checkFolder(path.join(dir, 'GEV History'));
  assert.equal(ok.ok, true);
  assert.ok(existsSync(ok.path), 'one new folder level is made');
  assert.ok(ok.freeBytes > 0);
  const file = path.join(dir, 'a-file');
  writeFileSync(file, 'x');
  assert.equal(checkFolder(file).ok, false, 'a file is not a folder');
});

test('drives are listed with space, and the main one is marked', () => {
  const drives = listDrives({ mainDir: process.cwd() });
  assert.ok(drives.length >= 1);
  for (const d of drives) {
    assert.ok(d.freeBytes >= 0 && d.totalBytes > 0);
    assert.equal(typeof d.main, 'boolean');
    assert.ok(path.isAbsolute(d.path));
  }
  assert.equal(drives.filter((d) => d.main).length >= 1, true);
});

test('history is copied to a new file in one step, and a missing folder is not created', (t) => {
  const dir = temp(t);
  const source = openHistoryStore(path.join(dir, 'old', 'history.sqlite'));
  source.insertMany([pt({ ts: 1 }), pt({ ts: 2 }), pt({ id: 'b', ts: 3 })]);
  source.addPin('a', 1);
  const target = historyFileIn(path.join(dir, 'GEV History'));
  assert.throws(
    () => openHistoryStore(target, { createFolder: false }),
    /Folder not found/,
    'the folder of an unplugged drive is not made on the main disk',
  );
  checkFolder(path.join(dir, 'GEV History'));
  source.copyTo(target);
  const copy = openHistoryStore(target, { createFolder: false });
  assert.equal(copy.range().count, 3);
  assert.deepEqual(copy.listPins().map((p) => p.id), ['a']);
  assert.throws(() => source.copyTo(target), 'an existing file is never overwritten');
  copy.close();
  source.close();
});

test('an unavailable store answers reads with nothing and refuses writes', () => {
  const store = createUnavailableStore('Folder not found: E:\\GEV History');
  assert.equal(store.range().count, 0);
  assert.deepEqual(store.listFences(), []);
  assert.deepEqual(store.layerCounts(), {});
  assert.throws(() => store.insertMany([pt({})]), /Folder not found/);
  store.close();
});

test('recording keeps points while the drive is gone and opens it again when it is back', async (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'history.sqlite');
  let driveBack = false;
  let reopened = 0;
  const rec = createRecorder({
    store: createUnavailableStore('Folder not found'),
    reopen: async () => {
      reopened += 1;
      if (!driveBack) throw new Error('still gone');
      return openHistoryStore(file, { createFolder: false });
    },
  });
  rec.ingest(pt({ id: 'a', ts: 100 }));
  await assert.rejects(rec.flush());
  assert.equal(rec.health().ok, false);
  assert.equal(rec.health().waiting, 1, 'the point is kept, not dropped');
  driveBack = true;
  // The recorder's own timer retries; here the swap is made by hand as it would be.
  const next = openHistoryStore(file, { createFolder: false });
  await rec.switchStore(next);
  await rec.flush();
  assert.equal(rec.health().ok, true);
  assert.equal(rec.health().waiting, 0);
  assert.equal(rec.store.range().count, 1, 'what waited was written to the new place');
  await rec.close();
});

test('a volume is named by its mount folder on Mac and Linux', () => {
  assert.equal(mountName('/Volumes/Backup/GEV History', 'darwin'), 'Backup');
  assert.equal(mountName('/media/stu/USB DRIVE/x', 'linux'), 'USB DRIVE');
  assert.equal(mountName('/run/media/stu/Backup', 'linux'), 'Backup');
  assert.equal(mountName('/mnt/data/GEV History', 'linux'), 'data');
  assert.equal(mountName('/home/stu/history', 'linux'), null);
  assert.equal(mountName('/Users/stu/history', 'darwin'), null);
});
