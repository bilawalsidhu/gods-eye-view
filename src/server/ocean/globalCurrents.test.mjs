import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TARGET_CELLS,
  GLOBAL_CURRENTS_AXES,
  GLOBAL_CURRENTS_DATASET,
  GLOBAL_CURRENTS_USER_AGENT,
  RESPONSE_BYTE_CAP,
  buildGlobalCurrentsUrl,
  chooseStride,
  fetchGlobalCurrents,
  latestTimeIso,
  longitudeIndexRanges,
  parseGlobalCurrentsCsv0,
  stitchGlobalCurrents,
  wrapLon180,
} from './globalCurrents.js';

const TIME = '2026-08-29T00:00:00Z';

/** Axis coordinates of a fetched segment: n samples from `min`, spacing `step`. */
function axisFrom(min, n, step) {
  return Array.from({ length: n }, (_, k) => min + k * step);
}

/**
 * Headerless griddap `.csv0` body: `time,lat,lon,u,v`, row-major with latitude
 * outer and longitude inner, exactly as CoastWatch emits it.
 */
function csv0({ lats, lons, u, v, timeIso = TIME }) {
  const lines = [];
  for (let i = 0; i < lats.length; i += 1) {
    for (let j = 0; j < lons.length; j += 1) {
      lines.push([timeIso, lats[i], lons[j], u(i, j), v(i, j)].join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Body for one segment of a `chooseStride` plan. */
function segmentCsv0(segment, stride, u, v, timeIso = TIME) {
  const step = stride * GLOBAL_CURRENTS_AXES.latStep;
  return csv0({
    lats: axisFrom(segment.latMin, segment.nLat, step),
    lons: axisFrom(segment.lonMin, segment.nLon, step),
    u,
    v,
    timeIso,
  });
}

/** Fetch double: `routes` maps a URL substring to a body string or a response. */
function fakeFetch(routes, log = []) {
  return async (url) => {
    log.push(url);
    for (const [needle, value] of routes) {
      if (!url.includes(needle)) continue;
      if (typeof value === 'string') {
        return { ok: true, status: 200, text: async () => value };
      }
      return value;
    }
    return { ok: false, status: 404, text: async () => 'Error { code=404; }' };
  };
}

const TIME_PROBE = 'time%5B(last)%5D';

test('dataset constant quotes the served metadata and is frozen', () => {
  assert.ok(Object.isFrozen(GLOBAL_CURRENTS_DATASET));
  assert.equal(GLOBAL_CURRENTS_DATASET.id, 'noaacwBLENDEDNRTcurrentsDaily');
  assert.equal(GLOBAL_CURRENTS_DATASET.uVar, 'u_current');
  assert.equal(GLOBAL_CURRENTS_DATASET.vVar, 'v_current');
  assert.equal(GLOBAL_CURRENTS_DATASET.resolutionDeg, 0.25);
  // Exact `_FillValue` from the .das; the parser must map it to NaN.
  assert.equal(GLOBAL_CURRENTS_DATASET.fillValue, -214748.3648);
  assert.match(GLOBAL_CURRENTS_DATASET.license, /^Data courtesy of NOAA;/);
  assert.match(GLOBAL_CURRENTS_DATASET.license, /not intended for legal use/);
  assert.equal(GLOBAL_CURRENTS_DATASET.attribution, 'NOAA NESDIS CoastWatch');
});

test('wrapLon180 folds any longitude into [-180, 180)', () => {
  assert.equal(wrapLon180(0), 0);
  assert.equal(wrapLon180(180), -180);
  assert.equal(wrapLon180(-180), -180);
  assert.equal(wrapLon180(190), -170);
  assert.equal(wrapLon180(-190), 170);
  assert.equal(wrapLon180(540), -180);
  assert.ok(Number.isNaN(wrapLon180(NaN)));
});

test('chooseStride: whole-globe view lands on stride 8 under a 20k budget', () => {
  const plan = chooseStride({ latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 }, 20000);
  // nLat(s) = floor(719/s)+1, nLon(s) = floor(1439/s)+1 over the full 720x1440
  // axis. s=7 gives 103*206 = 21218 (over budget); s=8 gives 90*180 = 16200.
  assert.equal(plan.stride, 8);
  assert.equal(plan.nLat, 90);
  assert.equal(plan.nLon, 180);
  assert.equal(plan.cells, 16200);
  assert.equal(plan.cellSizeDeg, 2);
  assert.equal(plan.crossesDateline, false);
  assert.equal(plan.segments.length, 1);
  assert.deepEqual(plan.segments[0], {
    latMin: -89.875,
    latMax: 88.125,
    lonMin: -179.875,
    lonMax: 178.125,
    nLat: 90,
    nLon: 180,
  });
});

test('chooseStride: a 1x2 deg box fits at native resolution', () => {
  const plan = chooseStride({ latMin: 33, latMax: 34, lonMin: -119, lonMax: -117 });
  // Edges snap OUTWARD: 33 -> index 491 (32.875), 34 -> 496 (34.125),
  // -119 -> 243 (-119.125), -117 -> 252 (-116.875).
  assert.equal(plan.stride, 1);
  assert.equal(plan.nLat, 6);
  assert.equal(plan.nLon, 10);
  assert.equal(plan.cells, 60);
  assert.deepEqual(plan.segments[0], {
    latMin: 32.875,
    latMax: 34.125,
    lonMin: -119.125,
    lonMax: -116.875,
    nLat: 6,
    nLon: 10,
  });
});

test('chooseStride: covering snap never loses the requested rectangle', () => {
  const box = { latMin: 33.2, latMax: 33.3, lonMin: -118.2, lonMax: -118.1 };
  const [seg] = chooseStride(box, DEFAULT_TARGET_CELLS).segments;
  assert.ok(seg.latMin <= box.latMin, `${seg.latMin} must cover ${box.latMin}`);
  assert.ok(seg.latMax >= box.latMax, `${seg.latMax} must cover ${box.latMax}`);
  assert.ok(seg.lonMin <= box.lonMin);
  assert.ok(seg.lonMax >= box.lonMax);
});

test('chooseStride: an absurd budget still yields a usable, not empty, plan', () => {
  const globe = { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 };
  // nLat = 1 needs s > 719; nLon = 2 needs s > 719.5. So s = 720 is the first
  // stride at or under 4 cells, and no stride ever reaches 1 column here.
  const four = chooseStride(globe, 4);
  assert.equal(four.stride, 720);
  assert.equal(four.cells, 2);
  const one = chooseStride(globe, 1);
  assert.equal(one.stride, GLOBAL_CURRENTS_AXES.lonCount);
  assert.equal(one.cells, 1);
});

test('chooseStride: budgets above the ceiling are clamped, not honoured', () => {
  const plan = chooseStride({ latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 }, 1e9);
  assert.equal(plan.targetCells, 30000);
  assert.ok(plan.cells <= 30000, `${plan.cells} cells must stay under the byte cap`);
  assert.ok(plan.stride > 1);
});

test('chooseStride: refuses an inverted or non-finite box and a zero budget', () => {
  assert.equal(chooseStride({ latMin: 40, latMax: 30, lonMin: 0, lonMax: 1 }, 100), null);
  assert.equal(chooseStride({ latMin: NaN, latMax: 30, lonMin: 0, lonMax: 1 }, 100), null);
  assert.equal(chooseStride({ latMin: 0, latMax: 1, lonMin: 0, lonMax: NaN }, 100), null);
  assert.equal(chooseStride({ latMin: 0, latMax: 1, lonMin: 0, lonMax: 1 }, 0), null);
  assert.equal(chooseStride({ latMin: 0, latMax: 1, lonMin: 0, lonMax: 1 }, NaN), null);
});

test('longitudeIndexRanges: seam, whole globe, and ordinary boxes', () => {
  assert.deepEqual(longitudeIndexRanges({ lonMin: -180, lonMax: 180 }), {
    crossesDateline: false,
    ranges: [{ start: 0, end: 1439 }],
  });
  assert.equal(longitudeIndexRanges({ lonMin: 10, lonMax: 20 }).crossesDateline, false);
  const crossing = longitudeIndexRanges({ lonMin: 170, lonMax: -170 });
  assert.equal(crossing.crossesDateline, true);
  assert.deepEqual(crossing.ranges, [{ start: 1399, end: 1439 }, { start: 0, end: 40 }]);
  assert.equal(longitudeIndexRanges({ lonMin: 0, lonMax: NaN }), null);
});

test('chooseStride: a dateline-crossing box splits into two phase-continuous segments', () => {
  const plan = chooseStride({ latMin: 0, latMax: 2, lonMin: 170, lonMax: -170 }, 100);
  // s=3 would cost 4*28 = 112 cells; s=4 costs 3*21 = 63.
  assert.equal(plan.stride, 4);
  assert.equal(plan.crossesDateline, true);
  assert.equal(plan.nLat, 3);
  assert.equal(plan.nLon, 21);
  assert.equal(plan.cells, 63);
  // Column counts and endpoints verified against the live endpoint on
  // 2026-09-01: the two requests returned 11 and 10 columns, ending at
  // 179.875 and -170.125.
  assert.deepEqual(plan.segments.map((s) => [s.lonMin, s.lonMax, s.nLon]), [
    [169.875, 179.875, 11],
    [-179.125, -170.125, 10],
  ]);
  // The seam gap is exactly one stride, like every other gap in the grid.
  const seam = (plan.segments[1].lonMin + 360) - plan.segments[0].lonMax;
  assert.equal(seam, plan.cellSizeDeg);
  // Both halves share one latitude axis, or the stitch would be meaningless.
  assert.equal(plan.segments[0].latMin, plan.segments[1].latMin);
  assert.equal(plan.segments[0].latMax, plan.segments[1].latMax);
});

test('chooseStride: a stride that steps past the eastern half drops it rather than misaligning', () => {
  // 1 deg of eastern overhang at a 360 deg stride: the progression skips it.
  const plan = chooseStride({ latMin: -90, latMax: 90, lonMin: 179, lonMax: -179 }, 4);
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.crossesDateline, false);
  assert.ok(plan.cells >= 1);
});

test('buildGlobalCurrentsUrl: brackets encoded, u before v, stride on both spatial axes', () => {
  const url = buildGlobalCurrentsUrl({
    box: { latMin: 32.875, latMax: 34.125, lonMin: -119.125, lonMax: -116.875 },
    timeIso: TIME,
    stride: 2,
  });
  const dims = '%5B(2026-08-29T00:00:00Z):1:(2026-08-29T00:00:00Z)%5D'
    + '%5B(32.875):2:(34.125)%5D%5B(-119.125):2:(-116.875)%5D';
  assert.equal(
    url,
    'https://coastwatch.noaa.gov/erddap/griddap/noaacwBLENDEDNRTcurrentsDaily.csv0'
    + `?u_current${dims},v_current${dims}`,
  );
  assert.ok(!url.includes('['), 'raw [ must not survive encoding');
  assert.ok(!url.includes(']'), 'raw ] must not survive encoding');
  assert.ok(url.indexOf('u_current') < url.indexOf('v_current'));
});

test('buildGlobalCurrentsUrl: defaults to .csv0 and normalizes the time stamp', () => {
  const url = buildGlobalCurrentsUrl({
    box: { latMin: 0.125, latMax: 0.125, lonMin: 0.125, lonMax: 0.125 },
    timeIso: '2026-08-29T00:00:00.000Z',
  });
  assert.ok(url.includes('.csv0?'));
  assert.ok(url.includes('(2026-08-29T00:00:00Z):1:(2026-08-29T00:00:00Z)'));
  assert.ok(!url.includes('.000Z'));
});

test('buildGlobalCurrentsUrl: refuses inputs whose response shape is unpredictable', () => {
  const box = { latMin: 0, latMax: 1, lonMin: 0, lonMax: 1 };
  assert.throws(
    () => buildGlobalCurrentsUrl({ box: { latMin: 0, latMax: 1, lonMin: 170, lonMax: -170 }, timeIso: TIME }),
    /dateline-crossing box must be split/,
  );
  assert.throws(() => buildGlobalCurrentsUrl({ box: { ...box, latMin: 5 }, timeIso: TIME }), /latMin 5 > latMax 1/);
  assert.throws(() => buildGlobalCurrentsUrl({ box: { ...box, lonMax: NaN }, timeIso: TIME }), /must be finite/);
  assert.throws(() => buildGlobalCurrentsUrl({ box, timeIso: TIME, stride: 0 }), /positive integer/);
  assert.throws(() => buildGlobalCurrentsUrl({ box, timeIso: TIME, stride: 1.5 }), /positive integer/);
  assert.throws(() => buildGlobalCurrentsUrl({ box, timeIso: TIME, ext: 'exe' }), /unsupported ext/);
  assert.throws(() => buildGlobalCurrentsUrl({ box, timeIso: 'not a time' }), /unparseable timeIso/);
});

test('parseGlobalCurrentsCsv0: row-major order, reconstructed axes, NaN fill', () => {
  const lats = [10.125, 10.375, 10.625];
  const lons = [-1.125, -0.875, -0.625, -0.375];
  // Payloads are quarter-m/s steps: exact in Float32, distinct per cell, and
  // inside the dataset's declared valid range (the parser NaNs anything past
  // maxSpeedMs, so a fixture of raw indices would come back empty).
  // Offset by one step so no cell is 0: `-0` and `0` are distinct to
  // assert.equal but indistinguishable once a fixture round-trips through CSV.
  const speed = (i, j) => (i * lons.length + j + 1) / 4;
  const text = csv0({
    lats,
    lons,
    u: (i, j) => (i === 1 && j === 2 ? 'NaN' : speed(i, j)),
    v: (i, j) => (i === 1 && j === 2 ? 'NaN' : -speed(i, j)),
  });
  const grid = parseGlobalCurrentsCsv0(text);
  // Axes come from the returned coordinates, not from anything a caller asked
  // for: the request that produced this would have named 10.0 and -1.0.
  assert.deepEqual(Array.from(grid.lats), lats);
  assert.deepEqual(Array.from(grid.lons), lons);
  assert.equal(grid.total, 12);
  assert.equal(grid.finite, 11);
  assert.equal(grid.timeIso, TIME);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      const idx = i * lons.length + j;
      if (i === 1 && j === 2) {
        assert.ok(Number.isNaN(grid.u[idx]), 'fill cell must be NaN in u');
        assert.ok(Number.isNaN(grid.v[idx]), 'fill cell must be NaN in v');
      } else {
        assert.equal(grid.u[idx], speed(i, j), `u at row ${i} col ${j}`);
        assert.equal(grid.v[idx], -speed(i, j), `v at row ${i} col ${j}`);
      }
    }
  }
});

test('parseGlobalCurrentsCsv0: places rows by coordinate, not by arrival order', () => {
  const lats = [1.125, 1.375];
  const lons = [2.125, 2.375, 2.625];
  const ordered = csv0({ lats, lons, u: (i, j) => i + j / 4, v: () => 0 });
  const shuffled = ordered.trim().split('\n').reverse().join('\n');
  const a = parseGlobalCurrentsCsv0(ordered);
  const b = parseGlobalCurrentsCsv0(shuffled);
  assert.deepEqual(Array.from(b.lats), Array.from(a.lats));
  assert.deepEqual(Array.from(b.lons), Array.from(a.lons));
  assert.deepEqual(Array.from(b.u), Array.from(a.u));
});

test('parseGlobalCurrentsCsv0: sorts axes ascending even when the server does not', () => {
  const text = csv0({ lats: [5.375, 5.125], lons: [0.375, 0.125], u: (i, j) => i + j / 4, v: () => 1 });
  const grid = parseGlobalCurrentsCsv0(text);
  assert.deepEqual(Array.from(grid.lats), [5.125, 5.375]);
  assert.deepEqual(Array.from(grid.lons), [0.125, 0.375]);
  // The row emitted first was (5.375, 0.375) with u = 0; it must land last.
  assert.equal(grid.u[1 * 2 + 1], 0);
  // The row emitted last was (5.125, 0.125) with u = 1.25; it must land first.
  assert.equal(grid.u[0 * 2 + 0], 1.25);
});

test('parseGlobalCurrentsCsv0: the raw _FillValue and any out-of-envelope spike become NaN', () => {
  const text = [
    `${TIME},0.125,0.125,${GLOBAL_CURRENTS_DATASET.fillValue},0.2`,
    `${TIME},0.125,0.375,0.3,99`,
    `${TIME},0.375,0.125,0.1,0.2`,
    `${TIME},0.375,0.375,-0.4,0.5`,
  ].join('\n');
  const grid = parseGlobalCurrentsCsv0(text);
  assert.ok(Number.isNaN(grid.u[0]));
  assert.ok(Number.isNaN(grid.v[1]), '99 m/s is outside the declared valid range');
  assert.equal(grid.finite, 2);
  assert.equal(grid.total, 4);
  // A real western-boundary-current speed must survive: the orchestrator
  // measured max |v| = 2.025 m/s in one Gulf Stream box on 2026-08-28.
  assert.equal(grid.v[3], 0.5);
});

test('parseGlobalCurrentsCsv0: shape drift returns null, never a partial grid', () => {
  const lats = [0.125, 0.375];
  const lons = [1.125, 1.375];
  const full = csv0({ lats, lons, u: () => 1, v: () => 2 }).trim().split('\n');

  assert.equal(parseGlobalCurrentsCsv0(full.slice(0, 3).join('\n')), null, 'missing row');
  assert.equal(
    parseGlobalCurrentsCsv0([...full.slice(0, 3), full[0]].join('\n')),
    null,
    'duplicate cell',
  );
  assert.equal(parseGlobalCurrentsCsv0(`${TIME},abc,1.125,1,2`), null, 'non-numeric latitude');
  assert.equal(parseGlobalCurrentsCsv0(`${TIME},0.125,abc,1,2`), null, 'non-numeric longitude');
  assert.equal(parseGlobalCurrentsCsv0(`${TIME},0.125,1.125,1`), null, 'missing v column');
  assert.equal(parseGlobalCurrentsCsv0(''), null, 'empty body');
  assert.equal(parseGlobalCurrentsCsv0('   \n  '), null, 'whitespace body');
  assert.equal(parseGlobalCurrentsCsv0(null), null, 'non-string body');
  assert.equal(
    parseGlobalCurrentsCsv0('Error {\n    code=404;\n    message="Not Found";\n}'),
    null,
    'ERDDAP error payload',
  );
  assert.equal(parseGlobalCurrentsCsv0('<html><body>502</body></html>'), null, 'HTML error page');
});

test('parseGlobalCurrentsCsv0: a body mixing time steps reports no single valid time', () => {
  const text = [
    `${TIME},0.125,0.125,0.1,0.2`,
    '2026-08-28T00:00:00Z,0.375,0.125,0.1,0.2',
  ].join('\n');
  const grid = parseGlobalCurrentsCsv0(text);
  assert.equal(grid.total, 2);
  assert.equal(grid.timeIso, null);
});

test('stitchGlobalCurrents: joins the seam and unwraps the eastern axis past 180', () => {
  const lats = [0.125, 0.375];
  // Eastward-flowing west half, westward-flowing east half: a mis-stitch shows
  // up as a sign flip in the wrong column.
  const west = parseGlobalCurrentsCsv0(csv0({
    lats, lons: [179.625, 179.875], u: (i, j) => i + j / 4, v: () => 1,
  }));
  const east = parseGlobalCurrentsCsv0(csv0({
    lats, lons: [-179.875, -179.625], u: (i, j) => -(i + j / 4), v: () => 2,
  }));
  const grid = stitchGlobalCurrents(west, east, 0.25);
  assert.deepEqual(Array.from(grid.lons), [179.625, 179.875, 180.125, 180.375]);
  assert.equal(grid.total, 8);
  assert.equal(grid.finite, 8);
  assert.equal(grid.timeIso, TIME);
  // Row 1 must read west, west, east, east — a straight concatenation with the
  // wrong stride would interleave rows here.
  assert.deepEqual(Array.from(grid.u.slice(4, 8)), [1, 1.25, -1, -1.25]);
  assert.deepEqual(Array.from(grid.v.slice(4, 8)), [1, 1, 2, 2]);
  // Ascending and evenly spaced across the seam.
  for (let j = 1; j < grid.lons.length; j += 1) {
    assert.equal(grid.lons[j] - grid.lons[j - 1], 0.25);
  }
});

test('stitchGlobalCurrents: refuses halves that cannot belong to one grid', () => {
  const west = parseGlobalCurrentsCsv0(csv0({ lats: [0.125, 0.375], lons: [179.875], u: () => 1, v: () => 1 }));
  const east = parseGlobalCurrentsCsv0(csv0({ lats: [0.125, 0.375], lons: [-179.875], u: () => 1, v: () => 1 }));
  const shortLat = parseGlobalCurrentsCsv0(csv0({ lats: [0.125], lons: [-179.875], u: () => 1, v: () => 1 }));
  const offLat = parseGlobalCurrentsCsv0(csv0({ lats: [0.125, 0.625], lons: [-179.875], u: () => 1, v: () => 1 }));

  assert.ok(stitchGlobalCurrents(west, east, 0.25), 'control: these two halves do stitch');
  assert.equal(stitchGlobalCurrents(west, shortLat, 0.25), null, 'latitude axes differ in length');
  assert.equal(stitchGlobalCurrents(west, offLat, 0.25), null, 'latitude axes differ in value');
  assert.equal(stitchGlobalCurrents(west, east, 0.5), null, 'seam gap is not one stride');
  assert.equal(stitchGlobalCurrents(null, east, 0.25), null);
  assert.equal(stitchGlobalCurrents(west, east, NaN), null);
  // A hand-built half must be refused, not crash: `undefined.length` and a
  // short typed-array `set()` both throw, and a throw from a "returns null on
  // bad input" function is a different failure than the caller handles.
  assert.equal(stitchGlobalCurrents(west, {}, 0.25), null, 'half with no axes');
  assert.equal(
    stitchGlobalCurrents(west, { ...east, u: Array.from(east.u) }, 0.25),
    null,
    'plain-array payload',
  );
  assert.equal(
    stitchGlobalCurrents(west, { ...east, u: new Float32Array(1) }, 0.25),
    null,
    'payload shorter than its own axes',
  );
});

test('latestTimeIso: reports the stamp and its age', async () => {
  const fetchImpl = fakeFetch([[TIME_PROBE, `${TIME}\n`]]);
  const nowMs = Date.parse('2026-09-01T00:00:00Z');
  const probe = await latestTimeIso({ fetchImpl, nowMs });
  assert.equal(probe.timeIso, TIME);
  assert.equal(probe.validAtMs, Date.parse(TIME));
  assert.equal(probe.ageMs, 3 * 86400000); // 3 days, the dataset's measured latency
  assert.ok(probe.url.endsWith('.csv0?time%5B(last)%5D'));
});

test('latestTimeIso: every upstream failure mode returns null, not a guessed time', async () => {
  const cases = [
    ['HTTP error', [[TIME_PROBE, { ok: false, status: 500, text: async () => 'Error { code=500; }' }]]],
    ['error payload', [[TIME_PROBE, 'Error {\n    code=404;\n}']]],
    ['empty body', [[TIME_PROBE, '   ']]],
    ['garbage stamp', [[TIME_PROBE, 'yesterday\n']]],
  ];
  for (const [label, routes] of cases) {
    assert.equal(await latestTimeIso({ fetchImpl: fakeFetch(routes) }), null, label);
  }
});

test('fetchGlobalCurrents: probes the time, fetches one segment, reports the source', async () => {
  const box = { latMin: 10, latMax: 10.5, lonMin: -1, lonMax: -0.5 };
  const plan = chooseStride(box, DEFAULT_TARGET_CELLS);
  assert.equal(plan.stride, 1);
  assert.equal(plan.cells, 16);
  // Land the whole third row on the fill value, so coverage is checkable.
  const speed = (i, j) => i + j / 4;
  const body = segmentCsv0(
    plan.segments[0],
    plan.stride,
    (i, j) => (i === 2 ? 'NaN' : speed(i, j)),
    (i, j) => (i === 2 ? 'NaN' : -speed(i, j)),
  );
  const log = [];
  const fetchImpl = fakeFetch([[TIME_PROBE, `${TIME}\n`], ['u_current', body]], log);
  const nowMs = Date.parse('2026-09-01T00:00:00Z');

  const result = await fetchGlobalCurrents({ box, fetchImpl, nowMs });
  assert.equal(log.length, 2, 'one time probe plus one data request');
  assert.deepEqual(Array.from(result.lats), [9.875, 10.125, 10.375, 10.625]);
  assert.deepEqual(Array.from(result.lons), [-1.125, -0.875, -0.625, -0.375]);
  assert.equal(result.total, 16);
  assert.equal(result.finite, 12);
  assert.equal(result.u[1 * 4 + 3], 1.75);
  assert.ok(Number.isNaN(result.u[2 * 4 + 0]));

  assert.equal(result.source.datasetId, 'noaacwBLENDEDNRTcurrentsDaily');
  assert.equal(result.source.validAtMs, Date.parse(TIME));
  assert.equal(result.source.ageMs, 3 * 86400000);
  assert.equal(result.source.stride, 1);
  assert.equal(result.source.resolutionDeg, 0.25);
  assert.equal(result.source.nativeResolutionDeg, 0.25);
  assert.equal(result.source.cells, 16);
  assert.equal(result.source.coverage, 0.75);
  assert.equal(result.source.crossesDateline, false);
  assert.equal(result.source.urls.length, 1);
  assert.equal(result.source.url, result.source.urls[0]);
  assert.equal(result.source.label, GLOBAL_CURRENTS_DATASET.label);
});

test('fetchGlobalCurrents: an explicit time skips the probe', async () => {
  const box = { latMin: 10, latMax: 10.5, lonMin: -1, lonMax: -0.5 };
  const plan = chooseStride(box, DEFAULT_TARGET_CELLS);
  const body = segmentCsv0(plan.segments[0], plan.stride, () => 0.1, () => 0.2);
  const log = [];
  const fetchImpl = fakeFetch([['u_current', body]], log);
  const result = await fetchGlobalCurrents({
    box, fetchImpl, timeIso: TIME, nowMs: Date.parse('2026-08-30T00:00:00Z'),
  });
  assert.equal(log.length, 1, 'no time probe when the caller supplies one');
  assert.equal(result.source.ageMs, 86400000);
});

test('fetchGlobalCurrents: a dateline view issues two requests and stitches them', async () => {
  const box = { latMin: 0, latMax: 2, lonMin: 170, lonMax: -170 };
  const plan = chooseStride(box, 100);
  assert.equal(plan.segments.length, 2);
  // Sign separates the halves and 1/16 m/s steps separate the columns, all
  // exact in Float32 and inside the dataset's valid range.
  const speed = (i, j) => i + j / 16;
  const west = segmentCsv0(plan.segments[0], plan.stride, speed, () => 1);
  const east = segmentCsv0(plan.segments[1], plan.stride, (i, j) => -speed(i, j), () => 2);
  const log = [];
  const fetchImpl = fakeFetch([
    [TIME_PROBE, `${TIME}\n`],
    ['(169.875):4:(179.875)', west],
    ['(-179.125):4:(-170.125)', east],
  ], log);

  const result = await fetchGlobalCurrents({ box, targetCells: 100, fetchImpl, nowMs: Date.parse(TIME) });
  assert.equal(log.length, 3, 'one probe plus one request per segment');
  assert.equal(result.source.urls.length, 2);
  assert.equal(result.source.crossesDateline, true);
  assert.equal(result.total, 63);
  assert.deepEqual(Array.from(result.lats), [-0.125, 0.875, 1.875]);
  // 21 columns ascending through the seam at 1 deg (stride 4) spacing.
  assert.equal(result.lons.length, 21);
  assert.equal(result.lons[0], 169.875);
  assert.equal(result.lons[10], 179.875);
  assert.equal(result.lons[11], 180.875);
  assert.equal(result.lons[20], 189.875);
  for (let j = 1; j < result.lons.length; j += 1) {
    assert.equal(result.lons[j] - result.lons[j - 1], 1);
  }
  // Row 1: 11 western columns then 10 eastern ones, in that order.
  assert.equal(result.u[1 * 21 + 0], 1);
  assert.equal(result.u[1 * 21 + 10], 1 + 10 / 16);
  assert.equal(result.u[1 * 21 + 11], -1);
  assert.equal(result.u[1 * 21 + 20], -(1 + 9 / 16));
  assert.equal(result.v[1 * 21 + 10], 1);
  assert.equal(result.v[1 * 21 + 11], 2);
});

test('fetchGlobalCurrents: refuses to invent a field when anything upstream is wrong', async () => {
  const box = { latMin: 10, latMax: 10.5, lonMin: -1, lonMax: -0.5 };
  const plan = chooseStride(box, DEFAULT_TARGET_CELLS);
  const good = segmentCsv0(plan.segments[0], plan.stride, () => 0.1, () => 0.2);

  await assert.rejects(
    () => fetchGlobalCurrents({ box: { latMin: 40, latMax: 10, lonMin: 0, lonMax: 1 }, fetchImpl: fakeFetch([]) }),
    /unusable view rectangle/,
  );
  await assert.rejects(
    () => fetchGlobalCurrents({ box, fetchImpl: fakeFetch([[TIME_PROBE, 'Error { code=500; }']]) }),
    /could not resolve the dataset's latest time step/,
  );
  await assert.rejects(
    () => fetchGlobalCurrents({
      box,
      timeIso: TIME,
      fetchImpl: fakeFetch([['u_current', { ok: false, status: 502, text: async () => 'Error {}' }]]),
    }),
    /HTTP 502/,
  );
  await assert.rejects(
    () => fetchGlobalCurrents({
      box,
      timeIso: TIME,
      fetchImpl: fakeFetch([['u_current', good.trim().split('\n').slice(0, 15).join('\n')]]),
    }),
    /shape-drifted/,
  );
  await assert.rejects(
    () => fetchGlobalCurrents({
      box,
      timeIso: TIME,
      fetchImpl: fakeFetch([['u_current', 'x'.repeat(RESPONSE_BYTE_CAP + 1)]]),
    }),
    /exceeds the 2097152 B cap/,
  );
});

test('every request carries the descriptive User-Agent CoastWatch requires', async () => {
  // coastwatch.noaa.gov answers 403 to Node's default undici User-Agent
  // (verified 2026-09-01), so this header is functional, not decorative.
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(options?.headers?.['User-Agent']);
    return { ok: true, status: 200, text: async () => `${TIME}\n` };
  };
  await latestTimeIso({ fetchImpl });
  assert.deepEqual(seen, [GLOBAL_CURRENTS_USER_AGENT]);
  assert.match(GLOBAL_CURRENTS_USER_AGENT, /^gods-eye-view-/);
});

test('fetchGlobalCurrents: a caller abort propagates instead of hanging', async () => {
  const box = { latMin: 10, latMax: 10.5, lonMin: -1, lonMax: -0.5 };
  const controller = new AbortController();
  controller.abort(new Error('camera moved'));
  const fetchImpl = async (_url, options) => {
    if (options?.signal?.aborted) throw options.signal.reason;
    return { ok: true, status: 200, text: async () => '' };
  };
  await assert.rejects(
    () => fetchGlobalCurrents({ box, timeIso: TIME, fetchImpl, signal: controller.signal }),
    /camera moved/,
  );
});

test('parseGlobalCurrentsCsv0: a blank coordinate is refused, not read as zero', () => {
  // `Number('')` is 0, so a parser that reaches for `Number` alone places a
  // coordinate-less row on the equator at the prime meridian and reports it as
  // data. Both fields, and a lone minus sign, must sink the whole body.
  assert.equal(parseGlobalCurrentsCsv0(`${TIME},,0.125,0.1,0.2`), null, 'blank latitude');
  assert.equal(parseGlobalCurrentsCsv0(`${TIME},0.125,,0.1,0.2`), null, 'blank longitude');
  assert.equal(parseGlobalCurrentsCsv0(`${TIME}, ,0.125,0.1,0.2`), null, 'whitespace latitude');
  assert.equal(parseGlobalCurrentsCsv0(`${TIME},-,0.125,0.1,0.2`), null, 'bare sign');
  assert.equal(parseGlobalCurrentsCsv0(`${TIME},Infinity,0.125,0.1,0.2`), null, 'infinite latitude');
});

test('parseGlobalCurrentsCsv0: half a vector is no vector', () => {
  // Direction needs both components. A cell with u = 0.3 and v = NaN must not
  // reach a streakline integrator as a confident due-east flow.
  // Payloads are quarter-m/s steps, exact in the Float32 the grid stores.
  const text = [
    `${TIME},0.125,0.125,0.25,NaN`,
    `${TIME},0.125,0.375,NaN,0.5`,
    `${TIME},0.375,0.125,0.75,0.25`,
    `${TIME},0.375,0.375,1,-0.5`,
  ].join('\n');
  const grid = parseGlobalCurrentsCsv0(text);
  assert.ok(Number.isNaN(grid.u[0]), 'u must be voided when v is missing');
  assert.ok(Number.isNaN(grid.v[0]));
  assert.ok(Number.isNaN(grid.u[1]));
  assert.ok(Number.isNaN(grid.v[1]), 'v must be voided when u is missing');
  assert.equal(grid.u[2], 0.75);
  assert.equal(grid.v[3], -0.5);
  // `finite` counts cells a caller can actually draw.
  assert.equal(grid.finite, 2);
  assert.equal(grid.total, 4);
});

test('longitudeIndexRanges: the -180 edge yields index +0, not -0', () => {
  // ceil(-0.5) is -0; leaking it makes a range object compare unequal to the
  // identical one built with 0, and turns up as a spurious deepStrictEqual
  // failure in whatever consumes the plan.
  const { ranges } = longitudeIndexRanges({ lonMin: -180, lonMax: -180 });
  assert.deepEqual(ranges, [{ start: 0, end: 0 }]);
  assert.ok(Object.is(ranges[0].end, 0), 'end must be +0');
});

test('chooseStride: column count obeys floor((span-1)/s)+1 across the seam', () => {
  // The two dateline segments are one arithmetic progression cut at the axis
  // end, so the stitched column count is the same function of the stride as it
  // would be on an uncut axis of the same span. This is the property that keeps
  // the seam gap equal to every other gap.
  const box = { latMin: 0, latMax: 0.1, lonMin: 170, lonMax: -170 };
  const { ranges } = longitudeIndexRanges(box);
  const span = ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
  assert.equal(span, 82, '41 columns each side of the seam');
  const strides = new Map();
  for (let budget = 1; budget <= 200; budget += 1) {
    const plan = chooseStride(box, budget);
    strides.set(plan.stride, plan.nLon);
  }
  assert.ok(strides.size >= 8, `only ${strides.size} distinct strides exercised`);
  for (const [stride, nLon] of strides) {
    assert.equal(nLon, Math.floor((span - 1) / stride) + 1, `nLon at stride ${stride}`);
  }
});

test('fetchGlobalCurrents: the served time stamp wins over the requested one', async () => {
  // ERDDAP snaps `(t)` to its nearest step, so asking for noon on a daily axis
  // returns midnight's field. Reporting the request would understate the age of
  // what is on screen by half a day.
  const box = { latMin: 10, latMax: 10.5, lonMin: -1, lonMax: -0.5 };
  const plan = chooseStride(box, DEFAULT_TARGET_CELLS);
  const body = segmentCsv0(plan.segments[0], plan.stride, () => 0.1, () => 0.2, TIME);
  const result = await fetchGlobalCurrents({
    box,
    timeIso: '2026-08-29T12:00:00Z',
    fetchImpl: fakeFetch([['u_current', body]]),
    nowMs: Date.parse('2026-08-30T00:00:00Z'),
  });
  assert.equal(result.source.timeIso, TIME, 'the stamp the body carried');
  assert.equal(result.source.requestedTimeIso, '2026-08-29T12:00:00Z');
  assert.equal(result.source.validAtMs, Date.parse(TIME));
  assert.equal(result.source.ageMs, 86400000, 'age measured from the served step');
});

test('fetchGlobalCurrents: reports the resolution the axes show, not the stride asked for', async () => {
  const box = { latMin: 0, latMax: 2, lonMin: 170, lonMax: -170 };
  const plan = chooseStride(box, 100);
  const west = segmentCsv0(plan.segments[0], plan.stride, () => 0.1, () => 0.2);
  const east = segmentCsv0(plan.segments[1], plan.stride, () => 0.1, () => 0.2);
  const result = await fetchGlobalCurrents({
    box,
    targetCells: 100,
    timeIso: TIME,
    fetchImpl: fakeFetch([['(169.875):4:(179.875)', west], ['(-179.125):4:(-170.125)', east]]),
  });
  // Stride 4 on a 0.25 deg grid: the stitched axis really is spaced 1 deg, and
  // that spacing is measured off the returned longitudes.
  assert.equal(result.source.resolutionDeg, 1);
  assert.equal(result.lons[1] - result.lons[0], result.source.resolutionDeg);
  assert.equal(result.source.nativeResolutionDeg, 0.25);
  assert.equal(result.source.stride, 4);
});

test('fetchGlobalCurrents: a body that cannot date or space itself is an error', async () => {
  const box = { latMin: 10, latMax: 10.5, lonMin: -1, lonMax: -0.5 };
  const plan = chooseStride(box, DEFAULT_TARGET_CELLS);
  const { latMin, lonMin, nLon } = plan.segments[0];

  // Two time steps in one body: nothing in it says which field this is.
  const mixed = csv0({
    lats: [latMin, latMin + 0.25],
    lons: axisFrom(lonMin, nLon, 0.25),
    u: () => 0.1,
    v: () => 0.2,
  }).trim().split('\n');
  const half = mixed.length / 2;
  const twoTimes = [
    ...mixed.slice(0, half),
    ...mixed.slice(half).map((line) => line.replace(TIME, '2026-08-28T00:00:00Z')),
  ].join('\n');
  await assert.rejects(
    () => fetchGlobalCurrents({ box, timeIso: TIME, fetchImpl: fakeFetch([['u_current', twoTimes]]) }),
    /no single parseable time stamp/,
  );

  // A latitude axis with a hole in it has no single resolution; reporting one
  // would smear every row above the gap.
  const gappy = csv0({
    lats: [10.125, 10.375, 10.875],
    lons: [-1.125, -0.875],
    u: () => 0.1,
    v: () => 0.2,
  });
  await assert.rejects(
    () => fetchGlobalCurrents({ box, timeIso: TIME, fetchImpl: fakeFetch([['u_current', gappy]]) }),
    /not uniformly spaced/,
  );
});

test('fetchGlobalCurrents: an abort during the time probe is reported as the abort', async () => {
  // latestTimeIso flattens cancellation to null like every other failure, so
  // without care a camera move gets blamed on a CoastWatch outage.
  const box = { latMin: 10, latMax: 10.5, lonMin: -1, lonMax: -0.5 };
  const controller = new AbortController();
  controller.abort(new Error('camera moved'));
  const fetchImpl = async (_url, options) => {
    if (options?.signal?.aborted) throw options.signal.reason;
    return { ok: true, status: 200, text: async () => `${TIME}\n` };
  };
  await assert.rejects(
    () => fetchGlobalCurrents({ box, fetchImpl, signal: controller.signal }),
    /camera moved/,
  );
});

test('fetchGlobalCurrents: a hung upstream trips the timeout instead of waiting forever', async () => {
  const box = { latMin: 10, latMax: 10.5, lonMin: -1, lonMax: -0.5 };
  const hang = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  await assert.rejects(
    () => fetchGlobalCurrents({ box, timeIso: TIME, fetchImpl: hang, timeoutMs: 5 }),
    /timed out after 5 ms/,
  );
});

test('fetchGlobalCurrents: a response object without ok is refused, not read as 200', async () => {
  // A fetch double or wrapper that forgets `ok` would otherwise sail through
  // and land an ERDDAP error page in the parser, which reports "no data" —
  // exactly the still-ocean failure this module exists to prevent.
  const box = { latMin: 10, latMax: 10.5, lonMin: -1, lonMax: -0.5 };
  const fetchImpl = async () => ({ status: 200, text: async () => 'Error { code=500; }' });
  await assert.rejects(
    () => fetchGlobalCurrents({ box, timeIso: TIME, fetchImpl }),
    /no usable response/,
  );
  assert.equal(await latestTimeIso({ fetchImpl }), null, 'the probe still degrades to null');
});

// One live probe, opt-in so the default suite stays offline and deterministic.
const LIVE = process.env.GEV_LIVE_ENDPOINT_TESTS === '1';

test('live: the real dataset serves a stitched, mostly-oceanic field', { skip: !LIVE }, async () => {
  const probe = await latestTimeIso({ timeoutMs: 45000 });
  assert.ok(probe, 'time probe must resolve');
  assert.ok(probe.ageMs > 0, `stamp ${probe.timeIso} must be in the past`);
  assert.ok(
    probe.ageMs < 10 * 86400000,
    `dataset is ${(probe.ageMs / 86400000).toFixed(1)} days stale — check for a CoastWatch outage`,
  );

  // Gulf Stream: 84.4% finite at stride 1 when the orchestrator measured it.
  const gulf = await fetchGlobalCurrents({
    box: { latMin: 30, latMax: 45, lonMin: -75, lonMax: -45 },
    targetCells: 4000,
    timeIso: probe.timeIso,
    timeoutMs: 60000,
  });
  assert.equal(gulf.total, gulf.lats.length * gulf.lons.length);
  assert.ok(gulf.total <= 4000, `${gulf.total} cells must respect the budget`);
  assert.ok(gulf.source.coverage > 0.5, `coverage ${gulf.source.coverage.toFixed(3)} looks like land`);
  let maxSpeed = 0;
  for (let k = 0; k < gulf.total; k += 1) {
    if (!Number.isFinite(gulf.u[k]) || !Number.isFinite(gulf.v[k])) continue;
    maxSpeed = Math.max(maxSpeed, Math.hypot(gulf.u[k], gulf.v[k]));
  }
  assert.ok(maxSpeed > 0.3, `max speed ${maxSpeed.toFixed(3)} m/s: the jet should be faster than this`);
  assert.ok(maxSpeed < GLOBAL_CURRENTS_DATASET.maxSpeedMs);
  for (let i = 1; i < gulf.lats.length; i += 1) assert.ok(gulf.lats[i] > gulf.lats[i - 1]);
  for (let j = 1; j < gulf.lons.length; j += 1) assert.ok(gulf.lons[j] > gulf.lons[j - 1]);

  // Dateline: two live requests must stitch into one evenly spaced axis.
  const seam = await fetchGlobalCurrents({
    box: { latMin: 0, latMax: 20, lonMin: 170, lonMax: -170 },
    targetCells: 2000,
    timeIso: probe.timeIso,
    timeoutMs: 60000,
  });
  assert.equal(seam.source.crossesDateline, true);
  assert.equal(seam.source.urls.length, 2);
  const step = seam.source.resolutionDeg;
  for (let j = 1; j < seam.lons.length; j += 1) {
    assert.ok(
      Math.abs((seam.lons[j] - seam.lons[j - 1]) - step) < 1e-6,
      `seam spacing broke at column ${j}: ${seam.lons[j - 1]} -> ${seam.lons[j]}`,
    );
  }
  assert.ok(seam.source.coverage > 0.8, 'the open Pacific should be almost all water');
});
