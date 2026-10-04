import assert from 'node:assert/strict';
import test from 'node:test';
import { twoline2satrec } from 'satellite.js';
import { composeCatalog, coreTools } from '../index.js';
import {
  noradIdFromSatnum,
  parseTleText,
  tleCatalogNumber,
} from '../../sources/tle.js';

// Element sets published for 1 January 2024.
const TLE = `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00016717  00000-0  30270-3 0  9994
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579432414
CSS (TIANHE)
1 48274U 21035A   24001.50000000  .00020137  00000-0  24481-3 0  9993
2 48274  41.4697 175.8913 0005643 312.8370 141.6893 15.61287398150000
`;
const CLOCK = { now: () => Date.UTC(2024, 0, 1, 12) };
const satellites = (text = TLE, ok = true) => ({
  calls: [],
  async readGroup(group) {
    this.calls.push(group);
    return { ok, status: ok ? 200 : 503, text };
  },
});

test('TLE text parses into named entries with catalog numbers', () => {
  const entries = parseTleText(`${TLE}\nBROKEN\nnot a line\nnor this\n`);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['ISS (ZARYA)', 'CSS (TIANHE)'],
  );
  assert.equal(tleCatalogNumber(entries[0].line1), 25544);
  assert.equal(tleCatalogNumber('1 xx'), null);
});

test('Alpha-5 catalog numbers decode, skipping I and O', () => {
  for (const [field, id] of [
    ['A0000', 100000],
    ['A0404', 100404],
    ['H9999', 179999],
    ['J0000', 180000],
    ['N9999', 229999],
    ['P0000', 230000],
    ['T0449', 270449],
    ['Z9999', 339999],
  ]) {
    assert.equal(noradIdFromSatnum(field), id, field);
    assert.equal(tleCatalogNumber(`1 ${field}U`), id, field);
  }
});

test('every other catalog field reads as it did before', () => {
  assert.equal(noradIdFromSatnum('25544'), 25544);
  assert.equal(noradIdFromSatnum('00404'), 404);
  assert.equal(noradIdFromSatnum(''), 0); // as Number('') did
  for (const field of ['I0000', 'O0000', 'a0404', 'A00']) {
    assert.ok(Number.isNaN(noradIdFromSatnum(field)), field);
    assert.equal(tleCatalogNumber(`1 ${field}U`), null, field);
  }
});

test('a satellite numbered above 99999 keeps its number and is found by it', async () => {
  // The ISS set with its catalog field in Alpha-5: A0000 is 100000.
  const text = TLE.replaceAll('25544', 'A0000');
  const [iss] = parseTleText(text);
  const { satnum } = twoline2satrec(iss.line1, iss.line2);
  assert.ok(Number.isNaN(Number(satnum))); // what the catalog builders used
  assert.equal(noradIdFromSatnum(satnum), 100000);
  const catalog = composeCatalog({
    tools: coreTools,
    services: { satellites: satellites(text), clock: CLOCK },
  });
  const result = await catalog.call('next_satellite_pass', {
    location: { lat: 40.7, lon: -74 },
    satellite: '100000',
  });
  assert.equal(result.data.satellite, 'ISS (ZARYA)');
  assert.equal(result.data.norad, 100000);
});

test('the next pass defaults to the ISS and reports times, peak and direction', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { satellites: satellites(), clock: CLOCK },
  });
  const result = await catalog.call('next_satellite_pass', {
    location: { lat: 40.7, lon: -74 },
  });
  const { pass } = result.data;
  assert.equal(result.data.satellite, 'ISS (ZARYA)');
  assert.equal(result.data.norad, 25544);
  assert.ok(Date.parse(pass.rise) >= CLOCK.now());
  assert.ok(Date.parse(pass.rise) < Date.parse(pass.peak));
  assert.ok(Date.parse(pass.peak) < Date.parse(pass.set));
  assert.ok(pass.max_elevation_deg >= 10 && pass.max_elevation_deg <= 90);
  assert.match(pass.rise_direction, /^[NESW]{1,3}$/);
  assert.match(
    result.summary,
    new RegExp(
      `^ISS \\(ZARYA\\) next rises over 40.7000, -74.0000 at ${pass.rise} in the ${pass.rise_direction}, peaking at \\d+°`,
    ),
  );
});

test('satellites are matched by name or catalog number within the group', async () => {
  const source = satellites();
  const catalog = composeCatalog({
    tools: coreTools,
    services: { satellites: source, clock: CLOCK },
  });
  const byName = await catalog.call('next_satellite_pass', {
    location: { lat: 0, lon: 0 },
    satellite: 'tianhe',
  });
  assert.equal(byName.data.norad, 48274);
  const byNumber = await catalog.call('next_satellite_pass', {
    location: { lat: 0, lon: 0 },
    satellite: '48274',
    group: 'visual',
  });
  assert.equal(byNumber.data.satellite, 'CSS (TIANHE)');
  assert.deepEqual(source.calls, ['stations', 'visual']);
  await assert.rejects(
    catalog.call('next_satellite_pass', {
      location: { lat: 0, lon: 0 },
      satellite: 'Hubble',
    }),
    /No satellite matching "Hubble" is in the stations group/,
  );
  await assert.rejects(
    catalog.call('next_satellite_pass', {
      location: { lat: 0, lon: 0 },
      group: 'weather',
    }),
    /must be one of/,
  );
});

test('a pass that never comes is a normal answer, and catalog failures are unavailable', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { satellites: satellites(), clock: CLOCK },
  });
  // The ISS orbit is inclined 51.6°, so it never rises 10° above the pole.
  const none = await catalog.call('next_satellite_pass', {
    location: { lat: 89.9, lon: 0 },
    hours: 6,
  });
  assert.equal(none.data.pass, null);
  assert.equal(
    none.summary,
    'ISS (ZARYA) has no pass over 89.9000, 0.0000 in the next 6 hours.',
  );
  const down = composeCatalog({
    tools: coreTools,
    services: { satellites: satellites('', false), clock: CLOCK },
  });
  await assert.rejects(
    down.call('next_satellite_pass', { location: { lat: 0, lon: 0 } }),
    (error) => error.code === 'unavailable' && /HTTP 503/.test(error.message),
  );
});

test('satellites overhead are those above the elevation, highest first', async () => {
  const source = satellites();
  const services = { satellites: source, clock: CLOCK };
  const catalog = composeCatalog({ tools: coreTools, services });
  const pass = (
    await catalog.call('next_satellite_pass', {
      location: { lat: 40.7, lon: -74 },
    })
  ).data.pass;
  const atPeak = {
    satellites: source,
    clock: { now: () => Date.parse(pass.peak) },
  };
  const overhead = await composeCatalog({
    tools: coreTools,
    services: atPeak,
  }).call('satellites_overhead', {
    location: { lat: 40.7, lon: -74 },
  });
  assert.equal(overhead.data.rows[0].name, 'ISS (ZARYA)');
  assert.ok(
    Math.abs(overhead.data.rows[0].elevation_deg - pass.max_elevation_deg) < 1,
  );
  assert.equal(overhead.data.at, pass.peak);
  const strict = await composeCatalog({
    tools: coreTools,
    services: atPeak,
  }).call('satellites_overhead', {
    location: { lat: 40.7, lon: -74 },
    min_elevation_deg: 90,
  });
  assert.equal(strict.data.total, 0);
  assert.match(
    strict.summary,
    /^0 satellites from the stations group are at least 90° above/,
  );
});

test('stale orbit and launch data are reported', async () => {
  const stale = {
    readGroup: async () => ({ ok: true, status: 200, text: TLE, stale: true }),
  };
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      satellites: stale,
      clock: CLOCK,
      launches: {
        getLaunchSnapshot: async () => ({ payload: [], stale: true }),
      },
    },
  });
  const overhead = await catalog.call('satellites_overhead', {
    location: { lat: 0, lon: 0 },
  });
  assert.equal(overhead.data.stale, true);
  assert.match(overhead.summary, /\(orbit data may be stale\)\.$/);
  const launches = await catalog.call('get_recent_launches', {});
  assert.equal(launches.data.stale, true);
  assert.match(launches.summary, /\(data may be stale\)\.$/);
});

test('satellite and launch sources read the proxies stale markers', async () => {
  const { createSatelliteSource } =
    await import('../../layers/satellites/source.js');
  const { createLaunchSource } =
    await import('../../layers/launches/source.js');
  const satellites = createSatelliteSource({
    fetchImpl: async () =>
      new Response(TLE, { headers: { 'x-tle-cache': 'STALE-ERROR' } }),
  });
  assert.equal((await satellites.readGroup('stations')).stale, true);
  const launches = createLaunchSource({
    fetchImpl: async () =>
      Response.json([], { headers: { 'X-GEV-Cache': 'STALE-ERROR' } }),
  });
  assert.deepEqual(await launches.getLaunchSnapshot(), {
    payload: [],
    stale: true,
  });
  const { getLaunches } = launches;
  assert.deepEqual(await getLaunches(), []);
});
