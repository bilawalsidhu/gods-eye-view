import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptFireHistoryRecords,
  buildEventTimeline,
  detectionPixelSize,
  eventCenter,
  eventProgress,
  fireHistoryRowControls,
  mapAnalystRecord,
  progressCss,
  progressRgb,
  selectEvent,
} from './model.js';

const EVENT = {
  id: 'camp-fire-2018',
  name: 'Camp Fire',
  region: 'Butte County',
  startDate: '2018-11-08',
  endDate: '2018-11-09',
  bbox: [-121.75, 39.65, -121.3, 39.95],
};

test('eventProgress spans the inclusive day range from public date fields', () => {
  assert.equal(eventProgress(Date.UTC(2018, 10, 8), EVENT), 0);
  assert.equal(eventProgress(Date.UTC(2018, 10, 9), EVENT), 0.5);
  assert.equal(eventProgress(Date.UTC(2018, 10, 10), EVENT), 1);
  assert.equal(eventProgress(Date.UTC(2018, 10, 20), EVENT), 1);
  assert.equal(eventProgress(NaN, EVENT), 0);
  assert.equal(eventProgress(0, { startDate: 'x', endDate: 'y' }), 0);
});

test('progress ramp runs yellow → ember and clamps', () => {
  assert.deepEqual(progressRgb(0), [255, 228, 92]);
  assert.deepEqual(progressRgb(1), [107, 20, 20]);
  assert.deepEqual(progressRgb(5), [107, 20, 20]);
  assert.deepEqual(progressRgb(-1), [255, 228, 92]);
  assert.deepEqual(progressRgb(0.35), [255, 138, 31]);
  assert.equal(progressCss(0.35), 'rgb(255, 138, 31)');
});

test('detectionPixelSize grows with FRP and sensor footprint', () => {
  assert.equal(detectionPixelSize(null, 'VIIRS'), 4);
  assert.equal(detectionPixelSize(0, 'MODIS'), 6);
  assert.ok(detectionPixelSize(150, 'VIIRS') > detectionPixelSize(5, 'VIIRS'));
  assert.ok(detectionPixelSize(1e9, 'VIIRS') <= 9);
});

test('adaptFireHistoryRecords sorts by time, drops timeless rows and stamps progress', () => {
  const fires = adaptFireHistoryRecords(
    [
      {
        lat: 39.8,
        lon: -121.5,
        frp: 12,
        confidence: 'n',
        acqDate: '2018-11-09',
        acqTime: '1200',
        instrument: 'VIIRS',
      },
      {
        lat: 39.81,
        lon: -121.51,
        frp: 3,
        confidence: 'h',
        acqDate: '2018-11-08',
        acqTime: '45',
        instrument: 'MODIS',
      },
      { lat: 39.82, lon: -121.52, frp: 3, acqDate: 'bad', acqTime: '0' },
      { lat: 'x', lon: -121.52, frp: 3, acqDate: '2018-11-08', acqTime: '0' },
    ],
    EVENT,
  );
  assert.equal(fires.length, 2);
  assert.deepEqual(
    fires.map((f) => f.index),
    [0, 1],
  );
  assert.equal(fires[0].sensor, 'MODIS');
  assert.equal(fires[0].acqMs, Date.UTC(2018, 10, 8, 0, 45));
  assert.equal(fires[1].progress, 0.75);
});

test('buildEventTimeline emits every UTC day of the range', () => {
  const timeline = buildEventTimeline(
    [
      { acqMs: Date.UTC(2018, 10, 8, 3), frp: 10 },
      { acqMs: Date.UTC(2018, 10, 8, 14), frp: 40 },
      { acqMs: Date.UTC(2018, 10, 9, 1), frp: null },
      { acqMs: Date.UTC(2018, 10, 12, 1), frp: 99 },
    ],
    EVENT,
  );
  assert.deepEqual(timeline, [
    { date: '2018-11-08', count: 2, maxFrp: 40 },
    { date: '2018-11-09', count: 1, maxFrp: 0 },
  ]);
  assert.deepEqual(buildEventTimeline([], { startDate: 'x' }), []);
});

test('selectEvent prefers the requested id and falls back to the first', () => {
  const events = [{ id: 'a' }, { id: 'b' }];
  assert.equal(selectEvent(events, 'b'), events[1]);
  assert.equal(selectEvent(events, 'zzz'), events[0]);
  assert.equal(selectEvent([], 'a'), null);
});

test('eventCenter is the box midpoint', () => {
  assert.deepEqual(eventCenter([-122, 39, -120, 41]), { lon: -121, lat: 40 });
});

test('fireHistoryRowControls builds one chip per event and a three-band legend', () => {
  const controls = fireHistoryRowControls({
    events: [EVENT, { ...EVENT, id: 'other', name: 'Other', startDate: '2024-01-01', endDate: '2024-01-02', region: '' }],
    selectedId: 'other',
    loading: true,
    fires: [{ progress: 0.1 }, { progress: 0.5 }, { progress: 0.9 }, { progress: 1 }],
  });
  assert.equal(controls.chips.length, 2);
  assert.equal(controls.chips[0].label, 'Camp Fire · 2018');
  assert.equal(controls.chips[0].active, false);
  assert.equal(controls.chips[1].active, true);
  assert.equal(controls.chips[1].busy, true);
  assert.match(controls.chips[0].title, /Butte County/);
  assert.doesNotMatch(controls.chips[1].title, /^ ·/);
  assert.deepEqual(controls.chips[0].params, { eventId: 'camp-fire-2018' });
  assert.equal(controls.chips[0].onClick, undefined);
  assert.deepEqual(
    controls.legend.map((item) => [item.label, item.count]),
    [
      ['Early', 1],
      ['Mid', 1],
      ['Late', 2],
    ],
  );
  assert.equal(
    fireHistoryRowControls({ events: [], selectedId: null, loading: false, fires: [], onSelect() {} })
      .legend.length,
    0,
  );
});

test('mapAnalystRecord is JSON-safe with nulls for unknowns', () => {
  const record = mapAnalystRecord(
    { index: 7, lat: 1, lon: 2, acqMs: 3, progress: 0.4, frp: NaN, confidence: 0.6, sensor: 'VIIRS' },
    EVENT,
  );
  assert.deepEqual(record, {
    id: 'camp-fire-2018-00007',
    eventId: 'camp-fire-2018',
    eventName: 'Camp Fire',
    lat: 1,
    lon: 2,
    timeMs: 3,
    progress: 0.4,
    frpMw: null,
    confidence: 0.6,
    sensor: 'VIIRS',
    satellite: null,
  });
});

test('compactCount folds thousands for the row readout', async () => {
  const { compactCount } = await import('./model.js');
  assert.equal(compactCount(0), '0');
  assert.equal(compactCount(999), '999');
  assert.equal(compactCount(1200), '1.2K');
  assert.equal(compactCount(5000), '5K');
  assert.equal(compactCount(15919), '16K');
  assert.equal(compactCount(2_500_000), '2.5M');
});

test('perimeterRings flattens polygons, closes rings and drops junk', async () => {
  const { perimeterRings, perimeterText } = await import('./model.js');
  const rings = perimeterRings({
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [1, 0], [1, 1]], [[0.2, 0.2], [0.3, 0.2], [0.3, 0.3], [0.2, 0.2]]],
      [[[5, 5], ['x', 5], [6, 6]]],
      [[[7, 7], [200, 7], [8, 8], [7, 7]]],
    ],
  });
  assert.equal(rings.length, 2);
  assert.deepEqual(rings[0][rings[0].length - 1], [0, 0], 'open ring is closed');
  assert.equal(rings[0].length, 4);
  assert.equal(rings[1].length, 4);
  assert.deepEqual(perimeterRings({ type: 'Point', coordinates: [0, 0] }), []);
  assert.deepEqual(perimeterRings(null), []);
  assert.equal(
    perimeterText({ hectares: 62053, label: 'NIFC Interagency Fire Perimeter History', dateCurrentMs: null }),
    '62,053 HA · NIFC Interagency Fire Perimeter History',
  );
  assert.equal(
    perimeterText({ hectares: 859, label: 'WFIGS Interagency Perimeters', dateCurrentMs: 1694128641000 }),
    '859 HA · WFIGS Interagency Perimeters · AS OF 2023-09-07',
  );
  assert.equal(perimeterText(null), 'NO OFFICIAL PERIMETER REGISTERED');
  assert.match(perimeterText({ hectares: null, label: 'X', dateCurrentMs: null }), /^AREA UNAVAILABLE/);
});
