/**
 * @file Offline, deterministic tests for `./hycomCurrents.js`. Every network
 * call goes through an injected `fetchImpl`; the one live test is guarded by
 * `GEV_LIVE_ENDPOINT_TESTS=1` so the default suite never touches the network.
 *
 * The fixtures in here are not invented: `DAS_FIXTURE` and `ASCII_4x4` are
 * trimmed copies of real bodies fetched from
 * tds.hycom.org/thredds/dodsC/FMRC_ESPC-D-V02_uv3z/FMRC_ESPC-D-V02_uv3z_best.ncd
 * on 2026-09-01, including the block ordering (water_v before water_u, which is
 * the server's `.dds` order and NOT the query order) and the Float32-precision
 * coordinate echo.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TARGET_CELLS,
  HYCOM_AXES,
  HYCOM_DATASET,
  HYCOM_RESPONSE_BYTE_CAP,
  HYCOM_TIMEOUT_MS,
  HYCOM_USER_AGENT,
  MAX_TARGET_CELLS,
  buildHycomUrl,
  chooseHycomStride,
  chooseHycomTimeIndex,
  fetchHycomCurrents,
  fetchHycomTimeAxis,
  hycomLatIndex,
  hycomLonIndex,
  hycomLonSegments,
  norm360,
  parseHycomAscii,
  parseHycomTimeEpoch,
  stitchHycomGrids,
  wrapLon180,
} from './hycomCurrents.js';

// ---------------------------------------------------------------------------
// Fixtures captured live on 2026-09-01
// ---------------------------------------------------------------------------

/** Trimmed real `.das`: the stanzas the epoch parser and descriptor depend on. */
const DAS_FIXTURE = `Attributes {
    water_u {
        String units "m/s";
        String standard_name "eastward_sea_water_velocity";
        Float32 actual_range -5.1330004, 4.5990005;
    }
    water_v {
        String units "m/s";
        String standard_name "northward_sea_water_velocity";
        Float32 actual_range -5.05, 4.262;
    }
    time_offset {
        String standard_name "forecast_period";
        String units "hours since 2099-01-01T00:00:00Z";
        Float64 missing_value NaN;
    }
    time {
        String long_name "Forecast time for ForecastModelRunCollection";
        String standard_name "time";
        String calendar "proleptic_gregorian";
        String units "hours since 2026-08-23 12:00:00.000 UTC";
        Float64 missing_value NaN;
        String _CoordinateAxisType "Time";
    }
    time_run {
        String standard_name "forecast_reference_time";
        String units "hours since 2088-01-01 00:00:00.000 UTC";
        Float64 missing_value NaN;
    }
    NC_GLOBAL {
        String distribution_statement "Approved for public release; distribution unlimited.";
        String institution "Fleet Numerical Meteorology and Oceanography Center (FNMOC)";
        String generating_model "ESPC-D V02: HYCOM 2.2.99, CICE 5.1.2, expt_03.1";
        String grid_name "glby0.08";
    }
}
`;

/** The epoch `DAS_FIXTURE` names: 2026-08-23T12:00:00Z. */
const EPOCH_MS = Date.UTC(2026, 7, 23, 12, 0, 0);
const HOUR_MS = 3600000;

/** Real `.ascii` body for a 4x4 two-variable request, verbatim. */
const ASCII_4x4 = `Dataset {
    Grid {
     ARRAY:
        Float32 water_v[time = 1][depth = 1][lat = 4][lon = 4];
     MAPS:
        Float64 time[time = 1];
        Float64 depth[depth = 1];
        Float64 lat[lat = 4];
        Float64 lon[lon = 4];
    } water_v;
    Grid {
     ARRAY:
        Float32 water_u[time = 1][depth = 1][lat = 4][lon = 4];
     MAPS:
        Float64 time[time = 1];
        Float64 depth[depth = 1];
        Float64 lat[lat = 4];
        Float64 lon[lon = 4];
    } water_u;
} FMRC_ESPC-D-V02_uv3z/FMRC_ESPC-D-V02_uv3z_best.ncd;
---------------------------------------------
water_v.water_v[1][1][4][4]
[0][0][0], -0.31100002, -0.29700002, -0.256, -0.192
[0][0][1], -0.316, -0.28500003, -0.24000001, -0.15900001
[0][0][2], -0.321, -0.27, -0.215, NaN
[0][0][3], -0.323, -0.24900001, -0.18900001, -0.12200001

water_v.time[1]
231.0

water_v.depth[1]
0.0

water_v.lat[4]
36.0, 36.040000915527344, 36.08000183105469, 36.119998931884766

water_v.lon[4]
237.52001953125, 237.5999755859375, 237.679931640625, 237.760009765625


water_u.water_u[1][1][4][4]
[0][0][0], 0.14600001, 0.15200001, 0.15, 0.141
[0][0][1], 0.134, 0.13000001, 0.115, 0.09200001
[0][0][2], 0.097, 0.105000004, 0.08800001, 0.032
[0][0][3], 0.056, 0.080000006, 0.058000002, -0.021000002

water_u.time[1]
231.0

water_u.depth[1]
0.0

water_u.lat[4]
36.0, 36.040000915527344, 36.08000183105469, 36.119998931884766

water_u.lon[4]
237.52001953125, 237.5999755859375, 237.679931640625, 237.760009765625
`;

/** Real `.ascii` body for the bare time axis, truncated to 5 steps. */
const ASCII_TIME = `Dataset {
    Float64 time[time = 5];
} FMRC_ESPC-D-V02_uv3z/FMRC_ESPC-D-V02_uv3z_best.ncd;
---------------------------------------------
time[5]
0.0, 3.0, 6.0, 9.0, 12.0
`;

/** Real TDS error payload, verbatim (served with HTTP 400). */
const ERROR_BODY = `Error {
    code = 3;
    message = "Invalid Parameter Exception: DArrayDimension.setProjection: Bad Projection Request: stop >= size: 999:121";
};
`;

// ---------------------------------------------------------------------------
// Body builders, emitting the exact real wire format
// ---------------------------------------------------------------------------

/**
 * Render a `.ascii` body in the server's real shape: blocks in `.dds` order
 * (water_v BEFORE water_u), MAPS echo after each ARRAY, blank-line separated,
 * and each component carrying its OWN time coordinate name — `water_u.time`
 * beside `water_v.time1`.
 *
 * That last detail is not cosmetic. The FMRC aggregation numbers the two time
 * axes apart, and a builder that emitted `time` for both let this whole file
 * pass green while `parseHycomAscii` rejected 100% of live responses. Captured
 * 2026-09-02 from `…_best.ncd.ascii`; the two axes are the same axis under two
 * names (max |time − time1| = 0 across all 129 steps), which is why
 * `timeMapFor` may vary the name while the parser's cross-component equality
 * check on the VALUE stays meaningful.
 */
const timeMapFor = (name) => (name === 'water_v' ? 'time1' : 'time');

function asciiBody({ lats, lons, u, v, timeValue = 231, depth = 0 }) {
  const nLat = lats.length;
  const nLon = lons.length;
  const decl = (name) => {
    const t = timeMapFor(name);
    return `    Grid {
     ARRAY:
        Float32 ${name}[${t} = 1][depth = 1][lat = ${nLat}][lon = ${nLon}];
     MAPS:
        Float64 ${t}[${t} = 1];
        Float64 depth[depth = 1];
        Float64 lat[lat = ${nLat}];
        Float64 lon[lon = ${nLon}];
    } ${name};`;
  };
  const block = (name, fn) => {
    const rows = [];
    for (let i = 0; i < nLat; i += 1) {
      const vals = [];
      for (let j = 0; j < nLon; j += 1) {
        const x = fn(i, j);
        vals.push(Number.isNaN(x) ? 'NaN' : String(x));
      }
      rows.push(`[0][0][${i}], ${vals.join(', ')}`);
    }
    return [
      `${name}.${name}[1][1][${nLat}][${nLon}]`,
      ...rows,
      '',
      `${name}.${timeMapFor(name)}[1]`,
      String(timeValue.toFixed(1)),
      '',
      `${name}.depth[1]`,
      depth.toFixed(1),
      '',
      `${name}.lat[${nLat}]`,
      lats.join(', '),
      '',
      `${name}.lon[${nLon}]`,
      lons.join(', '),
      '',
    ].join('\n');
  };
  return `Dataset {
${decl('water_v')}
${decl('water_u')}
} FMRC_ESPC-D-V02_uv3z/FMRC_ESPC-D-V02_uv3z_best.ncd;
---------------------------------------------
${block('water_v', v)}
${block('water_u', u)}`;
}

/** Exact served axes for one plan segment. */
function segmentAxes(segment, stride) {
  const { latOrigin, latStep, lonStep } = HYCOM_AXES;
  const lats = Array.from(
    { length: segment.nLat },
    (_, k) => latOrigin + (segment.latStart + k * stride) * latStep,
  );
  const lons = Array.from(
    { length: segment.nLon },
    (_, k) => (segment.lonStart + k * stride) * lonStep,
  );
  return { lats, lons };
}

/** A parsed-grid object of the shape `parseHycomAscii` returns. */
function grid({ lats, lons, fill = 1, timeValue = 231, depthM = 0 }) {
  const total = lats.length * lons.length;
  const u = new Float32Array(total).fill(fill);
  const v = new Float32Array(total).fill(-fill);
  return {
    lats: Float64Array.from(lats),
    lons: Float64Array.from(lons),
    u,
    v,
    finite: total,
    total,
    timeValue,
    depthM,
  };
}

/** Fetch double: `routes` maps a URL substring to a body string or a response. */
function fakeFetch(routes, log = []) {
  return async (url, options) => {
    log.push({ url, headers: options?.headers ?? {} });
    for (const [needle, value] of routes) {
      if (!url.includes(needle)) continue;
      if (typeof value === 'string') return { ok: true, status: 200, text: async () => value };
      return value;
    }
    return { ok: false, status: 404, text: async () => ERROR_BODY };
  };
}

/** A resolved time axis, so a test can skip the two probe requests. */
const TIME_AXIS = {
  epochMs: EPOCH_MS,
  unitMs: HOUR_MS,
  units: 'hours',
  hours: Float64Array.from(Array.from({ length: 121 }, (_, i) => i * 3)),
  count: 121,
  urls: [],
};

// ---------------------------------------------------------------------------
// Descriptor and constants
// ---------------------------------------------------------------------------

test('dataset descriptor is frozen and quotes the served metadata', () => {
  assert.ok(Object.isFrozen(HYCOM_DATASET));
  assert.ok(Object.isFrozen(HYCOM_AXES));
  assert.equal(HYCOM_DATASET.uVar, 'water_u');
  assert.equal(HYCOM_DATASET.vVar, 'water_v');
  assert.equal(HYCOM_DATASET.surfaceDepthIndex, 0);
  assert.equal(HYCOM_DATASET.resolutionDeg, 0.04);
  assert.equal(HYCOM_DATASET.resolutionLonDeg, 0.08);
  // The `.das` states a distribution statement and NO license attribute; the
  // descriptor must quote the former verbatim and say so rather than claiming
  // public domain.
  assert.equal(HYCOM_DATASET.license, 'Approved for public release; distribution unlimited.');
  assert.match(DAS_FIXTURE, /distribution_statement "Approved for public release; distribution unlimited\."/);
  assert.doesNotMatch(DAS_FIXTURE, /String license/);
  assert.match(HYCOM_DATASET.licenseNote, /declares no `license` attribute/);
  assert.match(HYCOM_DATASET.attribution, /Fleet Numerical Meteorology and Oceanography Center/);
  // The speed gate must admit the dataset's own declared extremes (-5.133).
  assert.ok(HYCOM_DATASET.maxSpeedMs > 5.1330004);
});

test('axis constants match the served geometry', () => {
  assert.equal(HYCOM_AXES.latOrigin, -80);
  assert.equal(HYCOM_AXES.latStep, 0.04);
  assert.equal(HYCOM_AXES.latCount, 4251);
  assert.equal(HYCOM_AXES.lonOrigin, 0);
  assert.equal(HYCOM_AXES.lonStep, 0.08);
  assert.equal(HYCOM_AXES.lonCount, 4500);
  // -80 + 4250*0.04 = 90, and 4499*0.08 = 359.92: the axes end where the .dds says.
  assert.ok(Math.abs((HYCOM_AXES.latOrigin + (HYCOM_AXES.latCount - 1) * HYCOM_AXES.latStep) - 90) < 1e-9);
  assert.ok(Math.abs((HYCOM_AXES.lonCount - 1) * HYCOM_AXES.lonStep - 359.92) < 1e-9);
});

test('budget and cap constants are consistent with the measured byte cost', () => {
  assert.equal(HYCOM_TIMEOUT_MS, 20000);
  assert.equal(HYCOM_RESPONSE_BYTE_CAP, 2 * 1024 * 1024);
  assert.equal(DEFAULT_TARGET_CELLS, 20000);
  assert.equal(MAX_TARGET_CELLS, 30000);
  // The design worst case is 28 B/cell (both components at full Float32 width).
  // The largest body the module can ask for must stay under the cap with room.
  assert.ok(MAX_TARGET_CELLS * 28 < HYCOM_RESPONSE_BYTE_CAP / 2);
  assert.match(HYCOM_USER_AGENT, /^gods-eye-view-[a-z-]+-proxy\/1\.0 /);
});

// ---------------------------------------------------------------------------
// Longitude normalization and index arithmetic
// ---------------------------------------------------------------------------

test('norm360 folds any longitude into [0, 360)', () => {
  assert.equal(norm360(0), 0);
  assert.equal(norm360(180), 180);
  assert.equal(norm360(-180), 180);
  // Folding is one addition and one modulo, so the result carries a rounding
  // step: -122.48 comes back as 237.52000000000004, not 237.52. That is well
  // inside a 1e-9 deg (0.1 mm) tolerance and 8 orders below one native cell.
  assert.ok(Math.abs(norm360(-122.48) - 237.52) < 1e-9);
  assert.equal(norm360(360), 0);
  assert.equal(norm360(-360), 0);
  // The IEEE-754 trap: ((-1e-15 % 360) + 360) % 360 is exactly 360, which would
  // index one past the end of the axis.
  assert.equal(norm360(-1e-15), 0);
  assert.ok(Number.isNaN(norm360(NaN)));
});

test('wrapLon180 folds any longitude into [-180, 180)', () => {
  assert.ok(Math.abs(wrapLon180(237.52) - -122.48) < 1e-9);
  assert.equal(wrapLon180(180), -180);
  assert.equal(wrapLon180(190), -170);
  assert.ok(Number.isNaN(wrapLon180(Infinity)));
});

test('hycomLatIndex reproduces served coordinates in both hemispheres', () => {
  // iLat = round((lat + 80) / 0.04); every one of these was read back live.
  assert.equal(hycomLatIndex(-80), 0);
  assert.equal(hycomLatIndex(36), 2900);
  assert.equal(hycomLatIndex(90), 4250);
  assert.equal(hycomLatIndex(4), 2100);
  assert.equal(hycomLatIndex(48), 3200);
  assert.equal(hycomLatIndex(72), 3800);
  // Southern hemisphere.
  assert.equal(hycomLatIndex(-60), 500);
  assert.equal(hycomLatIndex(-0.04), 1999);
  assert.equal(hycomLatIndex(0), 2000);
  // Outside the dataset's domain clamps to the edge rather than failing.
  assert.equal(hycomLatIndex(-90), 0);
  assert.equal(hycomLatIndex(95), 4250);
  assert.ok(Number.isNaN(hycomLatIndex(NaN)));
});

test('hycomLonIndex handles both conventions and the antimeridian', () => {
  // The axis is 0-360, so a -180..180 input must be folded first.
  assert.equal(hycomLonIndex(0), 0);
  assert.equal(hycomLonIndex(100), 1250);
  assert.equal(hycomLonIndex(237.52), 2969);
  assert.equal(hycomLonIndex(-122.48), 2969);
  assert.equal(hycomLonIndex(359.92), 4499);
  // The antimeridian sits at index 2250, mid-axis, and is NOT a discontinuity:
  // lon[2248..2252] came back as 179.84, 179.92, 180.0, 180.08, 180.16.
  assert.equal(hycomLonIndex(180), 2250);
  assert.equal(hycomLonIndex(-180), 2250);
  assert.equal(hycomLonIndex(179.92), 2249);
  assert.equal(hycomLonIndex(-179.92), 2251);
  // Consecutive indices across the antimeridian, proving contiguity.
  assert.equal(hycomLonIndex(-179.92) - hycomLonIndex(179.92), 2);
  // The seam is at the PRIME meridian: 4499 -> 0.
  assert.equal(hycomLonIndex(-0.08), 4499);
  assert.equal(hycomLonIndex(0.08), 1);
  assert.ok(Number.isNaN(hycomLonIndex(NaN)));
});

test('index snapping survives the inexactness of 0.04 and 0.08', () => {
  // (-79.96 + 80) / 0.04 evaluates to 1.0000000000001563, whose Math.ceil is 2.
  // A plan starting at -79.96 must still start at row 1.
  assert.equal(hycomLatIndex(-79.96), 1);
  const plan = chooseHycomStride({
    latMin: -79.96, latMax: -79.96, lonMin: 0, lonMax: 0,
  }, 100);
  assert.equal(plan.latStart, 1);
  assert.equal(plan.nLat, 1);
});

// ---------------------------------------------------------------------------
// Segment planning: the seam is the prime meridian, not the antimeridian
// ---------------------------------------------------------------------------

test('a box crossing the ANTIMERIDIAN needs no split on a 0-360 axis', () => {
  const plan = hycomLonSegments({ lonMin: 179, lonMax: -179 }, 1);
  // 179 -> -179 travelling east is a 2 deg box, not a -358 deg one.
  assert.equal(plan.crossesSeam, false);
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].start, 2237); // floor(179/0.08) = floor(2237.5)
  assert.equal(plan.nLon, 27); // ceil(181/0.08)=2263, 2263-2237+1
  assert.equal(plan.segments[0].count, 27);
});

test('a box crossing the PRIME MERIDIAN splits into two ranges on one phase', () => {
  const plan = hycomLonSegments({ lonMin: -1, lonMax: 1 }, 1);
  assert.equal(plan.crossesSeam, true);
  assert.equal(plan.segments.length, 2);
  // West runs 4487..4499 (13 columns), east continues the progression at 0.
  assert.deepEqual(plan.segments[0], { start: 4487, count: 13 });
  assert.deepEqual(plan.segments[1], { start: 0, count: 14 });
  assert.equal(plan.nLon, 27);
});

test('seam phase continuity holds at a coarse stride', () => {
  const stride = 7;
  const plan = hycomLonSegments({ lonMin: -1, lonMax: 1 }, stride);
  assert.equal(plan.crossesSeam, true);
  const [west, east] = plan.segments;
  const lastWest = west.start + (west.count - 1) * stride;
  // The next index in the single progression, unwrapped by one revolution, is
  // exactly where the eastern segment starts: the seam gap is one stride, not a
  // short column.
  assert.equal(east.start, lastWest + stride - HYCOM_AXES.lonCount);
  assert.ok(east.start >= 0 && east.start < stride);
});

test('a whole-globe box covers the axis exactly once and wraps once', () => {
  const plan = hycomLonSegments({ lonMin: -180, lonMax: 180 }, 1);
  assert.equal(plan.nativeCount, HYCOM_AXES.lonCount); // never more than one revolution
  assert.equal(plan.nLon, HYCOM_AXES.lonCount);
  assert.equal(plan.crossesSeam, true);
  assert.equal(plan.segments[0].start, 2250); // starts at the caller's own -180
  assert.equal(plan.segments[0].count + plan.segments[1].count, HYCOM_AXES.lonCount);
});

test('hycomLonSegments refuses unusable input', () => {
  assert.equal(hycomLonSegments({ lonMin: NaN, lonMax: 1 }, 1), null);
  assert.equal(hycomLonSegments({ lonMin: 0, lonMax: 1 }, 0), null);
  assert.equal(hycomLonSegments({ lonMin: 0, lonMax: 1 }, 1.5), null);
});

// ---------------------------------------------------------------------------
// Stride selection
// ---------------------------------------------------------------------------

test('chooseHycomStride: a 1x1 deg box fits natively at stride 1', () => {
  const plan = chooseHycomStride({
    latMin: 36, latMax: 37, lonMin: -122.5, lonMax: -121.5,
  }, DEFAULT_TARGET_CELLS);
  assert.equal(plan.stride, 1);
  assert.equal(plan.latStart, 2900);
  assert.equal(plan.nLat, 26); // 1 deg / 0.04 = 25 gaps
  assert.equal(plan.nLon, 15); // 1 deg / 0.08, both edges snapped outward
  assert.equal(plan.cells, 390);
  assert.equal(plan.latCellDeg, 0.04);
  assert.equal(plan.lonCellDeg, 0.08);
  assert.equal(plan.crossesSeam, false);
  assert.equal(plan.segments.length, 1);
});

test('chooseHycomStride: whole globe lands on the finest stride under budget', () => {
  const plan = chooseHycomStride({
    latMin: -90, latMax: 90, lonMin: -180, lonMax: 180,
  }, 20000);
  // nLat(s) = floor(4250/s)+1 over the clamped axis, nLon(s) = floor(4499/s)+1.
  // s=31 gives 138*146 = 20148 (over); s=32 gives 133*141 = 18753 (fits).
  assert.equal(plan.stride, 32);
  assert.equal(plan.nLat, 133);
  assert.equal(plan.nLon, 141);
  assert.equal(plan.cells, 18753);
  assert.ok(plan.cells <= 20000);
  assert.equal(plan.crossesSeam, true);
  assert.equal(plan.segments.length, 2);
  assert.equal(plan.segments[0].nLon + plan.segments[1].nLon, plan.nLon);
});

test('chooseHycomStride is monotone: a smaller budget never yields a finer stride', () => {
  const box = { latMin: 20, latMax: 50, lonMin: -80, lonMax: -40 };
  let previous = 0;
  for (const budget of [30000, 20000, 10000, 5000, 1000, 200, 50]) {
    const plan = chooseHycomStride(box, budget);
    assert.ok(plan.cells <= Math.min(budget, MAX_TARGET_CELLS));
    assert.ok(plan.stride >= previous);
    previous = plan.stride;
  }
});

test('chooseHycomStride clamps an oversized budget and refuses nonsense', () => {
  const plan = chooseHycomStride({
    latMin: -90, latMax: 90, lonMin: -180, lonMax: 180,
  }, 1e9);
  assert.equal(plan.targetCells, MAX_TARGET_CELLS);
  assert.equal(chooseHycomStride({ latMin: 10, latMax: 0, lonMin: 0, lonMax: 1 }), null);
  assert.equal(chooseHycomStride({ latMin: NaN, latMax: 1, lonMin: 0, lonMax: 1 }), null);
  assert.equal(chooseHycomStride({ latMin: 0, latMax: 1, lonMin: 0, lonMax: 1 }, 0), null);
  // A budget below the coarsest grid still returns a usable 1-2 cell plan.
  const tiny = chooseHycomStride({ latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 }, 1);
  assert.ok(tiny.cells >= 1);
});

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

test('buildHycomUrl percent-encodes brackets, pins depth 0 and applies the stride', () => {
  const url = buildHycomUrl({
    timeIndex: 77, latStart: 2900, nLat: 4, lonStart: 2969, nLon: 4, stride: 1,
  });
  assert.ok(url.startsWith(`${HYCOM_DATASET.base}.ascii?`));
  // Brackets MUST be escaped; colons and commas must NOT be.
  assert.ok(!url.includes('['));
  assert.ok(!url.includes(']'));
  assert.ok(url.includes('%5B') && url.includes('%5D'));
  assert.ok(url.includes(':1:'));
  assert.ok(url.includes(','));
  // Depth pinned to the surface, time to one step, stop indices INCLUSIVE.
  const decoded = decodeURIComponent(url);
  assert.ok(decoded.includes('water_u[77:1:77][0:1:0][2900:1:2903][2969:1:2972]'));
  assert.ok(decoded.includes('water_v[77:1:77][0:1:0][2900:1:2903][2969:1:2972]'));
});

test('buildHycomUrl emits stop = start + (count-1)*stride', () => {
  const decoded = decodeURIComponent(buildHycomUrl({
    timeIndex: 0, latStart: 2900, nLat: 141, lonStart: 2969, nLon: 141, stride: 4,
  }));
  // 2900 + 140*4 = 3460; 2969 + 140*4 = 3529. Exactly the live request that
  // returned a 141x141 grid.
  assert.ok(decoded.includes('[2900:4:3460][2969:4:3529]'));
});

test('buildHycomUrl refuses a slab that crosses the 0-360 seam or leaves an axis', () => {
  assert.throws(
    () => buildHycomUrl({ timeIndex: 0, latStart: 4490, nLat: 20, lonStart: 0, nLon: 2 }),
    /latitude slab .* leaves the 4251-row axis/,
  );
  assert.throws(
    () => buildHycomUrl({ timeIndex: 0, latStart: 0, nLat: 2, lonStart: 4490, nLon: 20 }),
    /crosses the 0-360 seam/,
  );
  assert.throws(() => buildHycomUrl({
    timeIndex: 0, latStart: 0, nLat: 2, lonStart: 0, nLon: 2, stride: 0,
  }), /stride must be a positive integer/);
  assert.throws(() => buildHycomUrl({
    timeIndex: 1.5, latStart: 0, nLat: 2, lonStart: 0, nLon: 2,
  }), /timeIndex must be an integer/);
  assert.throws(() => buildHycomUrl({
    timeIndex: 0, latStart: 0, nLat: 2, lonStart: 0, nLon: 2, ext: 'nc',
  }), /unsupported ext/);
});

test('every plan segment builds a legal URL, seam-crossing box included', () => {
  const plan = chooseHycomStride({
    latMin: -80, latMax: 80, lonMin: -30, lonMax: 30,
  }, DEFAULT_TARGET_CELLS);
  assert.equal(plan.crossesSeam, true);
  for (const segment of plan.segments) {
    const url = buildHycomUrl({ timeIndex: 3, stride: plan.stride, ...segment });
    assert.ok(url.includes('water_u'));
  }
});

// ---------------------------------------------------------------------------
// Parsing the real ascii format
// ---------------------------------------------------------------------------

test('parseHycomAscii reads the real 4x4 body, MAPS echo and NaN land cells', () => {
  const parsed = parseHycomAscii(ASCII_4x4);
  assert.ok(parsed);
  assert.equal(parsed.total, 16);
  // Coordinates come from the MAPS echo, at the Float32 precision they arrived
  // in — NOT from anything the caller requested.
  assert.equal(parsed.lats.length, 4);
  assert.equal(parsed.lats[0], 36.0);
  assert.equal(parsed.lats[1], 36.040000915527344);
  assert.equal(parsed.lons[0], 237.52001953125);
  assert.equal(parsed.lons[3], 237.760009765625);
  // Longitudes stay in the dataset's own 0-360 frame at this stage.
  assert.ok(parsed.lons.every((x) => x >= 0 && x < 360));
  assert.equal(parsed.timeValue, 231);
  assert.equal(parsed.depthM, 0);
  // The land cell is water_v row 2 column 3; both components must go NaN.
  const land = 2 * 4 + 3;
  assert.ok(Number.isNaN(parsed.v[land]));
  assert.ok(Number.isNaN(parsed.u[land]), 'a half vector must be no vector');
  assert.equal(parsed.finite, 15);
  assert.equal(parsed.total - parsed.finite, 1);
});

test('parseHycomAscii keys blocks by NAME, not by position', () => {
  // The real server emits water_v FIRST even for a `water_u,water_v` query. A
  // positional parser would swap the components and rotate the field 90 deg.
  const parsed = parseHycomAscii(ASCII_4x4);
  // Row 0, column 0: water_u is +0.14600001 (eastward), water_v is -0.31100002.
  assert.ok(Math.abs(parsed.u[0] - 0.14600001) < 1e-7);
  assert.ok(Math.abs(parsed.v[0] - -0.31100002) < 1e-7);
  assert.ok(parsed.u[0] > 0 && parsed.v[0] < 0);
  // Sanity: the body really does put water_v first.
  assert.ok(ASCII_4x4.indexOf('water_v.water_v[') < ASCII_4x4.indexOf('water_u.water_u['));
});

test('parseHycomAscii is row-major, matching a directly computed reference', () => {
  const nLat = 5;
  const nLon = 7;
  // Dyadic values, exact in Float32, so the comparison needs no tolerance. The
  // `+ 1` on v keeps it away from -0, which the wire format writes as "0" and
  // which `assert.equal` distinguishes from the -0 a reference would compute.
  const uRef = (i, j) => (i * 8 + j) / 16;
  const vRef = (i, j) => -(i * 8 + j + 1) / 32;
  const lats = Array.from({ length: nLat }, (_, i) => 10 + i * 0.04);
  const lons = Array.from({ length: nLon }, (_, j) => 200 + j * 0.08);
  const parsed = parseHycomAscii(asciiBody({
    lats, lons, u: uRef, v: vRef,
  }));
  assert.ok(parsed);
  assert.equal(parsed.total, nLat * nLon);
  for (let i = 0; i < nLat; i += 1) {
    for (let j = 0; j < nLon; j += 1) {
      // The contract: u[latIndex * lons.length + lonIndex].
      assert.equal(parsed.u[i * nLon + j], uRef(i, j), `u at (${i},${j})`);
      assert.equal(parsed.v[i * nLon + j], vRef(i, j), `v at (${i},${j})`);
    }
  }
  // Data rows run across LONGITUDE: consecutive memory is consecutive lon.
  assert.equal(parsed.u[1] - parsed.u[0], 1 / 16);
  assert.equal(parsed.u[nLon] - parsed.u[0], 8 / 16);
});

test('parseHycomAscii maps out-of-envelope values to NaN without substituting', () => {
  const lats = [10, 10.04];
  const lons = [200, 200.08];
  const parsed = parseHycomAscii(asciiBody({
    lats,
    lons,
    // 99 m/s is far outside the declared actual_range: a corrupt spike.
    u: (i, j) => (i === 0 && j === 0 ? 99 : 0.5),
    v: () => 0.25,
  }));
  assert.ok(parsed);
  assert.ok(Number.isNaN(parsed.u[0]));
  assert.ok(Number.isNaN(parsed.v[0]), 'both components drop together');
  assert.equal(parsed.finite, 3);
  // Nothing was substituted for the hole.
  assert.equal(parsed.u[1], 0.5);
});

test('parseHycomAscii returns null on shape drift, never an empty grid', () => {
  const lats = [10, 10.04, 10.08];
  const lons = [200, 200.08];
  const good = asciiBody({ lats, lons, u: () => 0.5, v: () => 0.25 });
  assert.ok(parseHycomAscii(good));

  // Row count disagreeing with the declared dims.
  assert.equal(parseHycomAscii(good.replace('[0][0][2], 0.5, 0.5\n', '')), null,
    'a missing data row must fail, not shrink the grid');
  // Value count disagreeing with the declared dims.
  assert.equal(parseHycomAscii(good.replace('[0][0][1], 0.5, 0.5', '[0][0][1], 0.5')), null);
  // Row index out of sequence.
  assert.equal(parseHycomAscii(good.replace('[0][0][1], 0.5, 0.5', '[0][0][9], 0.5, 0.5')), null);
  // Non-numeric coordinate: `Number('')` is 0, so a lenient parse would place a
  // column on the prime meridian.
  assert.equal(parseHycomAscii(good.replace('200, 200.08', '200, ')), null);
  assert.equal(parseHycomAscii(good.replace('200, 200.08', '200, abc')), null);
  // Missing MAPS block.
  assert.equal(parseHycomAscii(good.replace(/water_u\.lon\[2\]\n[^\n]*\n/, '')), null);
  assert.equal(parseHycomAscii(good.replace(/water_u\.lat\[3\]\n[^\n]*\n/, '')), null);
  // A whole variable missing.
  assert.equal(parseHycomAscii(good.replace(/water_u\.water_u\[1\]\[1\]\[3\]\[2\]/, 'other.other[1][1][3][2]')), null);
  // No dashed separator.
  assert.equal(parseHycomAscii(good.replace(/^-{3,}$/m, '')), null);
});

test('parseHycomAscii refuses a body served from a level that is not the surface', () => {
  const lats = [10, 10.04];
  const lons = [200, 200.08];
  const deep = asciiBody({
    lats, lons, u: () => 0.5, v: () => 0.25, depth: 30,
  });
  // Drawing the 30 m flow as the surface flow is exactly the silent
  // substitution this module exists to prevent.
  assert.equal(parseHycomAscii(deep), null);
});

test('parseHycomAscii refuses components that disagree about the grid or the time', () => {
  const lats = [10, 10.04];
  const lons = [200, 200.08];
  const body = asciiBody({ lats, lons, u: () => 0.5, v: () => 0.25 });
  // Shift only water_u's lon echo: the two components no longer describe the
  // same cells, so they are not a vector field.
  const skewed = body.replace(
    /water_u\.lon\[2\]\n200, 200\.08/,
    'water_u.lon[2]\n201, 201.08',
  );
  assert.equal(parseHycomAscii(skewed), null);
  // Different time stamps between the components.
  const mistimed = body.replace(/water_u\.time\[1\]\n231\.0/, 'water_u.time[1]\n234.0');
  assert.equal(parseHycomAscii(mistimed), null);
});

test('parseHycomAscii rejects error payloads, HTML and junk', () => {
  assert.equal(parseHycomAscii(ERROR_BODY), null);
  assert.equal(parseHycomAscii('<html><body>502</body></html>'), null);
  assert.equal(parseHycomAscii(''), null);
  assert.equal(parseHycomAscii('   '), null);
  assert.equal(parseHycomAscii(null), null);
  assert.equal(parseHycomAscii(undefined), null);
  assert.equal(parseHycomAscii(42), null);
});

// ---------------------------------------------------------------------------
// Longitude conversion and stitching
// ---------------------------------------------------------------------------

test('stitchHycomGrids re-anchors a normal box into [-180, 180), ascending', () => {
  // Served 237.52..237.76 is the Monterey coast at -122.48..-122.24.
  const lons = [237.52, 237.6, 237.68, 237.76];
  const out = stitchHycomGrids([grid({ lats: [36, 36.04], lons })], 0.08);
  assert.ok(out);
  assert.equal(out.lons.length, 4);
  for (let j = 0; j < 4; j += 1) {
    assert.ok(Math.abs(out.lons[j] - (lons[j] - 360)) < 1e-9);
    assert.ok(out.lons[j] >= -180 && out.lons[j] < 180);
  }
  for (let j = 1; j < 4; j += 1) assert.ok(out.lons[j] > out.lons[j - 1], 'strictly ascending');
});

test('stitchHycomGrids unwraps a PRIME MERIDIAN crossing into an ascending -180..180 axis', () => {
  // West half 359.84..359.92, east half 0..0.08: the 0-360 seam.
  const west = grid({ lats: [10, 10.04], lons: [359.84, 359.92], fill: 1 });
  const east = grid({ lats: [10, 10.04], lons: [0, 0.08], fill: 2 });
  const out = stitchHycomGrids([west, east], 0.08);
  assert.ok(out);
  assert.equal(out.lons.length, 4);
  // 359.84, 359.92, 360, 360.08 -> shifted by -360.
  const expected = [-0.16, -0.08, 0, 0.08];
  for (let j = 0; j < 4; j += 1) assert.ok(Math.abs(out.lons[j] - expected[j]) < 1e-9);
  for (let j = 1; j < 4; j += 1) assert.ok(out.lons[j] > out.lons[j - 1], 'strictly ascending');
  assert.ok(out.lons.every((x) => x >= -180 && x < 180));
  // Payloads land in the right halves of each row.
  assert.equal(out.u[0], 1);
  assert.equal(out.u[2], 2);
  assert.equal(out.u[4], 1); // row 1 restarts with the western half
  assert.equal(out.u[6], 2);
});

test('stitchHycomGrids leaves an ANTIMERIDIAN box ascending past +180', () => {
  // A rectangle spanning 180 has no ascending representation inside
  // [-180, 180); the axis is allowed to continue, matching stitchGlobalCurrents.
  const lons = [179.84, 179.92, 180, 180.08];
  const out = stitchHycomGrids([grid({ lats: [10], lons })], 0.08);
  assert.ok(out);
  for (let j = 0; j < 4; j += 1) assert.ok(Math.abs(out.lons[j] - lons[j]) < 1e-9);
  for (let j = 1; j < 4; j += 1) assert.ok(out.lons[j] > out.lons[j - 1], 'strictly ascending');
  assert.ok(out.lons[3] > 180, 'the overhang is preserved, not folded');
});

test('stitchHycomGrids refuses a seam that is not one stride', () => {
  const west = grid({ lats: [10], lons: [359.84, 359.92] });
  // A gap of 0.16 at the seam means a column was dropped upstream.
  const east = grid({ lats: [10], lons: [0.08, 0.16] });
  assert.equal(stitchHycomGrids([west, east], 0.08), null);
});

test('stitchHycomGrids refuses halves that cannot belong to one grid', () => {
  const a = grid({ lats: [10, 10.04], lons: [359.92] });
  assert.equal(stitchHycomGrids([a, grid({ lats: [11, 11.04], lons: [0] })], 0.08), null,
    'differing latitude axes');
  assert.equal(stitchHycomGrids([a, grid({ lats: [10, 10.04], lons: [0], timeValue: 234 })], 0.08), null,
    'differing time values');
  assert.equal(stitchHycomGrids([], 0.08), null);
  assert.equal(stitchHycomGrids([a, null], 0.08), null);
  assert.equal(stitchHycomGrids([a], NaN), null);
  // A hand-built half with a payload that disagrees with its own axes.
  const broken = { ...a, u: new Float32Array(1), v: new Float32Array(1) };
  assert.equal(stitchHycomGrids([broken], 0.08), null);
  // Plain arrays instead of typed arrays must fail, not throw.
  assert.equal(stitchHycomGrids([{ ...a, u: [1, 2], v: [1, 2] }], 0.08), null);
});

// ---------------------------------------------------------------------------
// Time: epoch parsing and step selection
// ---------------------------------------------------------------------------

test('parseHycomTimeEpoch reads the real space-and-UTC units string', () => {
  const epoch = parseHycomTimeEpoch(DAS_FIXTURE);
  assert.ok(epoch);
  // `hours since 2026-08-23 12:00:00.000 UTC` is NOT a format Date.parse
  // accepts; the parser must normalize it.
  assert.equal(epoch.epochMs, EPOCH_MS);
  assert.equal(epoch.unitMs, HOUR_MS);
  assert.equal(epoch.units, 'hours');
  assert.equal(epoch.raw, 'hours since 2026-08-23 12:00:00.000 UTC');
  // V8 happens to accept `2026-08-23 12:00:00.000 UTC` through its non-standard
  // fallback parser, but that is an implementation detail of one engine and not
  // part of ECMA-262's Date Time String Format. The normalizer rewrites the
  // stamp to the ISO form the spec does guarantee, so the epoch does not depend
  // on that leniency.
  const normalized = '2026-08-23T12:00:00.000Z';
  assert.equal(Date.parse(normalized), EPOCH_MS);
  assert.equal(epoch.epochMs, Date.parse(normalized));
});

test('parseHycomTimeEpoch takes the `time` stanza, not `time_run` or `time_offset`', () => {
  const epoch = parseHycomTimeEpoch(DAS_FIXTURE);
  // time_offset says 2099 and time_run says 2088; both must be ignored.
  assert.equal(epoch.epochMs, EPOCH_MS);
  assert.notEqual(epoch.epochMs, Date.UTC(2099, 0, 1));
  assert.notEqual(epoch.epochMs, Date.UTC(2088, 0, 1));
});

test('parseHycomTimeEpoch accepts the ISO form and defaults to UTC', () => {
  const iso = parseHycomTimeEpoch('x {\n}\ntime {\n    String units "hours since 2026-08-23T12:00:00Z";\n}\n');
  assert.equal(iso.epochMs, EPOCH_MS);
  const bare = parseHycomTimeEpoch('time {\n    String units "hours since 2026-08-23 12:00:00";\n}\n');
  assert.equal(bare.epochMs, EPOCH_MS);
  const days = parseHycomTimeEpoch('time {\n    String units "days since 2026-08-23T12:00:00Z";\n}\n');
  assert.equal(days.unitMs, 24 * HOUR_MS);
});

test('parseHycomTimeEpoch returns null rather than guessing an epoch', () => {
  assert.equal(parseHycomTimeEpoch(''), null);
  assert.equal(parseHycomTimeEpoch(null), null);
  assert.equal(parseHycomTimeEpoch('Attributes {\n}\n'), null, 'no time stanza');
  assert.equal(parseHycomTimeEpoch('time {\n    String long_name "t";\n}\n'), null, 'no units');
  assert.equal(parseHycomTimeEpoch('time {\n    String units "hours since not-a-date";\n}\n'), null);
  // An interval this module does not handle is a contract change, not something
  // to approximate as hours.
  assert.equal(parseHycomTimeEpoch('time {\n    String units "fortnights since 2026-08-23T12:00:00Z";\n}\n'), null);
});

test('chooseHycomTimeIndex picks the nearest step, forecast included', () => {
  const hours = Float64Array.from([0, 3, 6, 9, 12]);
  const epoch = { epochMs: EPOCH_MS, unitMs: HOUR_MS };
  // Exactly on a step.
  assert.equal(chooseHycomTimeIndex(EPOCH_MS + 6 * HOUR_MS, epoch, hours).index, 2);
  // 1 h past step 2 -> still nearest step 2.
  assert.equal(chooseHycomTimeIndex(EPOCH_MS + 7 * HOUR_MS, epoch, hours).index, 2);
  // 2 h past step 2 -> nearest is step 3, which is 1 h in the FUTURE of the
  // requested instant. Nearest, not nearest-at-or-before.
  const ahead = chooseHycomTimeIndex(EPOCH_MS + 8 * HOUR_MS, epoch, hours);
  assert.equal(ahead.index, 3);
  assert.ok(ahead.validAtMs > EPOCH_MS + 8 * HOUR_MS, 'the chosen step is in the future');
});

test('chooseHycomTimeIndex clamps to the axis and never runs past the last step', () => {
  const hours = Float64Array.from([0, 3, 6, 9, 12]);
  const epoch = { epochMs: EPOCH_MS, unitMs: HOUR_MS };
  const far = chooseHycomTimeIndex(EPOCH_MS + 1000 * HOUR_MS, epoch, hours);
  assert.equal(far.index, 4);
  assert.equal(far.clamped, true);
  assert.equal(far.validAtMs, EPOCH_MS + 12 * HOUR_MS);
  const before = chooseHycomTimeIndex(EPOCH_MS - 1000 * HOUR_MS, epoch, hours);
  assert.equal(before.index, 0);
  assert.equal(before.clamped, true);
  assert.equal(chooseHycomTimeIndex(NaN, epoch, hours), null);
  assert.equal(chooseHycomTimeIndex(EPOCH_MS, epoch, []), null);
  assert.equal(chooseHycomTimeIndex(EPOCH_MS, null, hours), null);
});

// ---------------------------------------------------------------------------
// Time-axis probe
// ---------------------------------------------------------------------------

test('fetchHycomTimeAxis reads the epoch from .das and the steps from .ascii', () => {
  const log = [];
  const fetchImpl = fakeFetch([['.das', DAS_FIXTURE], ['.ascii?time', ASCII_TIME]], log);
  return fetchHycomTimeAxis({ fetchImpl }).then((axis) => {
    assert.ok(axis);
    assert.equal(axis.epochMs, EPOCH_MS);
    assert.equal(axis.unitMs, HOUR_MS);
    assert.equal(axis.count, 5);
    assert.deepEqual([...axis.hours], [0, 3, 6, 9, 12]);
    assert.equal(log.length, 2);
    // The descriptive User-Agent goes on every request.
    for (const entry of log) assert.equal(entry.headers['User-Agent'], HYCOM_USER_AGENT);
  });
});

test('fetchHycomTimeAxis returns null on any upstream failure', async () => {
  const bad = { ok: false, status: 500, text: async () => 'boom' };
  assert.equal(await fetchHycomTimeAxis({
    fetchImpl: fakeFetch([['.das', bad], ['.ascii?time', ASCII_TIME]]),
  }), null);
  assert.equal(await fetchHycomTimeAxis({
    fetchImpl: fakeFetch([['.das', DAS_FIXTURE], ['.ascii?time', 'garbage']]),
  }), null);
  assert.equal(await fetchHycomTimeAxis({
    fetchImpl: fakeFetch([['.das', 'Attributes {\n}\n'], ['.ascii?time', ASCII_TIME]]),
  }), null);
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

/** Serve any plan segment with a constant field, in the real wire format. */
function planFetch(plan, { timeValue = 231, log = [] } = {}) {
  return async (url, options) => {
    log.push({ url, headers: options?.headers ?? {} });
    if (url.includes('.das')) return { ok: true, status: 200, text: async () => DAS_FIXTURE };
    if (url.includes('.ascii?time')) {
      const hours = Array.from({ length: 121 }, (_, i) => `${(i * 3).toFixed(1)}`).join(', ');
      return {
        ok: true,
        status: 200,
        text: async () => `Dataset {\n    Float64 time[time = 121];\n} x;\n`
          + `---------------------------------------------\ntime[121]\n${hours}\n`,
      };
    }
    const decoded = decodeURIComponent(url);
    const segment = plan.segments.find((s) => decoded.includes(`[${s.lonStart}:${plan.stride}:`));
    if (!segment) return { ok: false, status: 404, text: async () => ERROR_BODY };
    const { lats, lons } = segmentAxes(segment, plan.stride);
    return {
      ok: true,
      status: 200,
      text: async () => asciiBody({
        lats, lons, u: () => 0.25, v: () => -0.5, timeValue,
      }),
    };
  };
}

test('fetchHycomCurrents returns the drop-in shape fieldGrid.js consumes', async () => {
  const box = {
    latMin: 36, latMax: 37, lonMin: -122.5, lonMax: -121.5,
  };
  const plan = chooseHycomStride(box, DEFAULT_TARGET_CELLS);
  const nowMs = EPOCH_MS + 231 * HOUR_MS; // exactly on step 77
  const out = await fetchHycomCurrents({
    box, fetchImpl: planFetch(plan), nowMs, timeAxis: TIME_AXIS,
  });

  // Grid contract.
  assert.equal(out.lats.length, plan.nLat);
  assert.equal(out.lons.length, plan.nLon);
  assert.equal(out.u.length, plan.nLat * plan.nLon);
  assert.ok(out.u instanceof Float32Array);
  assert.ok(out.v instanceof Float32Array);
  assert.equal(out.total, plan.cells);
  assert.equal(out.finite, plan.cells);
  assert.equal(out.u[0], 0.25);
  assert.equal(out.v[0], -0.5);
  // Longitude converted into -180..180 and strictly ascending.
  for (let j = 1; j < out.lons.length; j += 1) assert.ok(out.lons[j] > out.lons[j - 1]);
  assert.ok(out.lons[0] >= -180 && out.lons[out.lons.length - 1] < 180);
  assert.ok(Math.abs(out.lons[0] - -122.56) < 1e-9);
  // Latitude ascending, on the native grid.
  for (let i = 1; i < out.lats.length; i += 1) assert.ok(out.lats[i] > out.lats[i - 1]);
  assert.ok(Math.abs(out.lats[0] - 36) < 1e-9);

  // Source contract: every field fieldGrid.js reads.
  const s = out.source;
  assert.equal(s.datasetId, HYCOM_DATASET.id);
  assert.equal(s.validAtMs, nowMs);
  assert.equal(s.ageMs, 0);
  assert.equal(s.stride, plan.stride);
  assert.equal(s.cells, plan.cells);
  assert.equal(s.coverage, 1);
  assert.equal(s.crossesSeam, false);
  assert.equal(s.label, HYCOM_DATASET.label);
  assert.equal(s.attribution, HYCOM_DATASET.attribution);
  assert.equal(s.license, HYCOM_DATASET.license);
  assert.ok(typeof s.note === 'string' && s.note.length > 0);
  assert.equal(s.url, s.urls[0]);
  assert.equal(s.urls.length, 1);
  // resolutionDeg is the MERIDIONAL step, because fieldGrid converts it with
  // metresPerDegLat; the zonal step is reported separately.
  assert.ok(Math.abs(s.resolutionDeg - 0.04) < 1e-9);
  assert.ok(Math.abs(s.resolutionLonDeg - 0.08) < 1e-9);
  assert.equal(s.nativeResolutionDeg, 0.04);
});

test('fetchHycomCurrents stitches a prime-meridian crossing into one ascending grid', async () => {
  const box = {
    latMin: 10, latMax: 11, lonMin: -1, lonMax: 1,
  };
  const plan = chooseHycomStride(box, DEFAULT_TARGET_CELLS);
  assert.equal(plan.crossesSeam, true);
  assert.equal(plan.segments.length, 2);
  const out = await fetchHycomCurrents({
    box, fetchImpl: planFetch(plan), nowMs: EPOCH_MS + 231 * HOUR_MS, timeAxis: TIME_AXIS,
  });
  assert.equal(out.source.urls.length, 2, 'two index ranges, two requests');
  assert.equal(out.source.crossesSeam, true);
  assert.equal(out.lons.length, plan.nLon);
  for (let j = 1; j < out.lons.length; j += 1) {
    assert.ok(out.lons[j] > out.lons[j - 1], `ascending at ${j}`);
  }
  assert.ok(out.lons.every((x) => x >= -180 && x < 180));
  // The box really does straddle zero.
  assert.ok(out.lons[0] < 0 && out.lons[out.lons.length - 1] > 0);
  assert.equal(out.total, plan.cells);
});

test('fetchHycomCurrents serves an antimeridian box in ONE request', async () => {
  const box = {
    latMin: 10, latMax: 11, lonMin: 179, lonMax: -179,
  };
  const plan = chooseHycomStride(box, DEFAULT_TARGET_CELLS);
  assert.equal(plan.crossesSeam, false, 'the antimeridian is contiguous on a 0-360 axis');
  const out = await fetchHycomCurrents({
    box, fetchImpl: planFetch(plan), nowMs: EPOCH_MS + 231 * HOUR_MS, timeAxis: TIME_AXIS,
  });
  assert.equal(out.source.urls.length, 1);
  for (let j = 1; j < out.lons.length; j += 1) assert.ok(out.lons[j] > out.lons[j - 1]);
  // The axis is allowed to run past +180 rather than fold and go descending.
  assert.ok(out.lons[0] < 180 && out.lons[out.lons.length - 1] > 180);
});

test('fetchHycomCurrents reports a FORECAST step with a negative, unclamped ageMs', async () => {
  const box = {
    latMin: 36, latMax: 37, lonMin: -122.5, lonMax: -121.5,
  };
  const plan = chooseHycomStride(box, DEFAULT_TARGET_CELLS);
  // Step 77 is 231 h after the epoch; ask as if "now" were 24 h earlier, so the
  // step served is a day into the future.
  const nowMs = EPOCH_MS + 231 * HOUR_MS - 24 * HOUR_MS;
  const out = await fetchHycomCurrents({
    box,
    fetchImpl: planFetch(plan),
    nowMs,
    atMs: EPOCH_MS + 231 * HOUR_MS,
    timeAxis: TIME_AXIS,
  });
  assert.equal(out.source.timeIndex, 77);
  assert.equal(out.source.validAtMs, EPOCH_MS + 231 * HOUR_MS);
  // Negative and NOT clamped to zero: a clamped age would make a forecast look
  // like a just-published analysis.
  assert.equal(out.source.ageMs, -24 * HOUR_MS);
  assert.ok(out.source.ageMs < 0);
  assert.equal(out.ageMs, out.source.ageMs);
  assert.equal(out.source.isForecast, true);
  assert.equal(out.source.forecastLeadMs, 24 * HOUR_MS);
  assert.match(out.source.note, /FORECAST|forecast/);
  // A past step reports a positive age and is not flagged as a forecast.
  const past = await fetchHycomCurrents({
    box,
    fetchImpl: planFetch(plan),
    nowMs: EPOCH_MS + 231 * HOUR_MS + 6 * HOUR_MS,
    atMs: EPOCH_MS + 231 * HOUR_MS,
    timeAxis: TIME_AXIS,
  });
  assert.equal(past.source.ageMs, 6 * HOUR_MS);
  assert.equal(past.source.isForecast, false);
  assert.equal(past.source.forecastLeadMs, 0);
});

test('fetchHycomCurrents reports the SERVED time, not the requested index', async () => {
  const box = {
    latMin: 36, latMax: 37, lonMin: -122.5, lonMax: -121.5,
  };
  const plan = chooseHycomStride(box, DEFAULT_TARGET_CELLS);
  const nowMs = EPOCH_MS + 231 * HOUR_MS;
  // The server answers with a different step than the index asked for.
  const out = await fetchHycomCurrents({
    box, fetchImpl: planFetch(plan, { timeValue: 234 }), nowMs, timeAxis: TIME_AXIS,
  });
  assert.equal(out.source.validAtMs, EPOCH_MS + 234 * HOUR_MS,
    'validAtMs comes from the echoed time value');
  assert.equal(out.source.ageMs, -3 * HOUR_MS);
  assert.equal(out.source.timeIso, new Date(EPOCH_MS + 234 * HOUR_MS).toISOString());
});

test('fetchHycomCurrents probes the time axis when none is supplied', async () => {
  const box = {
    latMin: 36, latMax: 37, lonMin: -122.5, lonMax: -121.5,
  };
  const plan = chooseHycomStride(box, DEFAULT_TARGET_CELLS);
  const log = [];
  const out = await fetchHycomCurrents({
    box, fetchImpl: planFetch(plan, { log }), nowMs: EPOCH_MS + 231 * HOUR_MS,
  });
  assert.ok(out.source.validAtMs > 0);
  assert.ok(log.some((e) => e.url.endsWith('.das')));
  assert.ok(log.some((e) => e.url.includes('.ascii?time')));
  assert.equal(out.source.timeIndex, 77);
});

test('fetchHycomCurrents throws on upstream failure rather than returning empty ocean', async () => {
  const box = {
    latMin: 36, latMax: 37, lonMin: -122.5, lonMax: -121.5,
  };
  // HTTP error on the data request.
  await assert.rejects(
    fetchHycomCurrents({
      box,
      fetchImpl: fakeFetch([['water_u', { ok: false, status: 400, text: async () => ERROR_BODY }]]),
      timeAxis: TIME_AXIS,
    }),
    /HTTP 400/,
  );
  // Shape drift must fail the tier, never be read as an empty grid.
  await assert.rejects(
    fetchHycomCurrents({
      box, fetchImpl: fakeFetch([['water_u', 'Dataset {\n};\n']]), timeAxis: TIME_AXIS,
    }),
    /unparseable or shape-drifted/,
  );
  // A broken fetch impl is a wiring bug, not an outage.
  await assert.rejects(
    fetchHycomCurrents({ box, fetchImpl: async () => ({}), timeAxis: TIME_AXIS }),
    /no usable response/,
  );
  // An unusable box is refused before any network call.
  await assert.rejects(
    fetchHycomCurrents({ box: { latMin: 1, latMax: 0, lonMin: 0, lonMax: 1 } }),
    /unusable view rectangle/,
  );
  // No resolvable time axis.
  await assert.rejects(
    fetchHycomCurrents({ box, fetchImpl: fakeFetch([['.das', 'nope']]) }),
    /could not resolve the dataset's time axis/,
  );
});

test('fetchHycomCurrents enforces the response byte cap', async () => {
  const box = {
    latMin: 36, latMax: 37, lonMin: -122.5, lonMax: -121.5,
  };
  const oversized = 'x'.repeat(HYCOM_RESPONSE_BYTE_CAP + 1);
  await assert.rejects(
    fetchHycomCurrents({
      box, fetchImpl: fakeFetch([['water_u', oversized]]), timeAxis: TIME_AXIS,
    }),
    new RegExp(`exceeds the ${HYCOM_RESPONSE_BYTE_CAP} B cap`),
  );
  // A body one byte under the cap is not rejected for size (it fails to parse,
  // which is a different error) — the boundary is not off by one.
  await assert.rejects(
    fetchHycomCurrents({
      box,
      fetchImpl: fakeFetch([['water_u', 'y'.repeat(HYCOM_RESPONSE_BYTE_CAP)]]),
      timeAxis: TIME_AXIS,
    }),
    /unparseable or shape-drifted/,
  );
});

test('fetchHycomCurrents times out and honours caller cancellation', async () => {
  const box = {
    latMin: 36, latMax: 37, lonMin: -122.5, lonMax: -121.5,
  };
  // A fetch that never settles on its own; only the abort signal ends it.
  const hangingFetch = (url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  await assert.rejects(
    fetchHycomCurrents({
      box, fetchImpl: hangingFetch, timeAxis: TIME_AXIS, timeoutMs: 25,
    }),
    /timed out after 25 ms/,
  );
  // A caller abort surfaces as the caller's own reason, not as an upstream fault.
  const controller = new AbortController();
  const reason = new Error('camera moved');
  const pending = fetchHycomCurrents({
    box, fetchImpl: hangingFetch, timeAxis: TIME_AXIS, signal: controller.signal,
  });
  controller.abort(reason);
  await assert.rejects(pending, /camera moved/);
});

test('fetchHycomCurrents refuses a grid whose served axes are not uniform', async () => {
  const box = {
    latMin: 36, latMax: 37, lonMin: -122.5, lonMax: -121.5,
  };
  const plan = chooseHycomStride(box, DEFAULT_TARGET_CELLS);
  const { lats, lons } = segmentAxes(plan.segments[0], plan.stride);
  // Drop one interior column: the remaining axis has a double-width gap, which
  // has no single resolution and would smear the field if averaged over.
  const gappy = [...lons.slice(0, 3), ...lons.slice(4)];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => asciiBody({ lats, lons: gappy, u: () => 0.25, v: () => -0.5 }),
  });
  await assert.rejects(
    fetchHycomCurrents({ box, fetchImpl, timeAxis: TIME_AXIS }),
    /not uniformly spaced|do not stitch/,
  );
});

// ---------------------------------------------------------------------------
// Live smoke test — opt in with GEV_LIVE_ENDPOINT_TESTS=1
// ---------------------------------------------------------------------------

test('LIVE: the real endpoint still serves the shape this module parses', {
  skip: process.env.GEV_LIVE_ENDPOINT_TESTS === '1'
    ? false
    : 'set GEV_LIVE_ENDPOINT_TESTS=1 to run',
}, async () => {
  const box = {
    latMin: 36, latMax: 36.5, lonMin: -122.5, lonMax: -122,
  };
  const out = await fetchHycomCurrents({ box, targetCells: 2000 });
  assert.ok(out.lats.length > 1 && out.lons.length > 1);
  assert.equal(out.u.length, out.lats.length * out.lons.length);
  // Monterey Bay: there must be some water in this box.
  assert.ok(out.finite > 0, 'the live box returned no usable vectors');
  assert.ok(out.source.coverage > 0 && out.source.coverage <= 1);
  // Longitudes in the pipeline's frame, strictly ascending.
  for (let j = 1; j < out.lons.length; j += 1) assert.ok(out.lons[j] > out.lons[j - 1]);
  assert.ok(out.lons[0] >= -180 && out.lons[out.lons.length - 1] < 180);
  // The served step must be inside the axis's real -10 d .. +5 d window.
  const ageDays = out.source.ageMs / 86400000;
  assert.ok(ageDays < 11 && ageDays > -6, `served step ${out.source.timeIso} is outside the axis window`);
  // Speeds must be physical.
  for (let k = 0; k < out.u.length; k += 1) {
    if (Number.isFinite(out.u[k])) {
      assert.ok(Math.abs(out.u[k]) <= HYCOM_DATASET.maxSpeedMs);
      assert.ok(Number.isFinite(out.v[k]), 'components must be finite together');
    }
  }
});
