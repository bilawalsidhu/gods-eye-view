import test from 'node:test';
import assert from 'node:assert/strict';
import { riverLevelsProxy } from './index.js';
import {
  normalizePegelonline,
  normalizePegelonlineSeries,
} from './pegelonline.js';
import { normalizeWraReadings, normalizeWraRegister } from './wra.js';
import { twd97ToWgs84 } from './twd97.js';
import {
  ECCC_MAX_PAGES,
  ECCC_PAGE_SIZE,
  buildEcccStations,
  ecccReferences,
  ecccRiverName,
  normalizeEcccReadings,
  normalizeEcccRegister,
  normalizeEcccStats,
} from './eccc.js';
import { normalizeRwsCatalogue, normalizeRwsLatest } from './rws.js';

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
  assert.equal(gauge.river, 'Huang River');
  assert.equal(gauge.riverNative, '磺溪');
  assert.equal(gauge.band, 'normal');
  const [flooding] = normalizeWraReadings(register, [wraReading('6.02')]);
  assert.equal(flooding.band, 'flood');
});

/** A proxy over canned upstream answers; `answers` maps URL tests to bodies. */
function harness(answers, start = Date.parse('2026-11-04T21:00:00Z')) {
  let clock = start;
  const calls = [];
  const inits = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    inits.push([url, init]);
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
    inits,
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

const ECCC_REGISTER = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: { type: 'Point', coordinates: [-110.67754, 50.04209] },
      properties: {
        STATION_NUMBER: '05AJ001',
        STATION_NAME: 'SOUTH SASKATCHEWAN RIVER AT MEDICINE HAT',
        PROV_TERR_STATE_LOC: 'AB',
      },
    },
    {
      geometry: { type: 'Point', coordinates: [-114.40054, 49.60185] },
      properties: {
        STATION_NUMBER: '05AA030',
        STATION_NAME: 'GOLD CREEK NEAR FRANK',
        PROV_TERR_STATE_LOC: 'AB',
      },
    },
    { geometry: null, properties: { STATION_NUMBER: '05AA031' } },
    {
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { STATION_NUMBER: 'bad' },
    },
  ],
};

/** Yearly daily extremes at Medicine Hat; Frank has too few years. */
const ECCC_STATS = {
  features: [
    ...[0, 1, 2, 3, 4, 5].map((i) => ({
      properties: {
        STATION_NUMBER: '05AJ001',
        MIN_VALUE: 1.8 + i * 0.04,
        MAX_VALUE: 5.2 + i * 0.1,
      },
    })),
    {
      properties: {
        STATION_NUMBER: '05AJ001',
        MIN_VALUE: null,
        MAX_VALUE: null,
      },
    },
    {
      properties: { STATION_NUMBER: '05AA030', MIN_VALUE: 0.9, MAX_VALUE: 1.6 },
    },
  ],
};

const ecccReading = (code, at, level) => ({
  properties: { STATION_NUMBER: code, DATETIME: at, LEVEL: level },
});

test('ECCC names, statistics and readings become referenced Canadian gauges', () => {
  const register = normalizeEcccRegister(ECCC_REGISTER.features);
  assert.deepEqual([...register.keys()], ['05AJ001', '05AA030']);
  assert.equal(
    register.get('05AJ001').name,
    'South Saskatchewan River at Medicine Hat',
  );
  assert.equal(register.get('05AJ001').river, 'South Saskatchewan River');
  assert.equal(register.get('05AA030').river, 'Gold Creek');
  assert.equal(
    ecccRiverName('RIVIERE CHAUDIERE A SAINT-LAMBERT'),
    'Riviere Chaudiere',
  );

  const stats = normalizeEcccStats(ECCC_STATS.features);
  assert.deepEqual([...stats.keys()], ['05AJ001']);
  assert.equal(stats.get('05AJ001').low, 1.9);
  assert.equal(stats.get('05AJ001').high, 5.45);

  const readings = normalizeEcccReadings([
    ecccReading('05AJ001', '2026-11-05T12:55:00Z', 2.205),
    ecccReading('05AJ001', '2026-11-05T12:00:00Z', 2.25),
    ecccReading('05AJ001', '2026-11-05T13:00:00Z', null),
    ecccReading('05AA030', '2026-11-05T12:55:00Z', 1.119),
    ecccReading('99ZZ999', '2026-11-05T12:55:00Z', 1),
  ]);
  assert.deepEqual(readings.get('05AJ001'), [
    [Date.parse('2026-11-05T12:00:00Z'), 2.25],
    [Date.parse('2026-11-05T12:55:00Z'), 2.205],
  ]);
  const [hat, frank] = buildEcccStations(register, stats, readings);
  assert.equal(hat.id, 'eccc:05AJ001');
  assert.equal(hat.level, 2.205);
  assert.deepEqual(hat.refs, { low: 1.9, high: 5.45 });
  assert.equal(hat.band, 'normal');
  assert.equal(frank.band, 'unknown');
  assert.deepEqual(frank.refs, {});

  // Over its mean yearly high a gauge is on watch, never in flood.
  const over = buildEcccStations(
    register,
    stats,
    new Map([['05AJ001', [[Date.parse('2026-11-05T12:55:00Z'), 7]]]]),
  );
  assert.equal(over[0].band, 'watch');
  // A reading on another datum (535 m against a 2-6 m archive) gets none.
  assert.deepEqual(ecccReferences(535, stats.get('05AJ001')), {});
});

test('the Canadian network pages GeoMet, trends at once and serves a series', async () => {
  const h = harness([
    [/hydrometric-stations/, ECCC_REGISTER],
    [/hydrometric-annual-statistics/, ECCC_STATS],
    [
      /hydrometric-realtime.*STATION_NUMBER=05AJ001/,
      {
        features: [
          { properties: { DATETIME: '2026-11-04T19:00:00Z', LEVEL: 2.3 } },
          { properties: { DATETIME: '2026-11-04T20:55:00Z', LEVEL: 2.2 } },
        ],
      },
    ],
    [
      /hydrometric-realtime/,
      {
        features: [
          ecccReading('05AJ001', '2026-11-04T19:55:00Z', 2.3),
          ecccReading('05AJ001', '2026-11-04T20:55:00Z', 2.2),
        ],
      },
    ],
  ]);
  const answer = await h.call('/');
  assert.equal(answer.status, 200);
  assert.equal(answer.body.providers.eccc.count, 1);
  const hat = answer.body.stations.find((s) => s.provider === 'eccc');
  assert.equal(hat.band, 'normal');
  // 10 cm down in an hour, from the window's own readings.
  assert.equal(hat.trend, -10);
  const realtime = h.calls.find((url) => /hydrometric-realtime/.test(url));
  assert.match(realtime, /datetime=2026-11-04T19%3A30%3A00Z%2F\.\./);
  assert.match(realtime, /offset=0/);

  const series = await h.call('/station/eccc/05AJ001');
  assert.equal(series.status, 200);
  assert.equal(series.body.partial, false);
  assert.equal(series.body.points.length, 2);
  assert.equal(series.body.trend, -10);
  assert.equal((await h.call('/station/eccc/99ZZ999')).status, 404);
  assert.equal((await h.call('/station/eccc/05aj001')).status, 404);
});

test('a GeoMet page loop stops at the page cap', async () => {
  const full = {
    features: Array.from({ length: ECCC_PAGE_SIZE }, () =>
      ecccReading('05AJ001', '2026-11-04T20:55:00Z', 2.2),
    ),
  };
  const h = harness([
    [/hydrometric-stations/, ECCC_REGISTER],
    [/hydrometric-annual-statistics/, ECCC_STATS],
    [/hydrometric-realtime/, full],
  ]);
  const answer = await h.call('/');
  assert.equal(answer.status, 502);
  assert.equal(
    h.calls.filter((url) => /hydrometric-realtime/.test(url)).length,
    ECCC_MAX_PAGES,
  );
});

const RWS_HEIGHT = {
  Compartiment: { Code: 'OW' },
  Grootheid: { Code: 'WATHTE' },
  Hoedanigheid: { Code: 'NAP' },
  ProcesType: 'meting',
};

const RWS_CATALOGUE = {
  Succesvol: true,
  AquoMetadataLijst: [
    { AquoMetadata_MessageID: 294, ...RWS_HEIGHT },
    {
      AquoMetadata_MessageID: 292,
      ...RWS_HEIGHT,
      ProcesType: 'astronomisch',
    },
    {
      AquoMetadata_MessageID: 1,
      ...RWS_HEIGHT,
      Grootheid: { Code: 'Hm0' },
    },
  ],
  AquoMetadataLocatieLijst: [
    { AquoMetaData_MessageID: 294, Locatie_MessageID: 10 },
    { AquoMetaData_MessageID: 294, Locatie_MessageID: 11 },
    { AquoMetaData_MessageID: 292, Locatie_MessageID: 11 },
    { AquoMetaData_MessageID: 1, Locatie_MessageID: 12 },
    { AquoMetaData_MessageID: 294, Locatie_MessageID: 13 },
  ],
  LocatieLijst: [
    {
      Locatie_MessageID: 10,
      Code: 'lobith.bovenrijn.tolkamer',
      Lat: 51.8495,
      Lon: 6.1024,
      Naam: 'Lobith, Bovenrijn, Tolkamer',
    },
    // Tidal: also publishes an astronomical tide.
    {
      Locatie_MessageID: 11,
      Code: 'vlissingen',
      Lat: 51.44,
      Lon: 3.6,
      Naam: 'Vlissingen',
    },
    // Waves only.
    { Locatie_MessageID: 12, Code: 'k13a', Lat: 53.2, Lon: 3.2, Naam: 'K13a' },
    // Outside the Netherlands.
    { Locatie_MessageID: 13, Code: 'faraway', Lat: 10, Lon: 10, Naam: 'X' },
  ],
};

const rwsSeries = (code, readings, metadata = RWS_HEIGHT) => ({
  AquoMetadata: metadata,
  Locatie: { Code: code },
  MetingenLijst: readings.map(([Tijdstip, value]) => ({
    Tijdstip,
    Meetwaarde: { Waarde_Numeriek: value },
  })),
});

test('the Rijkswaterstaat catalogue keeps non-tidal water height locations', () => {
  const register = normalizeRwsCatalogue(RWS_CATALOGUE);
  assert.deepEqual([...register.keys()], ['lobith.bovenrijn.tolkamer']);
  assert.equal(
    register.get('lobith.bovenrijn.tolkamer').name,
    'Lobith, Bovenrijn, Tolkamer',
  );
  assert.throws(() => normalizeRwsCatalogue({}), /invalid_catalogue/);
});

test('Dutch readings: newest series wins, centimetres become metres, sentinels drop', () => {
  const register = normalizeRwsCatalogue(RWS_CATALOGUE);
  const now = Date.parse('2026-11-05T14:00:00Z');
  const stations = normalizeRwsLatest(
    register,
    {
      WaarnemingenLijst: [
        // An archived method's last value, decades old.
        rwsSeries('lobith.bovenrijn.tolkamer', [
          ['1987-06-28T23:00:00.000+01:00', 1342],
        ]),
        rwsSeries('lobith.bovenrijn.tolkamer', [
          ['2026-11-05T14:40:00.000+01:00', 640],
        ]),
        rwsSeries('lobith.bovenrijn.tolkamer', [
          ['2026-11-05T14:50:00.000+01:00', 999999999],
        ]),
        rwsSeries('vlissingen', [['2026-11-05T14:40:00.000+01:00', 120]]),
      ],
    },
    now,
  );
  assert.equal(stations.length, 1);
  const [lobith] = stations;
  assert.equal(lobith.id, 'rws:lobith.bovenrijn.tolkamer');
  assert.equal(lobith.level, 6.4);
  assert.equal(lobith.observedMs, Date.parse('2026-11-05T13:40:00Z'));
  assert.equal(lobith.band, 'unknown');
  assert.deepEqual(lobith.refs, {});
});

test('the Dutch network is asked in parallel batches and serves a series', async () => {
  const many = {
    ...RWS_CATALOGUE,
    AquoMetadataLocatieLijst: [
      ...RWS_CATALOGUE.AquoMetadataLocatieLijst,
      ...Array.from({ length: 200 }, (_, i) => ({
        AquoMetaData_MessageID: 294,
        Locatie_MessageID: 100 + i,
      })),
    ],
    LocatieLijst: [
      ...RWS_CATALOGUE.LocatieLijst,
      ...Array.from({ length: 200 }, (_, i) => ({
        Locatie_MessageID: 100 + i,
        Code: `meetpunt.${i}`,
        Lat: 52,
        Lon: 5,
        Naam: `Meetpunt ${i}`,
      })),
    ],
  };
  const bodies = [];
  const h = harness([
    [/OphalenCatalogus/, many],
    [
      /OphalenLaatsteWaarnemingen/,
      () => ({
        WaarnemingenLijst: [
          rwsSeries('lobith.bovenrijn.tolkamer', [
            ['2026-11-04T21:40:00.000+01:00', 640],
          ]),
        ],
      }),
    ],
    [
      /OphalenWaarnemingen$/,
      {
        WaarnemingenLijst: [
          rwsSeries('lobith.bovenrijn.tolkamer', [
            ['2026-11-04T20:40:00.000+01:00', 650],
            ['2026-11-04T21:40:00.000+01:00', 640],
          ]),
        ],
      },
    ],
  ]);
  const answer = await h.call('/');
  assert.equal(answer.status, 200);
  assert.equal(answer.body.providers.rws.count, 1);
  // 201 locations in batches of 150: two requests, each a POST.
  const latest = h.inits.filter(([url]) =>
    /OphalenLaatsteWaarnemingen/.test(url),
  );
  assert.equal(latest.length, 2);
  for (const [, init] of latest) {
    assert.equal(init.method, 'POST');
    bodies.push(JSON.parse(init.body).LocatieLijst.length);
  }
  assert.deepEqual(bodies.sort(), [150, 51]);

  const series = await h.call('/station/rws/lobith.bovenrijn.tolkamer');
  assert.equal(series.status, 200);
  assert.equal(series.body.points.length, 2);
  assert.equal(series.body.trend, -10);
  assert.equal((await h.call('/station/rws/vlissingen')).status, 404);
  assert.equal((await h.call('/station/rws/..%2F..')).status, 404);
});
