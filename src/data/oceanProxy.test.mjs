import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeOceanObs,
  buildMarineGridAxes,
  buildMarineGridParams,
  marineHoursToMs,
  normalizeMarineGridUpstream,
  fetchOceanObs,
  buildEtopoBox,
  normalizeEtopoUpstream,
  resolveServedAxes,
  oceanSeparationM,
  georeferenceMarineGrid,
  oceanProxy,
} from '../../vite.config.js';
import { normalizeForcingGrid } from '../sim/driftController.js';

const ETOPO_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/etopo-sample.json', import.meta.url), 'utf8'),
);

const OBS_TEXT =
  '#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE\n' +
  '#text      deg      deg   yr mo day hr mn degT  m/s   m/s   m   sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft\n' +
  '46222    33.614 -118.314 2026 08 29 02 56  MM    MM    MM  0.8   8 5.5 215     MM    MM    MM  24.5    MM   MM     MM\n' +
  '14049   -12.000   65.000 2026 08 29 01 00 153   7.7   9.5   MM  MM   MM  MM 1016.2    MM  14.4  26.6    MM   MM     MM\n';

test('normalizeOceanObs joins station names from metadata and nulls the rest', () => {
  const records = [
    { stationId: '46222', lat: 33.614, lon: -118.314, waveHeightM: 0.8 },
    { stationId: '14049', lat: -12, lon: 65, waveHeightM: null },
  ];
  const meta = new Map([
    ['46222', { id: '46222', lat: 33.614, lon: -118.314, name: 'San Pedro, CA', type: 'buoy', met: false, currents: false }],
  ]);
  const stations = normalizeOceanObs(records, meta);
  assert.equal(stations.length, 2);
  assert.equal(stations[0].name, 'San Pedro, CA');
  assert.equal(stations[0].type, 'buoy');
  assert.equal(stations[0].waveHeightM, 0.8);
  assert.equal(stations[1].name, null);
  assert.equal(stations[1].type, null);
});

test('buildMarineGridAxes yields 5x5 axes at 0.5 deg spacing centered on the seed', () => {
  const axes = buildMarineGridAxes(33.34, -118.33);
  assert.deepEqual(axes.lats, [32.34, 32.84, 33.34, 33.84, 34.34]);
  assert.deepEqual(axes.lons, [-119.33, -118.83, -118.33, -117.83, -117.33]);
});

test('buildMarineGridAxes clamps to valid latitude/longitude ranges near the edges', () => {
  const axes = buildMarineGridAxes(89.5, 179.8);
  assert.ok(axes.lats.every((lat) => lat >= -90 && lat <= 90));
  assert.ok(axes.lons.every((lon) => lon >= -180 && lon <= 180));
  assert.equal(axes.lats.length, 5);
  assert.equal(axes.lons.length, 5);
});

test('buildMarineGridParams requests a forward axis covering the longest offered horizon, plus 2 past days', () => {
  const axes = buildMarineGridAxes(33.34, -118.33);
  const { marineParams, windParams, nodeCount } = buildMarineGridParams(axes);
  assert.equal(nodeCount, 25);
  // The forward axis runs to the END of (today + forecast_days − 1), so a run
  // launched at hour h has 24·(forecast_days − 1) + (23 − h) hours of lead.
  // The panel offers a 48 h horizon, so the WORST launch hour (h = 23) must
  // still cover it — otherwise the tail integrates on a frozen end-hour field.
  // forecast_days=2 gave only (23 − h) h and clamped on every 48 h run.
  const LONGEST_HORIZON_H = 48;
  const forecastDays = Number(marineParams.get('forecast_days'));
  const worstCaseLeadH = 24 * (forecastDays - 1) + 0;
  assert.ok(
    worstCaseLeadH >= LONGEST_HORIZON_H,
    `forecast_days=${forecastDays} gives only ${worstCaseLeadH} h of worst-case lead, `
    + `below the ${LONGEST_HORIZON_H} h horizon the panel offers`,
  );
  for (const params of [marineParams, windParams]) {
    assert.equal(params.get('forecast_days'), String(forecastDays));
    assert.equal(params.get('past_days'), '2');
    assert.equal(params.get('timezone'), 'UTC');
    assert.equal(params.get('latitude').split(',').length, 25);
    assert.equal(params.get('longitude').split(',').length, 25);
  }
  assert.equal(marineParams.get('hourly'), 'wave_height,ocean_current_velocity,ocean_current_direction');
  assert.equal(windParams.get('hourly'), 'wind_speed_10m,wind_direction_10m');
  assert.equal(windParams.get('wind_speed_unit'), 'ms');
  assert.equal(marineParams.get('wind_speed_unit'), null);
});

test('marineHoursToMs converts Open-Meteo ISO hours (UTC, no zone suffix) to epoch ms', () => {
  const hoursMs = marineHoursToMs(['2026-08-29T00:00', '2026-08-29T01:00']);
  assert.deepEqual(hoursMs, [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 29, 1, 0)]);
  assert.deepEqual(marineHoursToMs(['garbage']), null);
  assert.deepEqual(marineHoursToMs([]), null);
});

function marineElement(base) {
  return {
    hourly: {
      time: ['2026-08-29T00:00', '2026-08-29T01:00'],
      wave_height: [base, base + 0.1],
      ocean_current_velocity: [base * 2, base * 2 + 0.1],
      ocean_current_direction: [45, 90],
    },
  };
}

function windElement(base) {
  return {
    hourly: {
      time: ['2026-08-29T00:00', '2026-08-29T01:00'],
      wind_speed_10m: [base * 3, base * 3 + 0.1],
      wind_direction_10m: [180, 200],
    },
  };
}

test('normalizeMarineGridUpstream zips array-shaped marine + wind responses into nodes', () => {
  const marine = [marineElement(1), marineElement(2)];
  const wind = [windElement(1), windElement(2)];
  const grid = normalizeMarineGridUpstream(marine, wind, 2);
  assert.deepEqual(grid.hoursMs, [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 29, 1, 0)]);
  assert.equal(grid.nodes.length, 2);
  assert.deepEqual(grid.nodes[0].waveHeightM, [1, 1.1]);
  assert.deepEqual(grid.nodes[0].currentKmh, [2, 2.1]);
  assert.deepEqual(grid.nodes[0].currentDirDeg, [45, 90]);
  assert.deepEqual(grid.nodes[0].windMs, [3, 3.1]);
  assert.deepEqual(grid.nodes[1].windDirDeg, [180, 200]);
});

test('normalizeMarineGridUpstream accepts a single-object response when one node is expected', () => {
  const grid = normalizeMarineGridUpstream(marineElement(1), windElement(1), 1);
  assert.equal(grid.nodes.length, 1);
  assert.deepEqual(grid.nodes[0].waveHeightM, [1, 1.1]);
});

test('normalizeMarineGridUpstream returns null on node-count mismatch or missing hours', () => {
  assert.equal(normalizeMarineGridUpstream([marineElement(1)], [windElement(1)], 2), null);
  assert.equal(normalizeMarineGridUpstream({ hourly: { time: [] } }, windElement(1), 1), null);
});

test('fetchOceanObs parses upstream text through the NDBC gate with an injectable fetch', async () => {
  const payload = await fetchOceanObs({
    fetchImpl: async () => new Response(OBS_TEXT, { status: 200 }),
  });
  assert.equal(payload.stations.length, 2);
  assert.equal(payload.stations[0].stationId, '46222');
  assert.ok(Number.isFinite(payload.fetchedAtMs));
});

test('fetchOceanObs rejects HTML upstream bodies (broken feed, never cache them)', async () => {
  await assert.rejects(
    fetchOceanObs({ fetchImpl: async () => new Response('<html>503</html>', { status: 200 }) }),
    /non-NDBC/,
  );
});

test('buildEtopoBox centers a ±1.5 deg box on the seed', () => {
  const box = buildEtopoBox(36.5, -122.5);
  assert.deepEqual(box, { lat0: 35, lat1: 38, lon0: -124, lon1: -121 });
});

test('buildEtopoBox clamps to valid latitude/longitude ranges near the edges', () => {
  const box = buildEtopoBox(89.2, 179.2);
  assert.equal(box.lat1, 90);
  assert.equal(box.lon1, 180);
  assert.equal(box.lat0, 87.7);
  assert.equal(box.lon0, 177.7);
  const south = buildEtopoBox(-89.4, -179.4);
  assert.equal(south.lat0, -90);
  assert.equal(south.lon0, -180);
});

test('buildEtopoBox rounds edges to 4 decimals so cache keys stay stable', () => {
  const box = buildEtopoBox(36.123456789, -122.987654321);
  assert.deepEqual(box, { lat0: 34.6235, lat1: 37.6235, lon0: -124.4877, lon1: -121.4877 });
});

test('normalizeEtopoUpstream parses the captured ERDDAP table fixture with exact spot values', () => {
  const grid = normalizeEtopoUpstream(ETOPO_FIXTURE);
  assert.deepEqual(grid.lats, [36, 36.03333333333333, 36.06666666666666, 36.099999999999994]);
  assert.deepEqual(grid.lons, [-122.1, -122.06666666666666, -122.03333333333333, -122]);
  assert.equal(grid.z.length, 16);
  // Row-major: z[latIndex * lons.length + lonIndex], both axes ascending.
  assert.equal(grid.z[0], -1442); // (36, -122.1)
  assert.equal(grid.z[3], -1265); // (36, -122)
  assert.equal(grid.z[8], -1672); // (36.0667, -122.1)
  assert.equal(grid.z[15], -1344); // (36.1, -122)
});

test('normalizeEtopoUpstream keys by column NAME — shuffled columns still parse', () => {
  const shuffled = {
    table: {
      columnNames: ['altitude', 'longitude', 'latitude'],
      rows: ETOPO_FIXTURE.table.rows.map(([lat, lon, alt]) => [alt, lon, lat]),
    },
  };
  assert.deepEqual(normalizeEtopoUpstream(shuffled), normalizeEtopoUpstream(ETOPO_FIXTURE));
});

test('normalizeEtopoUpstream returns null on shape drift, never empty bathymetry', () => {
  assert.equal(normalizeEtopoUpstream(null), null);
  assert.equal(normalizeEtopoUpstream({}), null);
  assert.equal(normalizeEtopoUpstream({ table: { columnNames: ['latitude', 'longitude', 'altitude'], rows: [] } }), null);
  // Renamed column.
  assert.equal(normalizeEtopoUpstream({
    table: { columnNames: ['latitude', 'longitude', 'elevation'], rows: ETOPO_FIXTURE.table.rows },
  }), null);
  // Non-numeric altitude entry.
  const badValue = structuredClone(ETOPO_FIXTURE);
  badValue.table.rows[5][2] = null;
  assert.equal(normalizeEtopoUpstream(badValue), null);
  // Dropped row — lats×lons no longer covers the table.
  const truncated = structuredClone(ETOPO_FIXTURE);
  truncated.table.rows.pop();
  assert.equal(normalizeEtopoUpstream(truncated), null);
});

// ── Served-vs-requested georeferencing (the A1 defect) ──────────────────────
// Open-Meteo snaps every requested coordinate to its own 1/12° cell centre and
// echoes the snapped centre back. Georeferencing the forcing grid to the
// REQUESTED lattice attributed each velocity to a point up to 22.5 km from
// where it was sampled. These pin the recovery of the served lattice.

/** Build a 3×3 served-coordinate pair with a uniform snap offset applied. */
function servedLattice(lats, lons, dLat, dLon) {
  const servedLats = [];
  const servedLons = [];
  for (const lat of lats) {
    for (const lon of lons) {
      servedLats.push(lat + dLat);
      servedLons.push(lon + dLon);
    }
  }
  return { servedLats, servedLons };
}

test('resolveServedAxes recovers a uniformly snapped lattice and drops nothing', () => {
  const lats = [36.3, 36.8, 37.3];
  const lons = [-122.5, -122.0, -121.5];
  // The measured Monterey offset: (−0.008336°, −0.041660°).
  const { servedLats, servedLons } = servedLattice(lats, lons, -0.008336, -0.041660);
  const served = resolveServedAxes(servedLats, servedLons, { lats, lons });
  assert.deepEqual(served.dropped, []);
  served.lats.forEach((lat, i) => assert.ok(Math.abs(lat - (lats[i] - 0.008336)) < 1e-9));
  served.lons.forEach((lon, j) => assert.ok(Math.abs(lon - (lons[j] - 0.041660)) < 1e-9));
});

test('resolveServedAxes drops a land-substituted node instead of misplacing it', () => {
  const lats = [36.3, 36.8, 37.3];
  const lons = [-122.5, -122.0, -121.5];
  const { servedLats, servedLons } = servedLattice(lats, lons, -0.008336, -0.041660);
  // Node 5 (row 1, col 2) requested a land cell; upstream substituted the
  // nearest wet cell 0.2° west — far outside the half-native-cell tolerance.
  servedLons[5] -= 0.2;
  const served = resolveServedAxes(servedLats, servedLons, { lats, lons });
  assert.deepEqual(served.dropped, [5]);
  // The consensus axes must be unmoved by the outlier — a mean would drift.
  assert.ok(Math.abs(served.lons[2] - (-121.5 - 0.041660)) < 1e-9);
});

test('resolveServedAxes returns null on shape drift rather than guessing', () => {
  assert.equal(resolveServedAxes([1, 2, 3], [1, 2, 3], { lats: [0, 1], lons: [0, 1] }), null);
  assert.equal(resolveServedAxes([1, 2, 3, Number.NaN], [1, 2, 3, 4], { lats: [0, 1], lons: [0, 1] }), null);
  assert.equal(resolveServedAxes([1, 2, 3, undefined], [1, 2, 3, 4], { lats: [0, 1], lons: [0, 1] }), null);
});

test('normalizeMarineGridUpstream carries served coordinates for both endpoints', () => {
  const hourly = { time: ['2026-08-29T00:00'], wave_height: [1], ocean_current_velocity: [2], ocean_current_direction: [90] };
  const windHourly = { time: ['2026-08-29T00:00'], wind_speed_10m: [5], wind_direction_10m: [270] };
  const marine = [{ latitude: 36.79, longitude: -122.04, hourly }];
  const wind = [{ latitude: 36.78, longitude: -122.00, hourly: windHourly }];
  const out = normalizeMarineGridUpstream(marine, wind, 1);
  assert.deepEqual(out.servedLats, [36.79]);
  assert.deepEqual(out.servedLons, [-122.04]);
  // The two Open-Meteo endpoints snap independently and need not agree; the
  // caller reports the skew rather than assuming one covers the other.
  assert.deepEqual(out.windLats, [36.78]);
  assert.deepEqual(out.windLons, [-122.00]);
});

test('oceanSeparationM measures the requested-vs-served displacement in metres', () => {
  // One degree of latitude is 111.19 km on a sphere of R = 6371 km.
  assert.ok(Math.abs(oceanSeparationM(36, -122, 37, -122) - 111194.9) < 1);
  assert.equal(oceanSeparationM(36.8, -122, 36.8, -122), 0);
  // The measured worst Monterey snap, as a regression anchor on the units.
  const m = oceanSeparationM(36.8, -122.0, 36.791664, -122.04166);
  assert.ok(m > 3000 && m < 4500, `expected ~3.8 km, got ${m}`);
});

test('resolveServedAxes cannot be outvoted by a majority of land substitutions', () => {
  // The Chesapeake case: a column whose MAJORITY are co-located land
  // substitutions. A plain plurality took the substituted coordinate and moved
  // the whole axis line 10.95 km off its request — beyond the 5.94 km physical
  // snap bound — destroying the two legitimate nodes and deforming the
  // bracketing lattice. Anchoring to the requested coordinate makes the vote
  // robust to any number of substitutions.
  const lats = [37.5, 38.0, 38.5];
  const lons = [-76.5, -76.0, -75.5];
  const snap = (v) => v - 0.041660;
  const servedLats = [];
  const servedLons = [];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      servedLats.push(snap(lats[i]));
      // Column 0: two legitimately snapped nodes, one substituted far east.
      // Column 1: a MAJORITY (2 of 3) substituted to the same distant cell.
      if (j === 0) servedLons.push(i === 2 ? snap(-76.5) + 0.25 : snap(-76.5));
      else if (j === 1) servedLons.push(i === 0 ? snap(-76.0) : snap(-76.0) + 0.25);
      else servedLons.push(snap(-75.5));
    }
  }
  const served = resolveServedAxes(servedLats, servedLons, { lats, lons });

  // Both axes stay within half a native cell of what was requested.
  const HALF_CELL_DEG = (1 / 12) / 2;
  served.lons.forEach((lon, j) => {
    assert.ok(Math.abs(lon - lons[j]) <= HALF_CELL_DEG,
      `axis ${j} moved ${(lon - lons[j]).toFixed(4)}° from its request, past the ${HALF_CELL_DEG.toFixed(4)}° bound`);
  });
  // Column 1's axis follows the single legitimate node, NOT the 2-vote majority.
  assert.ok(Math.abs(served.lons[1] - snap(-76.0)) < 1e-9);
  // The substituted nodes are dropped; the legitimate ones survive.
  assert.deepEqual(served.dropped.sort((a, b) => a - b), [4, 6, 7]);
});

test('resolveServedAxes falls back to the requested coordinate for a fully substituted line', () => {
  // Every node of column 1 came back from somewhere else, so there is no vote.
  // The axis entry must NOT invent a cell centre: a request on an exact cell
  // boundary has two equidistant centres and upstream's tie-break is not
  // derivable (for -122.0 it returned -122.04166, which round-half-up does not
  // reproduce). Every node on the line is dropped, so the entry only has to
  // keep the axis monotone and stay within half a cell of the truth.
  const lats = [36.3, 36.8];
  const lons = [-122.5, -122.0];
  const servedLats = [36.29, 36.29, 36.79, 36.79];
  const servedLons = [-122.54, -121.0, -122.54, -121.0]; // column 1 all substituted
  const served = resolveServedAxes(servedLats, servedLons, { lats, lons });
  assert.equal(served.lons[1], -122.0, 'no fabricated snap — the request stands');
  assert.ok(served.lons[1] > served.lons[0], 'the axis must stay strictly increasing');
  assert.deepEqual(served.dropped.sort((a, b) => a - b), [1, 3]);
});

// ── The A1 wiring, end to end ──────────────────────────────────────────────
// resolveServedAxes was tested in isolation, but nothing pinned that refreshGrid
// USES it: reverting `grid: gridAxes` to `grid: axes`, or deleting the blanking
// loop, left the entire suite green. These fail against either revert.

/** A normalized-upstream stand-in with a uniform snap and one substituted node. */
function normalizedGrid({ substituteNode = null } = {}) {
  const lats = [36.3, 36.8, 37.3];
  const lons = [-122.5, -122.0, -121.5];
  const dLat = -0.008336;
  const dLon = -0.041660;
  const servedLats = [];
  const servedLons = [];
  const nodes = [];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const node = i * 3 + j;
      const substituted = node === substituteNode;
      servedLats.push(lats[i] + dLat);
      servedLons.push(substituted ? lons[j] + 0.25 : lons[j] + dLon);
      nodes.push({
        waveHeightM: [1], currentKmh: [3.6], currentDirDeg: [90],
        windMs: [5], windDirDeg: [180],
      });
    }
  }
  return {
    axes: { lats, lons },
    grid: {
      hoursMs: [Date.UTC(2026, 8, 1, 0, 0)],
      nodes,
      servedLats,
      servedLons,
      windLats: servedLats.slice(),
      windLons: servedLons.slice(),
    },
    offsets: { dLat, dLon },
  };
}

test('georeferenceMarineGrid ships the SERVED lattice, not the requested one', () => {
  const { axes, grid, offsets } = normalizedGrid();
  const out = georeferenceMarineGrid(axes, grid, 9);
  // This is the assertion that reverting `grid: gridAxes` breaks.
  assert.notDeepEqual(out.grid.lons, axes.lons, 'the payload must not ship the requested lattice');
  out.grid.lats.forEach((lat, i) => assert.ok(Math.abs(lat - (axes.lats[i] + offsets.dLat)) < 1e-9));
  out.grid.lons.forEach((lon, j) => assert.ok(Math.abs(lon - (axes.lons[j] + offsets.dLon)) < 1e-9));
  // The requested lattice is still reported, so a consumer can see the offset.
  assert.deepEqual(out.requestedGrid, axes);
  assert.equal(out.validation.servedAxes, true);
  assert.equal(out.validation.nodesDropped, 0);
  // Snap distance is real and bounded by the 1/12° cell half-diagonal (5.94 km).
  assert.ok(out.validation.maxNodeSnapM > 3000 && out.validation.maxNodeSnapM < 5940,
    `expected a real sub-half-cell snap, got ${out.validation.maxNodeSnapM} m`);
});

test('georeferenceMarineGrid blanks a substituted node so the sampler NaN-gaps it', () => {
  const { axes, grid } = normalizedGrid({ substituteNode: 4 });
  const out = georeferenceMarineGrid(axes, grid, 9);
  assert.deepEqual(out.validation.droppedNodes, [4]);
  assert.equal(out.validation.nodesDropped, 1);
  // This is the assertion that deleting the blanking loop breaks: the node must
  // carry NO data, not a stranger's current.
  assert.deepEqual(out.nodes[4].currentKmh, []);
  assert.deepEqual(out.nodes[4].windMs, []);
  // Its neighbours are untouched.
  assert.deepEqual(out.nodes[3].currentKmh, [3.6]);
  // And a blanked node normalizes to NaN, not zero — verified through the real
  // consumer rather than asserted about it.
  const forcing = normalizeForcingGrid({
    grid: out.grid, hoursMs: out.hoursMs, nodes: out.nodes,
  });
  assert.ok(Number.isNaN(forcing.currentU[4]), 'a dropped node must be NaN, never 0');
  assert.ok(Number.isFinite(forcing.currentU[3]));
});

test('georeferenceMarineGrid falls back to requested axes when upstream echoes no coordinates', () => {
  const { axes, grid } = normalizedGrid();
  grid.servedLats = grid.servedLats.map(() => undefined);
  const out = georeferenceMarineGrid(axes, grid, 9);
  assert.equal(out.validation.servedAxes, false);
  assert.deepEqual(out.grid, axes);
  assert.equal(out.validation.maxNodeSnapM, 0);
});

/* ------------------------------------------------------------------ *
 * The middleware itself — dispatch, method and validation
 *
 * Every other test in this file calls a pure helper. That left the ROUTE
 * uncovered: its method check, its sub-path routing and its status codes were
 * asserted by nothing, which is how the `/field` box guard sat unreachable
 * behind a `if (!box)` that `normalizeBox` can never satisfy, answering 500 for
 * every malformed request. These drive the real plugin. They are network-free
 * by construction: each case is refused before any upstream fetch.
 * ------------------------------------------------------------------ */

/** Install the plugin and hand back the single `/api/ocean` handler. */
function oceanHandler() {
  let handler = null;
  const middlewares = {
    use(mount, fn) {
      assert.equal(mount, '/api/ocean');
      handler = fn;
    },
  };
  oceanProxy().configureServer({ middlewares });
  assert.equal(typeof handler, 'function', 'the plugin registered no handler');
  return handler;
}

/**
 * Call the handler as connect would: the mount path is already stripped from
 * `req.url`, so a request for `/api/ocean/field?x` arrives as `/field?x`.
 */
async function callOcean(subPath, { method = 'GET' } = {}) {
  const handler = oceanHandler();
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body ?? ''; },
  };
  await handler({ method, url: subPath, socket: {}, headers: {} }, res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

test('the ocean middleware refuses a non-GET and an unknown sub-path', async () => {
  assert.equal((await callOcean('/obs', { method: 'POST' })).status, 405);
  assert.equal((await callOcean('/nope')).status, 404);
});

test('/field answers 400 — not 500 — for every malformed box', async () => {
  // All five reproduce a real 500 measured against the running dev server
  // before the fix. `normalizeBox` refuses by throwing, so the handler's
  // falsiness test was dead code and the throw fell through to the outer catch.
  const cases = [
    ['', 'no bounds at all'],
    ['?latMin=abc&latMax=1&lonMin=2&lonMax=3', 'a non-numeric bound'],
    ['?latMin=40&latMax=30&lonMin=2&lonMax=3', 'latMax below latMin'],
    ['?latMin=30&latMax=40&lonMin=2&lonMax=2', 'a zero-width longitude span'],
    ['?latMin=-100&latMax=40&lonMin=2&lonMax=3', 'a latitude out of range'],
  ];
  for (const [query, why] of cases) {
    const { status, json } = await callOcean(`/field${query}`);
    assert.equal(status, 400, `${why} must be a 400, got ${status}`);
    assert.match(json.error, /latMin\/latMax\/lonMin\/lonMax/);
    assert.equal(typeof json.detail, 'string', 'the refusal says which bound was wrong');
  }
});

test('/field treats an OMITTED bound as missing, not as zero', async () => {
  // `Number(null) === 0` is finite, so reading bounds with a bare `Number(...)`
  // turned a request with no box into a zero-area rectangle on the Gulf of
  // Guinea instead of a refusal. The message must name the missing bound, not
  // a degenerate rectangle the caller never asked for.
  const { status, json } = await callOcean('/field?latMax=1&lonMin=2&lonMax=3');
  assert.equal(status, 400);
  assert.match(json.detail, /latMin is not a finite number/);
});

test('/marine, /marine-grid and /etopo answer 400 without valid coordinates', async () => {
  for (const route of ['/marine', '/marine-grid', '/etopo']) {
    assert.equal((await callOcean(route)).status, 400, `${route} with no coordinates`);
    assert.equal((await callOcean(`${route}?latitude=91&longitude=0`)).status, 400, `${route} past the pole`);
    assert.equal((await callOcean(`${route}?latitude=0&longitude=181`)).status, 400, `${route} past the antimeridian`);
  }
});
