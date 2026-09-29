import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BFS_MAX_AGE_MS,
  SAFECAST_MAX_AGE_MS,
  compareRadiationReadings,
  normalizeBfsCollection,
  normalizeBfsFeature,
  normalizeSafecastDevice,
  normalizeSafecastDevices,
  radiationBand,
  sanitizeRadiationReadings,
} from './records.js';

const NOW = Date.parse('2026-09-29T21:00:00Z');

function station(props = {}, coordinates = [9.18, 49.45]) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: {
      id: 'DEZ2240',
      kenn: '082250520',
      name: 'Limbach  OT Krumbach',
      site_status: 1,
      site_status_text: 'in Betrieb',
      start_measure: '2026-09-29T19:00:00Z',
      end_measure: '2026-09-29T20:00:00Z',
      value: 0.1484,
      unit: 'µSv/h',
      ...props,
    },
  };
}

function device(props = {}) {
  return {
    device: 2894022651,
    device_urn: 'note:dev:863740067201258',
    loc_lat: 37.357932500001,
    loc_lon: 140.367472656,
    loc_name: 'Kōriyama',
    loc_country: 'jp',
    when_captured: '2026-09-29T20:30:00Z',
    lnd_7318c: 167,
    device_contact_name: 'Private Person',
    device_contact_email: 'someone@example.com',
    ...props,
  };
}

test('a BfS station becomes a µSv/h reading with its hour end as the time', () => {
  assert.deepEqual(normalizeBfsFeature(station(), NOW), {
    id: 'bfs-DEZ2240',
    source: 'bfs',
    name: 'Limbach OT Krumbach',
    country: 'DE',
    lon: 9.18,
    lat: 49.45,
    usvh: 0.148,
    cpm: null,
    atMs: Date.parse('2026-09-29T20:00:00Z'),
  });
});

test('BfS stations out of operation, without a value, stale or malformed are dropped', () => {
  const rejected = [
    station({ site_status: 2, site_status_text: 'defekt' }),
    station({ site_status: 3, site_status_text: 'Testbetrieb' }),
    station({ value: null }),
    station({ value: 0 }),
    station({ value: 5000 }),
    station({ unit: 'nSv/h' }),
    station({ id: 'x' }),
    station({ id: 'DEZ<script>' }),
    station({
      end_measure: new Date(NOW - BFS_MAX_AGE_MS - 1).toISOString(),
    }),
    station({ end_measure: '2026-09-30T20:00:00Z' }),
    station({ end_measure: 'soon' }),
    station({}, [200, 49]),
    station({}, [0, 0]),
    { properties: station().properties, geometry: { type: 'Polygon' } },
  ];
  for (const feature of rejected)
    assert.equal(normalizeBfsFeature(feature, NOW), null);
});

test('a Safecast device is converted at 334 CPM per µSv/h and keeps no contact details', () => {
  const record = normalizeSafecastDevice(device(), NOW);
  assert.deepEqual(record, {
    id: 'safecast-2894022651',
    source: 'safecast',
    name: 'Kōriyama',
    country: 'JP',
    lon: 140.3675,
    lat: 37.3579,
    usvh: 0.5,
    cpm: 167,
    atMs: Date.parse('2026-09-29T20:30:00Z'),
  });
  assert.doesNotMatch(JSON.stringify(record), /contact|example\.com/);
  assert.equal(
    normalizeSafecastDevice(
      device({ lnd_7318c: undefined, lnd_7318u: 40 }),
      NOW,
    ).cpm,
    40,
  );
});

test('Safecast test devices, other tubes, stale, future or malformed records are dropped', () => {
  const rejected = [
    device({ dev_test: true }),
    device({ lnd_7318c: undefined, lnd_712u: 40 }),
    device({ lnd_7318c: undefined, lnd_7128ec: 40 }),
    device({ lnd_7318c: 0 }),
    device({ lnd_7318c: 12.5 }),
    device({ lnd_7318c: 10_000_000 }),
    device({
      when_captured: new Date(NOW - SAFECAST_MAX_AGE_MS - 1).toISOString(),
    }),
    device({ when_captured: '2044-00-00T00:00:00Z' }),
    device({ when_captured: '2027-01-01T00:00:00Z' }),
    device({ device: 'abc' }),
    device({ device: -1 }),
    device({ loc_lat: 95 }),
    device({ loc_lat: 0, loc_lon: 0 }),
    device({ loc_lat: undefined }),
  ];
  for (const entry of rejected)
    assert.equal(normalizeSafecastDevice(entry, NOW), null);
  assert.equal(
    normalizeSafecastDevice(device({ loc_country: 'Japan' }), NOW).country,
    '',
  );
});

test('collections keep one record per station or device, the latest Safecast reading winning', () => {
  assert.equal(normalizeBfsCollection({ features: 'no' }, NOW), null);
  assert.equal(normalizeSafecastDevices({}, NOW), null);
  assert.deepEqual(
    normalizeBfsCollection({ features: [station(), station()] }, NOW).map(
      ({ id }) => id,
    ),
    ['bfs-DEZ2240'],
  );
  const devices = normalizeSafecastDevices(
    [
      device({ when_captured: '2026-09-29T20:30:00Z', lnd_7318c: 40 }),
      device({ when_captured: '2026-09-29T20:40:00Z', lnd_7318c: 50 }),
      device({ when_captured: '2026-09-29T20:10:00Z', lnd_7318c: 60 }),
    ],
    NOW,
  );
  assert.deepEqual(
    devices.map(({ cpm }) => cpm),
    [50],
  );
});

test('bands follow the µSv/h thresholds', () => {
  assert.equal(radiationBand(0.05), 'typical');
  assert.equal(radiationBand(0.2), 'elevated');
  assert.equal(radiationBand(0.499), 'elevated');
  assert.equal(radiationBand(0.5), 'raised');
  assert.equal(radiationBand(1), 'high');
  assert.equal(radiationBand(40), 'high');
});

test('sanitize re-checks proxy rows and orders the highest dose rate first', () => {
  const bfs = normalizeBfsFeature(station(), NOW);
  const safecast = normalizeSafecastDevice(device(), NOW);
  const rows = sanitizeRadiationReadings([
    bfs,
    safecast,
    { ...bfs },
    { ...bfs, id: 'bfs-other', source: 'nope' },
    { ...bfs, id: 'safecast-1' },
    { ...bfs, id: 'bfs-high', usvh: -1 },
    { ...bfs, id: 'bfs-far', lat: 91 },
    { ...bfs, id: 'bfs-time', atMs: 'now' },
    { ...bfs, id: 'bfs-extra', name: '<b>x</b>', country: 'Germany', cpm: 9 },
    null,
  ]);
  assert.deepEqual(
    rows.map(({ id }) => id),
    ['safecast-2894022651', 'bfs-DEZ2240', 'bfs-extra'],
  );
  const extra = rows.find(({ id }) => id === 'bfs-extra');
  assert.equal(extra.country, '');
  assert.equal(extra.cpm, null);
  assert.equal(sanitizeRadiationReadings('no'), null);
  assert.ok(compareRadiationReadings(safecast, bfs) < 0);
});
