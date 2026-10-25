import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, recorderConfig } from './config.js';
import { exportPoints, summarizeTrack } from './exporters.js';
import { createRecorder } from './recorder.js';

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

test('retention accepts hours, days, weeks and months', () => {
  assert.equal(parseDuration('6h'), 21600);
  assert.equal(parseDuration('14d'), 14 * 86400);
  assert.equal(parseDuration('8w'), 8 * 604800);
  assert.equal(parseDuration('3m'), 3 * 2592000);
  assert.equal(parseDuration('5'), 5 * 86400);
  assert.equal(parseDuration('0'), 0);
  assert.equal(parseDuration(undefined), 7 * 86400);
  assert.throws(() => parseDuration('soon'));
});

test('config reads layers, size cap and interval, with safe defaults', () => {
  const c = recorderConfig({
    GEV_HISTORY_RETENTION: '12h',
    GEV_RECORDER_LAYERS: 'air,bogus,mil',
    GEV_HISTORY_MAX_MB: '50',
    GEV_RECORDER_INTERVAL: '10',
  });
  assert.deepEqual(c.layers, ['air', 'mil']);
  assert.equal(c.retentionSec, 43200);
  assert.equal(c.maxBytes, 50 * 1048576);
  assert.equal(c.intervalSec, 10);
  const d = recorderConfig({});
  assert.equal(d.layers.length, 4);
  assert.equal(d.maxBytes, 0);
  assert.equal(d.intervalSec, 30);
});

test('recorder skips layers it was not asked to record', () => {
  const rec = createRecorder({ file: ':memory:', layers: ['mil'] });
  rec.ingestMany([pt({ layer: 'air' }), pt({ id: 'm', layer: 'mil' })]);
  rec.flush();
  assert.deepEqual(
    rec.store.window({ from: 0, to: 9999 }).map((p) => p.id),
    ['m'],
  );
  rec.close();
});

test('recorder drops the oldest positions when over the size cap', async () => {
  const rec = createRecorder({ file: ':memory:', maxBytes: 1 });
  rec.ingestMany(
    Array.from({ length: 50 }, (_, i) => pt({ id: `c${i}`, ts: 1000 + i })),
  );
  rec.flush();
  await rec.enforceCap();
  assert.ok(rec.store.range().count < 50);
  rec.close();
});

test('track summary reports first, last and gaps', () => {
  const s = summarizeTrack(
    [pt({ ts: 100 }), pt({ ts: 160 }), pt({ ts: 900 })],
    300,
  );
  assert.equal(s.first.ts, 100);
  assert.equal(s.last.ts, 900);
  assert.deepEqual(s.gaps, [{ from: 160, to: 900 }]);
  assert.equal(summarizeTrack([]).first, null);
});

test('exports csv, geojson and gpx', () => {
  const points = [pt({ ts: 100 }), pt({ ts: 200, lat: 11 })];
  const csv = exportPoints(points, 'csv');
  assert.equal(csv.body.split('\n').length, 3);
  assert.match(csv.body, /^ts,id,layer/);
  const geo = JSON.parse(exportPoints(points, 'geojson').body);
  assert.equal(geo.features[0].geometry.coordinates.length, 2);
  const gpx = exportPoints(points, 'gpx').body;
  assert.match(gpx, /<trkpt lat="11" lon="10">/);
  assert.equal(JSON.parse(exportPoints(points, 'json').body).points.length, 2);
});

test('csv neutralises spreadsheet formulas and escapes quotes', () => {
  const body = exportPoints(
    [pt({ id: '=1+1' }), pt({ id: 'a"b,c' })],
    'csv',
  ).body;
  assert.match(body, /,'=1\+1,/);
  assert.match(body, /"a""b,c"/);
});

test('gpx escapes markup in contact ids', () => {
  const gpx = exportPoints([pt({ id: '<x>&' })], 'gpx').body;
  assert.ok(!gpx.includes('<x>'));
});

test('pinned contacts survive retention and the size cap', async () => {
  const rec = createRecorder({ file: ':memory:', maxBytes: 1 });
  rec.store.addPin('keep', 1);
  rec.ingestMany([
    pt({ id: 'keep', ts: 100 }),
    pt({ id: 'drop', ts: 100 }),
    pt({ id: 'drop2', ts: 101 }),
  ]);
  rec.flush();
  rec.store.purgeBefore(5000);
  assert.deepEqual(
    rec.store.window({ from: 0, to: 9999 }).map((p) => p.id),
    ['keep'],
  );
  await rec.enforceCap();
  assert.equal(rec.store.range().count, 1);
  assert.equal(rec.store.removePin('keep'), 1);
  rec.close();
});

test('the settings file supplies defaults and the environment wins', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { loadConfigFile, mergedSettings } = await import('./config.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-cfg-'));
  assert.deepEqual(loadConfigFile(dir, {}), {});
  writeFileSync(
    path.join(dir, 'recorder.config.json'),
    JSON.stringify({
      enabled: true,
      retention: '2w',
      maxMb: 100,
      layers: ['air', 'mil'],
      interval: 20,
      database: '',
      file: 'db/h.sqlite',
    }),
  );
  const fromFile = mergedSettings(dir, {});
  assert.equal(fromFile.GEV_RECORDER, '1');
  assert.equal(fromFile.GEV_HISTORY_RETENTION, '2w');
  assert.equal(fromFile.GEV_RECORDER_LAYERS, 'air,mil');
  assert.equal(fromFile.GEV_HISTORY_FILE, path.join(dir, 'db', 'h.sqlite'));
  assert.ok(!('GEV_HISTORY_DB' in fromFile));
  const both = mergedSettings(dir, {
    GEV_HISTORY_RETENTION: '6h',
    GEV_RECORDER: '0',
  });
  assert.equal(both.GEV_HISTORY_RETENTION, '6h');
  assert.equal(both.GEV_RECORDER, '0');
  assert.equal(recorderConfig(fromFile).retentionSec, 14 * 86400);
  writeFileSync(path.join(dir, 'recorder.config.json'), '{ nope');
  assert.throws(() => loadConfigFile(dir, {}), /Cannot read/);
});
