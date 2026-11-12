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

test('a parked contact still gets a point every few minutes', async () => {
  const { createThinner } = await import('./thin.js');
  const keep = createThinner({ minGapSec: 30 });
  const at = (ts) => pt({ ts, lat: 10, lon: 10, heading: 90 });
  assert.equal(keep(at(0)), true);
  assert.equal(keep(at(100)), false);
  assert.equal(keep(at(250)), true, 'heartbeat before replay sees a gap');
});

test('csv keeps negative numbers and neutralises text formulas', () => {
  const out = exportPoints(
    [pt({ id: '-2+3', lat: -33.5, lon: -70.1 }), pt({ id: '=cmd' })],
    'csv',
  ).body;
  assert.match(out, /'-2\+3,air,-33.5,-70.1/);
  assert.match(out, /'=cmd/);
});

test('an area across the antimeridian finds both sides', async () => {
  const { openHistoryStore } = await import('./store.js');
  const store = openHistoryStore(':memory:');
  store.insertMany([
    pt({ id: 'east', lon: 179, ts: 1000 }),
    pt({ id: 'west', lon: -179, ts: 1000 }),
    pt({ id: 'far', lon: 0, ts: 1000 }),
  ]);
  const bbox = { west: 170, south: 0, east: -170, north: 20 };
  const ids = (list) => list.map((p) => p.id).sort();
  assert.deepEqual(ids(store.window({ from: 0, to: 2000, bbox })), [
    'east',
    'west',
  ]);
  assert.deepEqual(ids(store.at({ time: 1500, bbox })), ['east', 'west']);
});

test('the store counts positions per layer', async () => {
  const { openHistoryStore } = await import('./store.js');
  const store = openHistoryStore(':memory:');
  store.insertMany([
    pt({ id: 'a', layer: 'air' }),
    pt({ id: 'b', layer: 'air', ts: 2000 }),
    pt({ id: 'c', layer: 'sat' }),
  ]);
  assert.deepEqual(store.layerCounts(), { air: 2, sat: 1 });
});

test('contacts are found by callsign, ship name or id, best match first', async () => {
  const { openHistoryStore } = await import('./store.js');
  const { aircraftPoints, vesselPoints } = await import('./extract.js');
  const store = openHistoryStore(':memory:');
  const rec = createRecorder({ store, layers: null });
  rec.ingestMany(
    aircraftPoints(
      {
        states: [
          ['a1b2c3', 'UAL123  ', 'US', 5, 0, 8.5, 47.5, 100, false, 200, 270, 0, null, 120],
          ['d4e5f6', 'UAL1234 ', 'US', 5, 0, 9.5, 47.5, 100, false, 200, 270, 0, null, 120],
        ],
      },
      5,
    ),
  );
  rec.ingestMany(
    vesselPoints(
      [
        { mmsi: '366123456', name: 'Ever Given', lat: 1, lon: 2, speed: 3, course: 4 },
        { mmsi: '999', name: 'MMSI 999', lat: 1, lon: 2, speed: 3, course: 4 },
      ],
      5,
    ),
  );
  await rec.flush();
  const first = (q) => store.findContacts(q).map((c) => c.id);
  assert.deepEqual(first('ual123'), ['a1b2c3', 'd4e5f6'], 'exact name before a longer one');
  assert.deepEqual(first('ever'), ['366123456']);
  assert.deepEqual(first('A1B2'), ['a1b2c3'], 'ids are searchable too');
  assert.deepEqual(first('999'), [], 'a placeholder name is not saved');
  assert.deepEqual(first('100%'), [], 'wildcards are plain text');
  assert.deepEqual(first(''), []);
  await rec.close();
});

test('an emergency squawk raises one alert, again only after a quiet spell', async () => {
  const { openHistoryStore } = await import('./store.js');
  const { aircraftPoints, militaryPoints } = await import('./extract.js');
  const store = openHistoryStore(':memory:');
  const rec = createRecorder({ store, layers: null });
  const row = (ts, squawk) => [
    'abc123', 'UAL7', 'US', ts, ts, 8.5, 47.5, 100, false, 200, 270, 0, null, 120, squawk,
  ];
  rec.ingestMany(aircraftPoints({ states: [row(1000, '7700')] }, 1000));
  rec.ingestMany(aircraftPoints({ states: [row(1030, '7700')] }, 1030));
  rec.ingestMany(aircraftPoints({ states: [row(1060, '1200')] }, 1060));
  rec.ingestMany(
    militaryPoints({ ac: [{ hex: 'ae1', lat: 1, lon: 2, flight: 'RCH9', emergency: 'minfuel' }] }, 1070),
  );
  rec.ingestMany(aircraftPoints({ states: [row(1000 + 2000, '7600')] }, 3000));
  rec.ingestMany(aircraftPoints({ states: [row(1000 + 4000, '7700')] }, 5000));
  await rec.flush();
  const found = store.alerts({ since: 0 }).map((a) => `${a.code}:${a.id}:${a.severity}`);
  assert.deepEqual(found.sort(), [
    'general:abc123:emergency',
    'general:abc123:emergency',
    'minfuel:ae1:priority',
    'nordo:abc123:emergency',
  ]);
  assert.equal(store.alerts({ since: 0 })[0].name, 'UAL7');
  await rec.close();
});

test('area events carry the contact name', async () => {
  const { openHistoryStore } = await import('./store.js');
  const store = openHistoryStore(':memory:');
  const rec = createRecorder({ store, layers: null, now: () => 0 });
  await rec.addFence({ name: 'Box', west: 0, south: 0, east: 20, north: 20, layers: [] });
  rec.ingest(pt({ id: 'a', name: 'UAL1', lat: 10, lon: 10, ts: 100 }));
  await rec.flush();
  assert.equal(store.events({})[0].name, 'UAL1');
  await rec.close();
});

test('density counts different contacts per grid square, not saved points', async () => {
  const { openHistoryStore } = await import('./store.js');
  const store = openHistoryStore(':memory:');
  store.insertMany([
    pt({ id: 'a', lat: 10.2, lon: 20.2, ts: 100 }),
    pt({ id: 'a', lat: 10.3, lon: 20.3, ts: 200 }),
    pt({ id: 'b', lat: 10.4, lon: 20.4, ts: 300 }),
    pt({ id: 'c', lat: 40.1, lon: -70.1, ts: 300 }),
    pt({ id: 'd', lat: 10.2, lon: 20.2, ts: 9000 }),
  ]);
  const cells = store.density({ from: 0, to: 1000, cell: 1 });
  // (lon + 180) / 1 and (lat + 90) / 1, truncated.
  assert.deepEqual(
    cells.map((c) => ({ ...c })),
    [
      { gx: 200, gy: 100, n: 2 },
      { gx: 109, gy: 130, n: 1 },
    ],
  );
  assert.deepEqual(
    store.density({ from: 0, to: 1000, cell: 1, layers: ['mil'] }),
    [],
  );
  const west = store.density({
    from: 0,
    to: 1000,
    cell: 1,
    bbox: { west: -80, south: 30, east: -60, north: 50 },
  });
  assert.equal(west.length, 1);
});

test('settings from the panel are checked, applied at once and saved', async () => {
  const { cleanSettings, saveConfigFile, loadConfigFile } = await import('./config.js');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const ok = cleanSettings({ retention: '14d', maxMb: '250', interval: 20, layers: ['air', 'bogus', 'sat'] });
  assert.equal(ok.runtime.retentionSec, 14 * 86400);
  assert.equal(ok.runtime.maxBytes, 250 * 1048576);
  assert.deepEqual(ok.runtime.layers, ['air', 'sat']);
  assert.throws(() => cleanSettings({ retention: 'soon' }));
  assert.throws(() => cleanSettings({ maxMb: -1 }));
  assert.throws(() => cleanSettings({ interval: 0 }));
  assert.throws(() => cleanSettings({ layers: ['bogus'] }));

  const store = (await import('./store.js')).openHistoryStore(':memory:');
  const rec = createRecorder({ store, layers: ['air'], intervalSec: 30 });
  rec.ingest(pt({ id: 'm', layer: 'mil', ts: 100 }));
  rec.configure(ok.runtime);
  assert.deepEqual(rec.settings().layers, ['air', 'sat']);
  assert.equal(rec.settings().intervalSec, 20);
  rec.ingest(pt({ id: 'a', ts: 100 }));
  rec.ingest(pt({ id: 'a', ts: 121, lat: 11 })); // 21 s later: now kept
  await rec.flush();
  assert.equal(store.range().count, 2, 'the mil point came before layers allowed it');
  await rec.close();

  const dir = mkdtempSync(path.join(tmpdir(), 'gev-set-'));
  saveConfigFile(dir, ok.file, {});
  saveConfigFile(dir, { interval: 45 }, {});
  const saved = JSON.parse(readFileSync(path.join(dir, 'recorder.config.json'), 'utf8'));
  assert.equal(saved.retention, '14d');
  assert.equal(saved.interval, 45, 'a later save keeps earlier values');
  assert.equal(loadConfigFile(dir, {}).GEV_HISTORY_RETENTION, '14d');
});

test('thinning keeps one point per contact per bucket, spares pins and can preview', async () => {
  const { openHistoryStore } = await import('./store.js');
  const store = openHistoryStore(':memory:');
  const rows = [];
  for (let t = 0; t < 600; t += 10) {
    rows.push(pt({ id: 'a', ts: t }), pt({ id: 'b', ts: t }), pt({ id: 'keep', ts: t }));
  }
  rows.push(pt({ id: 'a', ts: 5000 }));
  store.insertMany(rows);
  store.addPin('keep', 1);
  const before = store.range().count;
  const preview = store.thinOld({ before: 1000, bucket: 60, dryRun: true });
  assert.equal(store.range().count, before, 'a preview deletes nothing');
  const done = store.thinOld({ before: 1000, bucket: 60 });
  assert.equal(done.removed, preview.removed);
  // a and b: 600 s in 60 s buckets leaves 10 each; the recent point and the pinned contact stay.
  assert.equal(store.track('a', 0, 9999).length, 11);
  assert.equal(store.track('b', 0, 9999).length, 10);
  assert.equal(store.track('keep', 0, 9999).length, 60);
});

test('feed monitor tells ok, empty, failing and idle apart, and logs only changes', async () => {
  const { createFeedMonitor } = await import('./feeds.js');
  const { openHistoryStore } = await import('./store.js');
  const monitor = createFeedMonitor();
  const log = [];
  const see = (layer, status, count, ts) => {
    const change = monitor.observe(layer, { status, count, ts });
    if (change) log.push(change);
  };
  see('air', 200, 50, 1000); // a good start is not news
  see('air', 200, 40, 1030);
  see('air', 429, 0, 1060);
  see('air', 429, 0, 1090); // still failing: no new entry
  see('air', 200, 0, 1120);
  see('air', 200, 10, 1150);
  assert.deepEqual(
    log.map((e) => `${e.state}${e.detail ? `:${e.detail}` : ''}`),
    ['failing:429', 'empty', 'ok'],
  );
  assert.deepEqual(monitor.tick(1200).length, 0, 'asked a minute ago');
  const idle = monitor.tick(1150 + 301);
  assert.deepEqual(idle.map((e) => e.state), ['idle']);
  assert.equal(monitor.tick(1150 + 900).length, 0, 'idle is logged once');
  const [air, sea] = monitor.snapshot(['air', 'vessel'], 2200);
  assert.equal(air.state, 'idle');
  assert.equal(sea.state, 'unseen');
  see('air', 200, 3, 2300);
  assert.equal(log.at(-1).state, 'ok', 'back from idle');

  const store = openHistoryStore(':memory:');
  store.addFeedEvents(log);
  const events = store.feedEvents({ layer: 'air', from: 1100, to: 1200 });
  assert.deepEqual(events.map((e) => e.state), ['failing', 'empty', 'ok'], 'led by the one in force at the start');
});
