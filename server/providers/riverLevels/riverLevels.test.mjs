import test from 'node:test';
import assert from 'node:assert/strict';
import { riverLevelsProxy } from './index.js';
import {
  normalizePegelonline,
  normalizePegelonlineSeries,
} from './pegelonline.js';
import { normalizeWraReadings, normalizeWraRegister } from './wra.js';
import { twd97ToWgs84 } from './twd97.js';

const BONN_UUID = '593647aa-9fea-43ec-a7d6-6476a76ae868';

/** A trimmed PEGELONLINE row: Bonn on 2026-11-04 at its lowest level ever. */
function pegelRow(value, timestamp = '2026-11-04T21:45:00+01:00') {
  return {
    uuid: BONN_UUID,
    number: '2710080',
    shortname: 'BONN',
    longname: 'BONN',
    latitude: 50.736398,
    longitude: 7.108045,
    water: { shortname: 'RHEIN', longname: 'RHEIN' },
    timeseries: [
      {
        shortname: 'W',
        unit: 'cm',
        currentMeasurement: { timestamp, value, stateMnwMhw: 'low' },
        characteristicValues: [
          { shortname: 'HHW', unit: 'cm', value: 1013 },
          { shortname: 'NNW', unit: 'cm', value: 81 },
          { shortname: 'MNW', unit: 'cm', value: 121 },
          { shortname: 'MW', unit: 'cm', value: 290 },
          { shortname: 'MHW', unit: 'cm', value: 680 },
          { shortname: 'GlW', unit: 'cm', value: 142 },
        ],
      },
    ],
  };
}

const WRA_REGISTER = [
  {
    basinidentifier: '1010H006',
    observationstatus: '現存',
    observatoryname: '新磺溪橋(即時)',
    englishname: 'Xinshuxi Bridge',
    rivername: '磺溪',
    englishrivername: 'Huang River',
    locationbytwd97_xy: '313411.44 2790930.63',
    alertlevel1: '5.8',
    alertlevel2: '4.6',
    alertlevel3: '',
  },
  {
    basinidentifier: '1010H001',
    observationstatus: '已廢',
    englishname: 'CHIN-SHAN',
    locationbytwd97_xy: '310928.30 2790168.45',
  },
  {
    basinidentifier: '9999H999',
    observationstatus: '現存',
    englishname: 'Nowhere',
    locationbytwd97_xy: '0 0',
  },
];

const wraReading = (
  waterlevel,
  datetime = '2026-11-05T04:40:00',
  extra = {},
) => ({
  stationid: '1010H006',
  checkresult: 'true',
  observatoryidentifier: '1010H006_API',
  datetime,
  waterlevel,
  ...extra,
});

test('TWD97 TM2 metres convert to WGS84 degrees', () => {
  const { lat, lon } = twd97ToWgs84(313411.44, 2790930.63);
  assert.ok(Math.abs(lat - 25.2257) < 0.001);
  assert.ok(Math.abs(lon - 121.6294) < 0.001);
  assert.equal(twd97ToWgs84(Number.NaN, 1), null);
});

test('PEGELONLINE rows carry level and references in metres', () => {
  const [bonn] = normalizePegelonline([pegelRow(81)]);
  assert.equal(bonn.id, `pegelonline:${BONN_UUID}`);
  assert.equal(bonn.name, 'Bonn');
  assert.equal(bonn.river, 'Rhein');
  assert.equal(bonn.level, 0.81);
  assert.deepEqual(bonn.refs, {
    recordLow: 0.81,
    low: 1.21,
    mean: 2.9,
    high: 6.8,
    recordHigh: 10.13,
  });
  assert.equal(bonn.band, 'record-low');
  assert.equal(bonn.observedMs, Date.parse('2026-11-04T20:45:00Z'));
});

test('PEGELONLINE alert stages (Meldestufen) map to watch, warning, flood', () => {
  const row = pegelRow(560);
  row.timeseries[0].characteristicValues.push(
    { shortname: 'M_I', unit: 'cm', value: 450 },
    { shortname: 'M_II', unit: 'cm', value: 550 },
    { shortname: 'M_III', unit: 'cm', value: 650 },
  );
  const [gauge] = normalizePegelonline([row]);
  assert.equal(gauge.band, 'warning');
});

test('PEGELONLINE rows without a usable level or position are dropped', () => {
  const noValue = pegelRow(null);
  const noPosition = { ...pegelRow(100), latitude: undefined };
  const metres = pegelRow(100);
  metres.timeseries[0].unit = 'm';
  assert.deepEqual(normalizePegelonline([noValue, noPosition, metres]), []);
  assert.throws(() => normalizePegelonline({}), /invalid_snapshot/);
});

test('a PEGELONLINE series is sorted metres over time', () => {
  assert.deepEqual(
    normalizePegelonlineSeries([
      { timestamp: '2026-11-04T21:00:00+01:00', value: 82 },
      { timestamp: '2026-11-04T20:45:00+01:00', value: 83 },
      { timestamp: 'nope', value: 1 },
    ]),
    [
      [Date.parse('2026-11-04T19:45:00Z'), 0.83],
      [Date.parse('2026-11-04T20:00:00Z'), 0.82],
    ],
  );
});

test('WRA keeps in-service gauges inside Taiwan with their alert levels', () => {
  const register = normalizeWraRegister(WRA_REGISTER);
  assert.deepEqual([...register.keys()], ['1010H006']);
  assert.deepEqual(register.get('1010H006').refs, { warning: 4.6, flood: 5.8 });
});

test('WRA readings join the register, in Taiwan time, newest per gauge', () => {
  const register = normalizeWraRegister(WRA_REGISTER);
  const stations = normalizeWraReadings(register, [
    wraReading('1.89'),
    wraReading('1.70', '2026-11-05T04:30:00'),
    wraReading('9.99', '2026-11-05T04:50:00', { checkresult: 'false' }),
    wraReading('-99'),
    { ...wraReading('3'), stationid: '1010H001' },
  ]);
  assert.equal(stations.length, 1);
  const [gauge] = stations;
  assert.equal(gauge.id, 'wra:1010H006');
  assert.equal(gauge.level, 1.89);
  assert.equal(gauge.observedMs, Date.parse('2026-11-04T20:40:00Z'));
  assert.equal(gauge.nativeName, '新磺溪橋(即時)');
  assert.equal(gauge.band, 'normal');
  const [flooding] = normalizeWraReadings(register, [wraReading('6.02')]);
  assert.equal(flooding.band, 'flood');
});

/** A proxy over canned upstream answers; `answers` maps URL tests to bodies. */
function harness(answers, start = Date.parse('2026-11-04T21:00:00Z')) {
  let clock = start;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [pattern, body] of answers) {
      if (pattern.test(url)) {
        const value = typeof body === 'function' ? body() : body;
        if (value instanceof Error) throw value;
        return new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('{}', { status: 404 });
  };
  const plugin = riverLevelsProxy({ fetchImpl, now: () => clock });
  let handler;
  plugin.configureServer({ middlewares: { use: (_path, h) => (handler = h) } });
  const call = (url) =>
    new Promise((resolve) => {
      const req = {
        url,
        method: 'GET',
        headers: { host: 'localhost' },
        socket: { remoteAddress: '127.0.0.1' },
      };
      const res = {
        destroyed: false,
        writeHead(status) {
          this.status = status;
        },
        setHeader() {},
        end(body) {
          resolve({ status: this.status, body: JSON.parse(body) });
        },
      };
      handler(req, res);
    });
  return {
    call,
    calls,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('the snapshot merges both networks and adds a trend after two polls', async () => {
  let bonnValue = 81;
  let bonnTime = '2026-11-04T21:45:00+01:00';
  let wraLevel = '1.89';
  let wraTime = '2026-11-05T04:40:00';
  const h = harness([
    [/pegelonline.*stations\.json/, () => [pegelRow(bonnValue, bonnTime)]],
    [/c4acc691/, WRA_REGISTER],
    [/73c4c3de/, () => [wraReading(wraLevel, wraTime)]],
  ]);
  const first = await h.call('/');
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.stations.map((s) => [s.id, s.band, s.trend]),
    [
      [`pegelonline:${BONN_UUID}`, 'record-low', null],
      ['wra:1010H006', 'normal', null],
    ],
  );
  assert.deepEqual(first.body.providers.wra, {
    count: 1,
    stale: false,
    available: true,
  });

  // Inside the cache window nothing is fetched again.
  const before = h.calls.length;
  await h.call('/');
  assert.equal(h.calls.length, before);

  h.advance(60 * 60_000);
  bonnValue = 79;
  bonnTime = '2026-11-04T22:45:00+01:00';
  wraLevel = '2.39';
  wraTime = '2026-11-05T05:40:00';
  const second = await h.call('/');
  const byId = Object.fromEntries(second.body.stations.map((s) => [s.id, s]));
  assert.equal(byId[`pegelonline:${BONN_UUID}`].trend, -2);
  assert.equal(byId[`pegelonline:${BONN_UUID}`].level, 0.79);
  assert.equal(byId['wra:1010H006'].trend, 50);
});

test('a network that fails keeps its last readings, marked stale', async () => {
  let failing = false;
  const h = harness([
    [
      /pegelonline.*stations\.json/,
      () => (failing ? new Error('down') : [pegelRow(81)]),
    ],
    [/c4acc691/, WRA_REGISTER],
    [/73c4c3de/, () => [wraReading('1.89')]],
  ]);
  await h.call('/');
  failing = true;
  h.advance(11 * 60_000);
  const stale = await h.call('/');
  assert.equal(stale.status, 200);
  assert.equal(stale.body.providers.pegelonline.stale, true);
  assert.equal(stale.body.stations.length, 2);
  // Past six hours the old readings are dropped rather than shown as current.
  h.advance(7 * 60 * 60_000);
  const later = await h.call('/');
  assert.equal(later.body.providers.pegelonline.available, false);
  assert.deepEqual(
    later.body.stations.map((s) => s.provider),
    ['wra'],
  );
});

test('with every network down the route answers 502', async () => {
  const h = harness([[/./, () => new Error('down')]]);
  const answer = await h.call('/');
  assert.equal(answer.status, 502);
  assert.deepEqual(answer.body, { error: 'river_levels_unavailable' });
});

test('station series: PEGELONLINE upstream, Taiwan from memory, bad ids refused', async () => {
  const h = harness([
    [/pegelonline.*stations\.json/, [pegelRow(81)]],
    [
      /pegelonline.*measurements\.json\?start=P3D$/,
      [
        { timestamp: '2026-11-04T20:45:00+01:00', value: 83 },
        { timestamp: '2026-11-04T21:45:00+01:00', value: 81 },
      ],
    ],
    [/c4acc691/, WRA_REGISTER],
    [/73c4c3de/, [wraReading('1.89')]],
  ]);
  await h.call('/');
  const bonn = await h.call(`/station/pegelonline/${BONN_UUID}`);
  assert.equal(bonn.status, 200);
  assert.equal(bonn.body.partial, false);
  assert.deepEqual(bonn.body.points.at(-1), [
    Date.parse('2026-11-04T20:45:00Z'),
    0.81,
  ]);
  // The 72 h series gives Bonn a trend at once, and in the next snapshot.
  assert.equal(bonn.body.trend, -2);
  h.advance(11 * 60_000);
  const next = await h.call('/');
  assert.equal(next.body.stations[0].trend, -2);

  const taiwan = await h.call('/station/wra/1010H006');
  assert.equal(taiwan.body.partial, true);
  assert.equal(taiwan.body.points.length, 1);
  assert.equal(taiwan.body.trend, null);

  assert.equal((await h.call('/station/wra/0000H000')).status, 404);
  assert.equal((await h.call('/station/pegelonline/../../etc')).status, 404);
  assert.equal((await h.call('/station/other/1')).status, 404);
  assert.ok(h.calls.every((url) => url.startsWith('https://')));
});
