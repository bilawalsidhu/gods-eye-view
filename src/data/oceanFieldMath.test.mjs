import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_AGE,
  DEFAULT_MIN_AGE,
  DEFAULT_SPEED_SCALE,
  SPEED_RAMP_GAMMA,
  SPEED_RAMP_STOPS,
  TRAIL_FADE_IN_FRAC,
  TRAIL_FADE_OUT_FRAC,
  buildTrailAlpha,
  createFieldSampler,
  createParticleSystem,
  createRng,
  fieldStats,
  gridBounds,
  smoothstep,
  speedColor,
  speedColorCss,
  speedLegendStops,
  speedRampT,
} from './oceanFieldMath.js';

/** Builds a payload from an explicit grid and row-major component arrays. */
function payload(grid, u, v) {
  return { grid, u, v, provenance: { tier: 'test', label: 'fixture' } };
}

/** WCAG relative luminance of an 8-bit sRGB triple (0..1). */
function relLuminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** HSL hue in degrees of an 8-bit sRGB triple. */
function hueDeg({ r, g, b }) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
}

/* ------------------------------------------------------------------ grid -- */

test('gridBounds reports node corners for ascending and descending grids', () => {
  const ascending = gridBounds({ lat0: 30, lon0: -125, dLat: 0.25, dLon: 0.25, nLat: 9, nLon: 21 });
  assert.deepEqual(ascending, {
    latMin: 30, latMax: 32, lonMin: -125, lonMax: -120, wrapsLon: false,
  });
  // ERDDAP serves some grids latitude-descending; bounds must still be ordered.
  const descending = gridBounds({ lat0: 32, lon0: -125, dLat: -0.25, dLon: 0.25, nLat: 9, nLon: 21 });
  assert.equal(descending.latMin, 30);
  assert.equal(descending.latMax, 32);
});

test('gridBounds flags a globally periodic longitude axis', () => {
  // 1440 columns of 0.25 deg = 360 deg exactly: column 1439 is one cell west of column 0.
  assert.equal(gridBounds({ lat0: -89.875, lon0: -180, dLat: 0.25, dLon: 0.25, nLat: 720, nLon: 1440 }).wrapsLon, true);
  // A 60 deg box is not periodic even though it uses the same spacing.
  assert.equal(gridBounds({ lat0: 20, lon0: -80, dLat: 0.25, dLon: 0.25, nLat: 120, nLon: 240 }).wrapsLon, false);
});

/* --------------------------------------------------------------- sampler -- */

const UNIT_GRID = { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 2, nLon: 2 };

test('bilinear matches hand-computed weights', () => {
  // u is linear in the indices (u = 2*ty + tx), v = 10 + 10*tx + 20*ty.
  const sample = createFieldSampler(payload(UNIT_GRID, [0, 1, 2, 3], [10, 20, 30, 40]));

  const centre = sample(0.5, 0.5);
  assert.equal(centre.ok, true);
  assert.equal(centre.u, 1.5); // 0.25*(0+1+2+3)
  assert.equal(centre.v, 25); // 0.25*(10+20+30+40)

  const off = sample(0.25, 0.75); // ty = 0.25, tx = 0.75
  // w00=0.1875 w01=0.5625 w10=0.0625 w11=0.1875
  assert.equal(off.u, 1.25);
  assert.equal(off.v, 22.5);
});

test('sampling exactly on a node returns that node value', () => {
  const sample = createFieldSampler(payload(UNIT_GRID, [0, 1, 2, 3], [10, 20, 30, 40]));
  assert.deepEqual([sample(0, 0).u, sample(0, 0).v], [0, 10]);
  assert.deepEqual([sample(0, 1).u, sample(0, 1).v], [1, 20]);
  assert.deepEqual([sample(1, 0).u, sample(1, 0).v], [2, 30]);
  assert.deepEqual([sample(1, 1).u, sample(1, 1).v], [3, 40]);
});

test('a null corner yields ok:false with NaN, never a zero-filled sample', () => {
  const sample = createFieldSampler(payload(UNIT_GRID, [0, 1, 2, null], [10, 20, 30, 40]));
  const got = sample(0.5, 0.5);
  assert.equal(got.ok, false);
  assert.equal(Number.isNaN(got.u), true, 'u must be NaN, not 0 — a gap is not slack water');
  assert.equal(Number.isNaN(got.v), true, 'v must be NaN so an ok-ignoring caller breaks visibly');
});

test('a null at a ZERO-weight corner still fails: any needed corner counts', () => {
  const sample = createFieldSampler(payload(UNIT_GRID, [0, 1, 2, null], [10, 20, 30, 40]));
  const onNode = sample(0, 0); // tx = ty = 0, so the null corner carries weight 0
  assert.equal(onNode.ok, false);
  assert.equal(Number.isNaN(onNode.u), true);
});

test('a non-finite entry is treated exactly like null', () => {
  const sample = createFieldSampler(payload(UNIT_GRID, [0, 1, 2, Infinity], [10, 20, 30, 40]));
  assert.equal(sample(0.5, 0.5).ok, false);
  const nanV = createFieldSampler(payload(UNIT_GRID, [0, 1, 2, 3], [10, 20, 30, NaN]));
  assert.equal(nanV(0.5, 0.5).ok, false);
});

test('positions outside the grid sample as ok:false, not clamped', () => {
  const grid = { lat0: 30, lon0: -125, dLat: 0.5, dLon: 0.5, nLat: 3, nLon: 3 };
  const ones = [1, 1, 1, 1, 1, 1, 1, 1, 1];
  const sample = createFieldSampler(payload(grid, ones, ones));
  assert.equal(sample(31, -124).ok, true); // interior
  assert.equal(sample(29.9, -124).ok, false); // south of the grid
  assert.equal(sample(31.1, -124).ok, false); // north of the last row (lat 31)
  assert.equal(sample(31, -125.1).ok, false); // west
  assert.equal(sample(31, -123.9).ok, false); // east of the last column (lon -124)
  assert.equal(Number.isNaN(sample(0, 0).u), true);
});

test('a globally periodic grid interpolates across the antimeridian', () => {
  // 4 columns of 90 deg from -180 spans 360 exactly, so column 3 wraps to column 0.
  const grid = { lat0: 0, lon0: -180, dLat: 1, dLon: 90, nLat: 2, nLon: 4 };
  const u = [0, 1, 2, 3, 0, 1, 2, 3];
  const sample = createFieldSampler(payload(grid, u, u.map(() => 0)));
  assert.equal(sample(0, 90).u, 3); // node at column 3
  assert.equal(sample(0, 180).u, 0); // wraps to column 0
  assert.equal(sample(0, 157.5).u, 0.75); // 0.25*3 + 0.75*0
  assert.equal(sample(0, -540).u, 0); // any number of turns
  assert.equal(sample(0, 157.5).ok, true);
});

test('a non-periodic box straddling the antimeridian still resolves', () => {
  // Nodes at 170, 175, 180, 185 deg east.
  const grid = { lat0: 0, lon0: 170, dLat: 1, dLon: 5, nLat: 2, nLon: 4 };
  const u = [0, 10, 20, 30, 0, 10, 20, 30];
  const sample = createFieldSampler(payload(grid, u, u.map(() => 0)));
  assert.equal(sample(0, 182).u, 24); // -178 deg expressed as 182
  assert.equal(sample(0, -178).u, 24); // same point, wrapped form
  assert.equal(sample(0, 100).ok, false); // genuinely outside, not wrapped in
});

test('descending-latitude grids sample without a transpose', () => {
  const grid = { lat0: 10, lon0: 0, dLat: -1, dLon: 1, nLat: 3, nLon: 2 };
  // Rows are lat 10, 9, 8.
  const u = [0, 0, 5, 5, 9, 9];
  const sample = createFieldSampler(payload(grid, u, u.map(() => 1)));
  assert.equal(sample(10, 0.5).u, 0);
  assert.equal(sample(9.5, 0.5).u, 2.5);
  assert.equal(sample(8, 0.5).u, 9);
  assert.equal(sample(10.5, 0.5).ok, false);
  assert.equal(sample(7.9, 0.5).ok, false);
});

test('a non-finite coordinate samples as ok:false on both grid kinds', () => {
  // The renderer unprojects screen pixels; points behind the limb come back NaN.
  const regional = createFieldSampler(payload(UNIT_GRID, [0, 1, 2, 3], [0, 0, 0, 0]));
  assert.equal(regional(NaN, 0.5).ok, false);
  assert.equal(regional(0.5, NaN).ok, false);
  assert.equal(regional(Infinity, 0.5).ok, false);
  const global = createFieldSampler(payload(
    { lat0: 0, lon0: -180, dLat: 1, dLon: 90, nLat: 2, nLon: 4 },
    [0, 1, 2, 3, 0, 1, 2, 3],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ));
  assert.equal(global(0.5, NaN).ok, false, 'the wrapping path must not index with NaN');
  assert.equal(Number.isNaN(global(0.5, NaN).u), true);
});

test('the sampler reuses one result object and allocates nothing per call', () => {
  const sample = createFieldSampler(payload(UNIT_GRID, [0, 1, 2, 3], [10, 20, 30, 40]));
  const first = sample(0.25, 0.25);
  const second = sample(0.75, 0.75);
  assert.equal(first, second, 'documented contract: read the result before the next call');
  // Two samplers must not share state.
  const other = createFieldSampler(payload(UNIT_GRID, [9, 9, 9, 9], [0, 0, 0, 0]));
  assert.notEqual(sample(0.5, 0.5), other(0.5, 0.5));
});

test('descending-longitude grids sample without a transpose', () => {
  // ERDDAP can serve lon descending as well as lat. Nodes at -120, -120.5, -121.
  const grid = { lat0: 0, lon0: -120, dLat: 1, dLon: -0.5, nLat: 2, nLon: 3 };
  const u = [0, 10, 20, 0, 10, 20];
  const sample = createFieldSampler(payload(grid, u, u.map(() => 1)));
  assert.equal(sample(0.5, -120).u, 0);
  assert.equal(sample(0.5, -120.5).u, 10);
  assert.equal(sample(0.5, -121).u, 20);
  assert.equal(sample(0.5, -120.25).u, 5, 'interpolates westward between columns 0 and 1');
  assert.equal(sample(0.5, -119.9).ok, false, 'east of the first column is outside');
  assert.equal(sample(0.5, -121.1).ok, false, 'west of the last column is outside');
});

test('a globally periodic grid with descending longitude wraps the same way', () => {
  // Nodes at 180, 90, 0, -90: 4 columns of -90 deg span 360 exactly.
  const grid = { lat0: 0, lon0: 180, dLat: 1, dLon: -90, nLat: 2, nLon: 4 };
  const u = [0, 1, 2, 3, 0, 1, 2, 3];
  const sample = createFieldSampler(payload(grid, u, u.map(() => 0)));
  assert.equal(sample(0.5, 180).u, 0);
  assert.equal(sample(0.5, 90).u, 1);
  assert.equal(sample(0.5, -90).u, 3);
  // -135 is halfway across the seam from node 3 (-90) back to node 0 (180).
  assert.equal(sample(0.5, -135).u, 1.5);
  assert.equal(sample(0.5, 225).u, 1.5, 'the same point written the other way');
});

test('the seam of a near-periodic grid stays inside the convex hull', () => {
  // REGRESSION. wrapsLon admits half a cell of slack, so a grid whose spacing
  // is a rounded decimal closes with a seam WIDER than one cell: 1430 columns
  // of 0.2517 deg cover 359.931, leaving a 0.319 deg gap = 1.27 cells. Dividing
  // the seam offset by one cell put tx above 1, and this field — whose only
  // values are 0 and 100 — returned -27.0 with ok:true. Bilinear is only safe
  // because it is a convex combination; outside [0,1] it is extrapolation.
  const dLon = 0.2517;
  const nLon = 1430;
  const u = new Array(2 * nLon).fill(0);
  u[nLon - 1] = 100;
  u[2 * nLon - 1] = 100;
  const grid = { lat0: 0, lon0: 0, dLat: 1, dLon, nLat: 2, nLon };
  assert.equal(gridBounds(grid).wrapsLon, true, 'the fixture must exercise the seam');
  const sample = createFieldSampler(payload(grid, u, u));
  const lastNode = (nLon - 1) * dLon; // 359.681 deg
  let previous = Infinity;
  for (let k = 0; k <= 20; k += 1) {
    const lon = lastNode + (360 - lastNode) * (k / 20);
    const got = sample(0.5, lon);
    assert.equal(got.ok, true, `seam lon ${lon} must sample`);
    assert.ok(got.u >= 0 && got.u <= 100, `seam lon ${lon} gave ${got.u}, outside the data hull`);
    assert.ok(got.u <= previous, 'the seam must fall monotonically from 100 to 0');
    previous = got.u;
  }
  assert.ok(Math.abs(sample(0.5, lastNode).u - 100) < 1e-9, 'the last node is still 100');
  assert.ok(Math.abs(sample(0.5, 360).u) < 1e-9, 'the wrapped first node is still 0');
});

test('an exactly periodic seam is unaffected by the seam-width correction', () => {
  // seamSpan is exactly 1 when nLon*|dLon| is exactly 360, so the division is
  // by 1.0 and the arithmetic is bit-identical to the uncorrected form.
  const grid = { lat0: 0, lon0: -180, dLat: 1, dLon: 0.25, nLat: 2, nLon: 1440 };
  const u = new Float64Array(2 * 1440);
  u[1439] = 8;
  u[2879] = 8; // last column = 8, column 0 = 0
  const sample = createFieldSampler(payload(grid, u, u));
  assert.equal(sample(0.5, 179.75).u, 8, 'the last node');
  assert.equal(sample(0.5, 180).u, 0, 'the wrapped first node');
  assert.equal(sample(0.5, 179.875).u, 4, 'exactly half a cell across the seam');
  assert.equal(sample(0.5, 179.8125).u, 6, 'a quarter cell across the seam');
});

test('a wrapped longitude agrees with its unwrapped twin to sub-nanometre', () => {
  // The @file block's claim, stated as the measured bound rather than as exact
  // equality: reducing (lon - lon0) mod 360 in DEGREES rounds, so the two
  // written forms of one point can differ. Measured over 2e5 longitudes on this
  // grid the worst index disagreement is 2.2737e-13 cells = 5.7e-14 deg; the
  // sampled value follows at |du| <= 4.0e-15 for an O(1) field.
  const nLon = 1440;
  const u = new Float64Array(2 * nLon);
  const v = new Float64Array(2 * nLon);
  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < nLon; j += 1) {
      u[i * nLon + j] = Math.sin(j * 0.017) + i;
      v[i * nLon + j] = Math.cos(j * 0.013);
    }
  }
  const sample = createFieldSampler(payload(
    { lat0: 0, lon0: -180, dLat: 0.25, dLon: 0.25, nLat: 2, nLon }, u, v,
  ));
  const N = 2000;
  const worstFor = (delta) => {
    let worst = 0;
    let identical = 0;
    for (let k = 0; k < N; k += 1) {
      const lon = -180 + (360 * k) / N + 0.0123456789;
      const a = sample(0.1, lon);
      const au = a.u;
      const av = a.v;
      const b = sample(0.1, lon + delta);
      if (au === b.u && av === b.v) identical += 1;
      worst = Math.max(worst, Math.abs(au - b.u), Math.abs(av - b.v));
    }
    return { worst, identical };
  };

  const oneTurn = worstFor(-360);
  assert.ok(oneTurn.worst < 1e-13, `one-turn twin disagreed by ${oneTurn.worst}, expected < 1e-13`);
  assert.ok(oneTurn.identical > N * 0.4, `only ${oneTurn.identical}/${N} were bit-identical`);

  // The residual is ulp(|lon - lon0|)/|dLon| in cells, so it grows with the
  // MAGNITUDE of the longitude as written, not with the point it denotes: two
  // turns out measures 2.8e-13 against 4.0e-15 for one. A renderer unprojects
  // into one turn of the axis, so the one-turn bound is the one that binds; the
  // looser bound is asserted only to pin that the growth is bounded, not wild.
  const twoTurns = worstFor(720);
  assert.ok(twoTurns.worst < 1e-11, `two-turn twin disagreed by ${twoTurns.worst}`);
  assert.ok(twoTurns.worst > oneTurn.worst, 'the residual is expected to grow with the turn count');
});

test('the poles of a global grid sample as no-data, never clamped into a value', () => {
  // A 0.25 deg global field runs to +-89.875; a camera looking at the pole must
  // get ok:false, not the value of the nearest row smeared to 90 deg.
  const nLat = 720;
  const nLon = 1440;
  const grid = { lat0: -89.875, lon0: -179.875, dLat: 0.25, dLon: 0.25, nLat, nLon };
  const sample = createFieldSampler(payload(
    grid, new Float32Array(nLat * nLon).fill(0.5), new Float32Array(nLat * nLon).fill(0.1),
  ));
  assert.equal(sample(0, 12.3).ok, true);
  assert.equal(sample(89.875, 12.3).ok, true, 'the last node itself is data');
  for (const lat of [90, -90, 89.9, -89.9, 89.876]) {
    const got = sample(lat, 12.3);
    assert.equal(got.ok, false, `lat ${lat} is outside the grid`);
    assert.equal(Number.isNaN(got.u), true);
  }
});

test('the sampler copies the payload and never aliases it', () => {
  const u = [0, 1, 2, 3];
  const sample = createFieldSampler(payload(UNIT_GRID, u, [10, 20, 30, 40]));
  assert.equal(sample(0.5, 0.5).u, 1.5);
  u[0] = 1000; // a loader reusing its scratch buffer for the next tile
  assert.equal(sample(0.5, 0.5).u, 1.5, 'the sampler owns its own storage');
});

test('the sampler accepts typed-array components as documented', () => {
  const sample = createFieldSampler(payload(
    UNIT_GRID, Float32Array.from([0, 1, 2, 3]), Float64Array.from([10, 20, 30, NaN]),
  ));
  assert.equal(sample(0.5, 0.5).ok, false, 'a NaN in a typed array is a gap like any other');
  const clean = createFieldSampler(payload(
    UNIT_GRID, Float32Array.from([0, 1, 2, 3]), Float64Array.from([10, 20, 30, 40]),
  ));
  assert.equal(clean(0.5, 0.5).u, 1.5);
  assert.equal(clean(0.5, 0.5).v, 25);
});

test('gridBounds refuses a malformed grid rather than reporting NaN corners', () => {
  assert.throws(() => gridBounds(null), /no grid/);
  assert.throws(() => gridBounds({ lat0: NaN, lon0: 0, dLat: 1, dLon: 1, nLat: 2, nLon: 2 }), /lat0 must be finite/);
  assert.throws(() => gridBounds({ lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 2.5, nLon: 2 }), /nLat must be an integer/);
});

test('malformed payloads throw instead of sampling garbage', () => {
  assert.throws(() => createFieldSampler(null), /no grid/);
  assert.throws(
    () => createFieldSampler(payload({ ...UNIT_GRID, nLon: 1 }, [0, 1], [0, 1])),
    /nLon must be an integer >= 2/,
  );
  assert.throws(
    () => createFieldSampler(payload({ ...UNIT_GRID, dLat: 0 }, [0, 1, 2, 3], [0, 0, 0, 0])),
    /spacing must be non-zero/,
  );
  assert.throws(
    () => createFieldSampler(payload(UNIT_GRID, [0, 1, 2], [0, 0, 0, 0])),
    /payload\.u has 3 entries, grid needs 4/,
  );
});

/* ------------------------------------------------------------ speed ramp -- */

test('ramp endpoints reproduce the declared stops exactly', () => {
  const low = speedColor(0);
  assert.deepEqual({ r: low.r, g: low.g, b: low.b }, { r: 38, g: 124, b: 146 });
  const high = speedColor(DEFAULT_SPEED_SCALE);
  assert.deepEqual({ r: high.r, g: high.g, b: high.b }, { r: 255, g: 201, b: 80 });
  // Faster than the scale clips to the top; it never wraps back to the low end.
  assert.deepEqual(speedColor(12), high);
});

test('the declared stops are strictly increasing in luminance', () => {
  // This is the property the whole design rests on: because the stops are
  // interpolated in linear light and Y is a linear functional there, Y(t) is
  // piecewise linear, so monotone at the stops means monotone everywhere.
  const measured = SPEED_RAMP_STOPS.map((s) => relLuminance(s));
  for (let i = 1; i < measured.length; i += 1) {
    assert.ok(measured[i] > measured[i - 1], `stop ${i} luminance ${measured[i]} <= ${measured[i - 1]}`);
  }
  // The values quoted in the @file block, to three decimals.
  const documented = [0.169, 0.279, 0.442, 0.600, 0.636];
  for (let i = 0; i < documented.length; i += 1) {
    assert.ok(Math.abs(measured[i] - documented[i]) < 0.001, `stop ${i} Y = ${measured[i]}`);
  }
});

test('rendered ramp luminance rises from end to end', () => {
  // 17 samples even in t: the shallowest segment (stops 3->4, dY = 0.036) then
  // rises 0.009 per interval, comfortably clear of the 8-bit quantization noise
  // bounded in the next test.
  const samples = 17;
  let previous = -Infinity;
  for (let i = 0; i < samples; i += 1) {
    const t = i / (samples - 1);
    const speed = DEFAULT_SPEED_SCALE * t ** (1 / SPEED_RAMP_GAMMA);
    const y = relLuminance(speedColor(speed));
    assert.ok(y > previous, `luminance must rise; t=${t} gave ${y} after ${previous}`);
    previous = y;
  }
});

test('the baked lookup table never inverts luminance beyond 8-bit rounding', () => {
  // Each channel is rounded independently, so an adjacent LUT pair can invert
  // by at most twice the worst half-LSB luminance perturbation. That worst case
  // is the green channel near code 210, where dY/dcode = 0.0050, giving
  // 2 * 0.0025 = 0.005; the measured worst adjacent drop is 0.0039, at q = 194
  // in the yellow-green segment. In L* that is 0.3 units — below the ~1 unit
  // JND, i.e. not a visible inversion.
  let previous = -Infinity;
  for (let q = 0; q < 256; q += 1) {
    const t = q / 255;
    const speed = DEFAULT_SPEED_SCALE * t ** (1 / SPEED_RAMP_GAMMA);
    const y = relLuminance(speedColor(speed));
    assert.ok(y > previous - 0.005, `LUT step ${q} dropped ${previous - y} in luminance`);
    previous = y;
  }
  // And the ends are unambiguous even after quantization.
  assert.ok(relLuminance(speedColor(DEFAULT_SPEED_SCALE)) - relLuminance(speedColor(0)) > 0.4);
});

test('the ramp is sequential, not a rainbow: hue never revisits a value', () => {
  const hues = SPEED_RAMP_STOPS.map((s) => hueDeg(s));
  for (let i = 1; i < hues.length; i += 1) {
    assert.ok(hues[i] < hues[i - 1], `hue must fall monotonically, got ${hues.join(', ')}`);
  }
  assert.ok(hues[0] - hues[hues.length - 1] < 200, 'a monotone sweep, not a full hue circle');
  // Every stop keeps chroma: no stop collapses toward grey/white, which is what
  // carries legibility when the background luminance matches the stop's.
  for (const stop of SPEED_RAMP_STOPS) {
    const max = Math.max(stop.r, stop.g, stop.b);
    const min = Math.min(stop.r, stop.g, stop.b);
    assert.ok((max - min) / max > 0.3, `stop ${JSON.stringify(stop)} is too desaturated`);
  }
});

test('speedRampT expands the crowded slow end by the documented amount', () => {
  // Measured Gulf Stream |v| median 0.128 m/s -> t = 0.26 at gamma 0.55,
  // versus t = 0.085 under a linear map (the @file block's justification).
  assert.ok(Math.abs(speedRampT(0.128) - 0.258) < 0.002);
  assert.ok(Math.abs(speedRampT(0.553) - 0.578) < 0.002);
  assert.equal(speedRampT(DEFAULT_SPEED_SCALE), 1);
  assert.equal(speedRampT(0), 0);
});

test('a non-finite or negative speed maps to the ramp floor, not an exception', () => {
  const floor = speedColor(0);
  assert.deepEqual(speedColor(NaN), floor);
  assert.deepEqual(speedColor(-1), floor);
  assert.deepEqual(speedColor(0.5, 0), speedColor(0.5, DEFAULT_SPEED_SCALE)); // bad scale falls back
});

test('speedColor writes into a caller-supplied object', () => {
  const out = { r: -1, g: -1, b: -1 };
  const returned = speedColor(DEFAULT_SPEED_SCALE, DEFAULT_SPEED_SCALE, out);
  assert.equal(returned, out);
  assert.deepEqual(out, { r: 255, g: 201, b: 80 });
  assert.equal(speedColorCss(0), 'rgb(38, 124, 146)');
});

test('speedLegendStops samples evenly in ramp position, labelled in m/s', () => {
  const scale = 2;
  const stops = speedLegendStops(5, scale);
  assert.equal(stops.length, 5);
  assert.deepEqual(stops.map((s) => s.t), [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(stops[0].speedMs, 0);
  assert.ok(Math.abs(stops[4].speedMs - 2) < 1e-12);

  // THE contract of this function, and the one an evenly-increasing-label
  // legend would also satisfy: each stop's speed must be the speed that maps
  // BACK to that stop's ramp position, speedMs = scale * t^(1/gamma). Sampling
  // evenly in speed instead (speedMs = scale * t) still gives increasing labels
  // and increasing luminance, so monotonicity alone does not pin it: at t = 0.5
  // the correct label is 0.567156 m/s, whereas the linear one would read 1.0
  // m/s — a colour that in fact renders at t = 0.683020, mislabelling the tick
  // by 0.183 of the ramp's length.
  for (const stop of stops) {
    assert.ok(
      Math.abs(speedRampT(stop.speedMs, scale) - stop.t) < 1e-12,
      `stop labelled ${stop.speedMs} m/s renders at t=${speedRampT(stop.speedMs, scale)}, not ${stop.t}`,
    );
    const direct = speedColor(stop.speedMs, scale);
    assert.deepEqual({ r: stop.r, g: stop.g, b: stop.b }, { r: direct.r, g: direct.g, b: direct.b });
  }
  assert.ok(Math.abs(stops[2].speedMs - 0.567156) < 5e-6, `t=0.5 must label 0.567156 m/s, got ${stops[2].speedMs}`);

  for (let i = 1; i < stops.length; i += 1) {
    assert.ok(stops[i].speedMs > stops[i - 1].speedMs, 'labels must increase');
    assert.ok(relLuminance(stops[i]) > relLuminance(stops[i - 1]));
  }
  assert.equal(speedLegendStops(1).length, 2, 'clamped to a drawable minimum');
  assert.equal(speedLegendStops(4.9).length, 4, 'a fractional count truncates');
});

test('speedLegendStops refuses a non-finite count instead of hanging or returning nothing', () => {
  // Math.max(2, Math.trunc(NaN)) is NaN, so the loop never ran and the
  // documented ">= 2" silently produced an EMPTY legend; Infinity pushed
  // forever. Both are upstream bugs and are now reported as such.
  assert.throws(() => speedLegendStops(NaN), /count must be finite/);
  assert.throws(() => speedLegendStops(Infinity), /count must be finite/);
  assert.throws(() => speedLegendStops(-Infinity), /count must be finite/);
});

/* ------------------------------------------------------------ trail fade -- */

test('smoothstep clamps, is symmetric about its midpoint, and handles degenerate edges', () => {
  assert.equal(smoothstep(0, 1, -5), 0);
  assert.equal(smoothstep(0, 1, 5), 1);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  assert.equal(smoothstep(0, 1, 0.25) + smoothstep(0, 1, 0.75), 1);
  assert.equal(smoothstep(2, 2, 1), 0);
  assert.equal(smoothstep(2, 2, 3), 1);
});

test('smoothstep returns a drawable alpha for a NaN sample point', () => {
  // It multiplies straight into an alpha. NaN there paints a mark fully opaque
  // or fully transparent depending on the canvas, and the degenerate-edge
  // branch answered 1 — maximally visible — for an unknown position.
  assert.equal(smoothstep(0, 1, NaN), 0);
  assert.equal(smoothstep(2, 2, NaN), 0);
  assert.equal(smoothstep(0, 1, Infinity), 1);
  assert.equal(smoothstep(0, 1, -Infinity), 0);
});

test('trail alpha is zero at birth and death and exactly 1 on the plateau', () => {
  assert.equal(buildTrailAlpha(0, 100), 0);
  assert.equal(buildTrailAlpha(100, 100), 0);
  assert.equal(buildTrailAlpha(101, 100), 0);
  // Between the fade-in end (0.12) and the fade-out start (0.65) both factors are 1.
  assert.equal(buildTrailAlpha(50, 100), 1);
  assert.equal(buildTrailAlpha(TRAIL_FADE_IN_FRAC * 100, 100), 1);
  assert.equal(buildTrailAlpha((1 - TRAIL_FADE_OUT_FRAC) * 100, 100), 1);
});

test('trail alpha rises then falls, with no flat dead zone at either end', () => {
  let previous = 0;
  for (let age = 1; age <= 12; age += 1) {
    const alpha = buildTrailAlpha(age, 100);
    assert.ok(alpha > previous, `fade-in must rise at age ${age}`);
    previous = alpha;
  }
  previous = 1;
  for (let age = 66; age <= 100; age += 1) {
    const alpha = buildTrailAlpha(age, 100);
    assert.ok(alpha < previous, `fade-out must fall at age ${age}`);
    previous = alpha;
  }
});

test('trail alpha refuses malformed lifetimes rather than rendering opaque', () => {
  assert.equal(buildTrailAlpha(5, 0), 0);
  assert.equal(buildTrailAlpha(5, -10), 0);
  assert.equal(buildTrailAlpha(-1, 100), 0);
  assert.equal(buildTrailAlpha(NaN, 100), 0);
  assert.equal(buildTrailAlpha(5, NaN), 0);
});

/* -------------------------------------------------------------- particles -- */

/** Uniform rightward drift, always valid. */
const driftRight = () => ({ vx: 1, vy: 0, ok: true, speedMs: 0.4 });

/** Runs a fixed script so two systems can be compared bit for bit. */
function runScript(seed) {
  const system = createParticleSystem({ count: 64, seed, minAge: 5, maxAge: 20 });
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const velocityAt = (x, y) => ({ vx: Math.sin(y * 0.1), vy: Math.cos(x * 0.1), ok: true, speedMs: 0.3 });
  const spawn = (i, s) => s.respawn(i, s.random() * 100, s.random() * 100);
  for (let frame = 0; frame < 40; frame += 1) system.step({ velocityAt, dt: 1, bounds, spawn });
  return system;
}

test('the same seed reproduces the particle sequence exactly', () => {
  const a = runScript(1234);
  const b = runScript(1234);
  assert.deepStrictEqual(a.x, b.x);
  assert.deepStrictEqual(a.y, b.y);
  assert.deepStrictEqual(a.age, b.age);
  assert.deepStrictEqual(a.maxAge, b.maxAge);
  assert.deepStrictEqual(a.alive, b.alive);
  assert.deepStrictEqual(a.prevX, b.prevX);
});

test('a different seed gives a different sequence', () => {
  const a = runScript(1234);
  const c = runScript(1235);
  assert.notDeepStrictEqual(a.x, c.x);
});

test('createRng is the documented mulberry32 stream and tolerates seed 0', () => {
  const rng = createRng(1);
  const first = [rng(), rng(), rng()];
  const again = createRng(1);
  assert.deepEqual([again(), again(), again()], first);
  for (const value of first) assert.ok(value >= 0 && value < 1);
  const zero = createRng(0);
  assert.notEqual(zero(), 0, 'seed 0 must not degenerate');
});

test('a bulk respawn staggers ages so the field cannot blink in unison', () => {
  const count = 1000;
  const system = createParticleSystem({ count, seed: 7, minAge: DEFAULT_MIN_AGE, maxAge: DEFAULT_MAX_AGE });
  for (let i = 0; i < count; i += 1) system.respawn(i, 10, 10); // every particle, one frame
  assert.equal(system.aliveCount(), count);

  // Lifetimes and birth phases are both randomized, so remaining life spreads
  // across a whole lifetime rather than landing on one death step.
  let minRemaining = Infinity;
  let maxRemaining = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const remaining = system.maxAge[i] - system.age[i];
    minRemaining = Math.min(minRemaining, remaining);
    maxRemaining = Math.max(maxRemaining, remaining);
  }
  assert.ok(minRemaining < 5, `some particle should die soon, min remaining was ${minRemaining}`);
  assert.ok(maxRemaining > DEFAULT_MAX_AGE * 0.9, `some should live long, max was ${maxRemaining}`);

  // Ages must be spread, not a single value repeated.
  const distinct = new Set(Array.from(system.age)).size;
  assert.ok(distinct > count * 0.9, `expected distinct birth phases, got ${distinct}`);

  // Simulate: no step may retire more than a small fraction of the field, and
  // deaths must be spread over many steps.
  let alive = count;
  let worstStep = 0;
  let stepsWithDeaths = 0;
  for (let frame = 0; frame < DEFAULT_MAX_AGE + 5; frame += 1) {
    const now = system.step({ velocityAt: driftRight, dt: 1 });
    const died = alive - now;
    if (died > 0) stepsWithDeaths += 1;
    worstStep = Math.max(worstStep, died);
    alive = now;
  }
  assert.equal(alive, 0, 'every particle eventually retires');
  assert.ok(worstStep < count * 0.06, `worst single step retired ${worstStep} of ${count}`);
  assert.ok(stepsWithDeaths > 40, `deaths spread over only ${stepsWithDeaths} steps`);
});

test('a particle retires when it exceeds its own maxAge', () => {
  const system = createParticleSystem({ count: 1, seed: 3, minAge: 4, maxAge: 4 });
  system.respawn(0, 0, 0);
  system.age[0] = 0; // override the staggered birth phase to test the age rule alone
  assert.equal(system.step({ velocityAt: driftRight, dt: 1 }), 1);
  assert.equal(system.step({ velocityAt: driftRight, dt: 1 }), 1);
  assert.equal(system.step({ velocityAt: driftRight, dt: 1 }), 1);
  assert.equal(system.step({ velocityAt: driftRight, dt: 1 }), 0, 'age 4 >= maxAge 4 retires');
  assert.equal(system.alive[0], 0);
});

test('a particle retires when it leaves the viewport', () => {
  const system = createParticleSystem({ count: 1, seed: 3, minAge: 1000, maxAge: 1000 });
  system.respawn(0, 8, 5);
  system.age[0] = 0;
  const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  assert.equal(system.step({ velocityAt: driftRight, dt: 1, bounds }), 1); // x = 9
  assert.equal(system.step({ velocityAt: driftRight, dt: 1, bounds }), 1); // x = 10, inclusive
  assert.equal(system.step({ velocityAt: driftRight, dt: 1, bounds }), 0); // x = 11
  assert.equal(system.x[0], 11, 'the position where it left is kept for inspection');
  // Without bounds the same particle would still be alive.
  const free = createParticleSystem({ count: 1, seed: 3, minAge: 1000, maxAge: 1000 });
  free.respawn(0, 8, 5);
  for (let i = 0; i < 3; i += 1) free.step({ velocityAt: driftRight, dt: 1 });
  assert.equal(free.alive[0], 1);
});

test('a particle retires on a no-data lookup instead of drifting through the gap', () => {
  const system = createParticleSystem({ count: 1, seed: 3, minAge: 1000, maxAge: 1000 });
  system.respawn(0, 4, 4);
  const gap = () => ({ vx: 0, vy: 0, ok: false });
  assert.equal(system.step({ velocityAt: gap, dt: 1 }), 0);
  assert.equal(system.alive[0], 0);
  assert.equal(system.x[0], 4, 'no advection happened on a gap');

  // A null return means the same thing.
  const nullish = createParticleSystem({ count: 1, seed: 3, minAge: 1000, maxAge: 1000 });
  nullish.respawn(0, 4, 4);
  assert.equal(nullish.step({ velocityAt: () => null, dt: 1 }), 0);
});

test('a non-finite projected position retires the particle', () => {
  const system = createParticleSystem({ count: 1, seed: 3, minAge: 1000, maxAge: 1000 });
  system.respawn(0, 4, 4);
  assert.equal(system.step({ velocityAt: () => ({ vx: NaN, vy: 0, ok: true }), dt: 1 }), 0);
  assert.equal(system.alive[0], 0);
  assert.equal(system.x[0], 4, 'the NaN is never written into the position');
});

test('the spawn callback refills retired particles in the same pass', () => {
  const system = createParticleSystem({ count: 32, seed: 11, minAge: 2, maxAge: 3 });
  const spawn = (i, s) => s.respawn(i, 50 + s.random(), 50 + s.random());
  const alive = system.step({ velocityAt: driftRight, dt: 1, spawn });
  assert.equal(alive, 32, 'first step brings the whole field online');
  for (let frame = 0; frame < 20; frame += 1) {
    assert.equal(system.step({ velocityAt: driftRight, dt: 1, spawn }), 32);
  }
  // Declining to place a particle leaves it dead.
  const noop = createParticleSystem({ count: 4, seed: 11, minAge: 2, maxAge: 3 });
  assert.equal(noop.step({ velocityAt: driftRight, dt: 1, spawn: () => {} }), 0);
});

test('respawn seeds prev to the new position so no streak crosses the screen', () => {
  const system = createParticleSystem({ count: 1, seed: 5, minAge: 10, maxAge: 10 });
  system.respawn(0, 900, 12);
  assert.equal(system.prevX[0], 900);
  assert.equal(system.prevY[0], 12);
  system.step({ velocityAt: driftRight, dt: 1 });
  assert.equal(system.prevX[0], 900);
  assert.equal(system.x[0], 901);
});

test('the observed field speed is stored per particle for colouring', () => {
  const system = createParticleSystem({ count: 1, seed: 5, minAge: 10, maxAge: 10 });
  system.respawn(0, 0, 0);
  system.step({ velocityAt: () => ({ vx: 1, vy: 0, ok: true, speedMs: 0.87 }), dt: 1 });
  assert.ok(Math.abs(system.speedMs[0] - 0.87) < 1e-6);
  // A lookup that omits speedMs leaves NaN, never 0 — the ramp floor is a
  // colour, and 0 there would read as verified slack water.
  system.step({ velocityAt: () => ({ vx: 1, vy: 0, ok: true }), dt: 1 });
  assert.equal(Number.isNaN(system.speedMs[0]), true);
});

test('the midpoint integrator uses the midpoint velocity and survives a reused result object', () => {
  const shear = { vx: 0, vy: 0, ok: true };
  const velocityAt = (x) => {
    shear.vx = x; // v = x, so the midpoint estimate differs from the Euler one
    return shear; // deliberately the SAME object every call
  };
  const euler = createParticleSystem({ count: 1, seed: 2, minAge: 100, maxAge: 100 });
  euler.respawn(0, 1, 0);
  euler.step({ velocityAt, dt: 1 });
  assert.equal(euler.x[0], 2); // 1 + 1*1

  const midpoint = createParticleSystem({ count: 1, seed: 2, minAge: 100, maxAge: 100 });
  midpoint.respawn(0, 1, 0);
  midpoint.step({ velocityAt, dt: 1, integrator: 'midpoint' });
  assert.equal(midpoint.x[0], 2.5); // 1 + 1*v(1.5)
});

test('the midpoint integrator retires a particle whose midpoint has no data', () => {
  const system = createParticleSystem({ count: 1, seed: 2, minAge: 100, maxAge: 100 });
  system.respawn(0, 0, 0);
  let call = 0;
  const velocityAt = () => {
    call += 1;
    return call === 1 ? { vx: 4, vy: 0, ok: true } : { vx: 0, vy: 0, ok: false };
  };
  assert.equal(system.step({ velocityAt, dt: 1, integrator: 'midpoint' }), 0);
  assert.equal(system.x[0], 0);
});

test('killAll retires everything without disturbing the RNG stream', () => {
  const a = createParticleSystem({ count: 4, seed: 99, minAge: 5, maxAge: 9 });
  const b = createParticleSystem({ count: 4, seed: 99, minAge: 5, maxAge: 9 });
  a.killAll();
  a.killAll();
  for (let i = 0; i < 4; i += 1) {
    a.respawn(i, 1, 1);
    b.respawn(i, 1, 1);
  }
  assert.deepStrictEqual(a.maxAge, b.maxAge);
  assert.deepStrictEqual(a.age, b.age);
  assert.equal(b.aliveCount(), 4);
});

test('dt scales advection and ageing together, in the same unit as the lifetimes', () => {
  // The lifetimes are documented as being in the caller's dt unit; a renderer
  // stepping in seconds rather than frames must get the same trajectory.
  const system = createParticleSystem({ count: 1, seed: 3, minAge: 2, maxAge: 2 });
  system.respawn(0, 0, 0);
  system.age[0] = 0;
  const v = () => ({ vx: 4, vy: -2, ok: true, speedMs: 0.5 });
  assert.equal(system.step({ velocityAt: v, dt: 0.5 }), 1);
  assert.equal(system.x[0], 2);
  assert.equal(system.y[0], -1);
  assert.equal(system.age[0], 0.5);
  system.step({ velocityAt: v, dt: 0.5 });
  system.step({ velocityAt: v, dt: 0.5 });
  assert.equal(system.step({ velocityAt: v, dt: 0.5 }), 0, 'age 2.0 >= maxAge 2 retires');
  assert.equal(system.x[0], 8, 'four half-steps of 4 px/unit');
});

test('step refuses a malformed viewport instead of silently never retiring', () => {
  // Every comparison against an undefined edge is false, so a partial rect
  // disabled the viewport rule outright: particles advected off-screen forever,
  // were never offered to spawn, and the field visibly thinned with no error.
  const system = createParticleSystem({ count: 1, seed: 1 });
  system.respawn(0, 0, 0);
  const v = () => ({ vx: 1, vy: 0, ok: true });
  assert.throws(() => system.step({ velocityAt: v, bounds: { minX: 0, minY: 0 } }), /finite minX/);
  assert.throws(() => system.step({ velocityAt: v, bounds: { minX: 0, minY: 0, maxX: NaN, maxY: 10 } }), /finite minX/);
  assert.throws(
    () => system.step({ velocityAt: v, bounds: { minX: 10, minY: 0, maxX: 0, maxY: 10 } }),
    /bounds is inverted/,
  );
  // null and undefined stay the documented "no viewport rule".
  assert.equal(system.step({ velocityAt: v, bounds: null }), 1);
  assert.equal(system.step({ velocityAt: v }), 1);
  // A degenerate but well-formed one-pixel rect is legal.
  const dot = createParticleSystem({ count: 1, seed: 1 });
  dot.respawn(0, 5, 5);
  assert.equal(dot.step({ velocityAt: () => ({ vx: 0, vy: 0, ok: true }), bounds: { minX: 5, minY: 5, maxX: 5, maxY: 5 } }), 1);
});

test('step refuses a dt, spawn or integrator it cannot honour', () => {
  const system = createParticleSystem({ count: 2, seed: 1 });
  system.respawn(0, 0, 0);
  system.respawn(1, 0, 0);
  const v = () => ({ vx: 1, vy: 0, ok: true });
  // dt NaN drove every position to NaN and retired the WHOLE field in one step,
  // which on screen is indistinguishable from a data outage.
  assert.throws(() => system.step({ velocityAt: v, dt: NaN }), /dt must be finite and >= 0/);
  assert.throws(() => system.step({ velocityAt: v, dt: Infinity }), /dt must be finite and >= 0/);
  // A negative dt would run age DOWN, so nothing would ever reach its lifetime
  // and buildTrailAlpha would return 0 for the entire field. Backward advection
  // is expressed by negating velocityAt's output.
  assert.throws(() => system.step({ velocityAt: v, dt: -1 }), /dt must be finite and >= 0/);
  assert.throws(() => system.step({ velocityAt: v, integrator: 'rk4' }), /integrator must be/);
  assert.throws(() => system.step({ velocityAt: v, spawn: 'refill' }), /spawn must be a function or null/);
  // dt = 0 is a legal paused frame: no motion, no ageing, no deaths. (respawn
  // gives each particle a random birth phase, so the age to compare against is
  // the one it already had, not 0.)
  const ageBefore = system.age[0];
  assert.ok(ageBefore > 0, 'respawn staggers the birth phase');
  assert.equal(system.step({ velocityAt: v, dt: 0 }), 2);
  assert.equal(system.x[0], 0);
  assert.equal(system.age[0], ageBefore);
  assert.equal(system.alive[1], 1);

  // null reads as "unset" for every optional field, the way a config object
  // carries an absent option; only a wrong VALUE is refused.
  const relaxed = createParticleSystem({ count: 1, seed: 1, minAge: 100, maxAge: 100 });
  relaxed.respawn(0, 0, 0);
  relaxed.age[0] = 0;
  assert.equal(relaxed.step({ velocityAt: v, integrator: null, spawn: null, bounds: null }), 1);
  assert.equal(relaxed.x[0], 1, 'a null integrator steps forward Euler');
});

test('the midpoint integrator labels the segment with the speed at its start', () => {
  // Documented: speedMs is read from the first lookup, before the midpoint
  // lookup can overwrite a reused result object.
  const system = createParticleSystem({ count: 1, seed: 2, minAge: 100, maxAge: 100 });
  system.respawn(0, 0, 0);
  let call = 0;
  const velocityAt = () => {
    call += 1;
    return { vx: 1, vy: 0, ok: true, speedMs: call === 1 ? 0.25 : 9.75 };
  };
  system.step({ velocityAt, dt: 1, integrator: 'midpoint' });
  assert.equal(call, 2, 'midpoint takes two lookups');
  assert.ok(Math.abs(system.speedMs[0] - 0.25) < 1e-6, 'the start-point speed labels the segment');
});

test('createParticleSystem refuses malformed configuration', () => {
  assert.throws(() => createParticleSystem({ count: 0 }), /positive integer/);
  assert.throws(() => createParticleSystem({ count: 2.5 }), /positive integer/);
  assert.throws(() => createParticleSystem({ count: 4, minAge: 0 }), /0 < minAge <= maxAge/);
  assert.throws(() => createParticleSystem({ count: 4, minAge: 10, maxAge: 5 }), /0 < minAge <= maxAge/);
  const system = createParticleSystem({ count: 1 });
  assert.throws(() => system.step({}), /velocityAt/);
  assert.equal(system.ageRange.min, DEFAULT_MIN_AGE);
  assert.equal(system.ageRange.max, DEFAULT_MAX_AGE);
  assert.equal(system.aliveCount(), 0, 'particles start dead: the viewport is unknown');
  assert.equal(Number.isNaN(system.x[0]), true);
});

/* ------------------------------------------------------------------ stats -- */

const STAT_GRID = { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 2, nLon: 3 };

test('fieldStats aggregates finite cells only, over both components', () => {
  // Speeds: (3,4)=5, (null,5)=excluded, (0,0)=0, (6,8)=10, (1,null)=excluded, (8,15)=17
  const stats = fieldStats(payload(
    STAT_GRID,
    [3, null, 0, 6, 1, 8],
    [4, 5, 0, 8, null, 15],
  ));
  assert.equal(stats.total, 6);
  assert.equal(stats.finite, 4, 'a half-observed cell has no defined speed');
  assert.equal(stats.minMs, 0);
  assert.equal(stats.maxMs, 17);
  assert.equal(stats.meanMs, 8); // (5 + 0 + 10 + 17) / 4
  assert.equal(stats.p95Ms, 17); // nearest rank: ceil(0.95*4) - 1 = 3
});

test('fieldStats reports the mean of magnitudes, not the magnitude of the mean', () => {
  // Two opposed 1 m/s cells: the mean current is zero, the mean speed is 1.
  const stats = fieldStats(payload(
    { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 1, nLon: 2 },
    [1, -1],
    [0, 0],
  ));
  assert.equal(stats.meanMs, 1);
  assert.equal(stats.finite, 2);
});

test('fieldStats p95 is nearest rank, with no interpolation between order statistics', () => {
  // Speeds 1..20; ceil(0.95*20) - 1 = 18 -> the 19th smallest = 19.
  // A linear-interpolation estimator (Hyndman & Fan type 7, the R/numpy
  // default) would answer 19.05.
  const u = Array.from({ length: 20 }, (_, i) => i + 1);
  const stats = fieldStats(payload(
    { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 4, nLon: 5 },
    u,
    u.map(() => 0),
  ));
  assert.equal(stats.p95Ms, 19);
  assert.equal(stats.minMs, 1);
  assert.equal(stats.maxMs, 20);
  assert.equal(stats.meanMs, 10.5);

  // n = 20 does NOT separate ceil(0.95n) - 1 from round(0.95(n-1)): both give
  // rank 18. n = 12 does — ceil(11.4) - 1 = 11 against round(10.45) = 10 — so
  // this second population is what actually pins the estimator to type 1.
  const twelve = Array.from({ length: 12 }, (_, i) => i + 1);
  const small = fieldStats(payload(
    { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 3, nLon: 4 },
    twelve,
    twelve.map(() => 0),
  ));
  assert.equal(small.p95Ms, 12, 'rank ceil(0.95*12) - 1 = 11, the largest of 12');

  // And n = 1: ceil(0.95) - 1 = 0, the only order statistic there is.
  const one = fieldStats(payload(
    { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 1, nLon: 1 }, [7], [0],
  ));
  assert.equal(one.p95Ms, 7);
});

test('fieldStats returns nulls, not zeros, when nothing is observed', () => {
  const stats = fieldStats(payload(STAT_GRID, new Array(6).fill(null), new Array(6).fill(null)));
  assert.deepEqual(stats, {
    minMs: null, maxMs: null, meanMs: null, p95Ms: null, finite: 0, total: 6,
  });
});

test('fieldStats survives a single finite cell and rejects length mismatches', () => {
  const single = fieldStats(payload(STAT_GRID, [null, null, 3, null, null, null], [null, null, 4, null, null, null]));
  assert.deepEqual(single, { minMs: 5, maxMs: 5, meanMs: 5, p95Ms: 5, finite: 1, total: 6 });
  assert.throws(() => fieldStats(payload(STAT_GRID, [1, 2, 3], [1, 2, 3])), /payload\.u has 3 entries/);
});

test('fieldStats accepts typed-array components with NaN gaps', () => {
  const stats = fieldStats(payload(
    { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 1, nLon: 3 },
    Float32Array.from([3, NaN, 0]),
    Float32Array.from([4, 1, 0]),
  ));
  assert.equal(stats.finite, 2);
  assert.equal(stats.maxMs, 5);
});

test('fieldStats output feeds the ramp: p95 is a usable adaptive scale', () => {
  // Speeds 0.05, 0.10, ..., 1.00 m/s. p95 = nearest rank ceil(0.95*20) - 1 = 18
  // -> the 19th smallest = 0.95, so the documented scale is max(0.5, 1.9) = 1.9.
  const u = Array.from({ length: 20 }, (_, i) => (i + 1) / 20);
  const stats = fieldStats(payload(
    { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 4, nLon: 5 },
    u,
    u.map(() => 0),
  ));
  assert.ok(Math.abs(stats.p95Ms - 0.95) < 1e-12);
  const scale = Math.max(0.5, 2 * stats.p95Ms);
  assert.ok(Math.abs(scale - 1.9) < 1e-12);

  // The point of an adaptive scale is that the payload's own range lands inside
  // the ramp instead of saturating it: the fastest cell must not clip, and the
  // slow/median/fast cells must come back as three DIFFERENT colours ordered by
  // luminance. Asserting speedColor(x) equals speedColor(x) asserts nothing.
  assert.ok(speedRampT(stats.maxMs, scale) < 1, 'the fastest cell must not clip');
  const slow = speedColor(stats.minMs, scale);
  const mid = speedColor(stats.meanMs, scale, { r: 0, g: 0, b: 0 });
  const fast = speedColor(stats.maxMs, scale, { r: 0, g: 0, b: 0 });
  assert.notDeepEqual({ ...slow }, { ...mid });
  assert.notDeepEqual({ ...mid }, { ...fast });
  assert.ok(relLuminance(slow) < relLuminance(mid));
  assert.ok(relLuminance(mid) < relLuminance(fast));
});

test('an adaptive scale spreads a slow payload that the fixed default compresses', () => {
  // The case the @file block's "prefer max(0.5, 2*p95Ms)" advice is for: a quiet
  // shelf where every cell is under 0.1 m/s. Under DEFAULT_SPEED_SCALE = 1.5 the
  // whole field occupies t in [0.043, 0.226] — one flat teal. The adaptive scale
  // floors at 0.5 and spreads it to [0.079, 0.413], 1.83x the ramp length.
  // (Note the converse: on a fast payload whose p95 exceeds 0.75 m/s the
  // adaptive scale exceeds 1.5 and spreads LESS than the default. It is a
  // normalizer, not a monotone improvement, which is why this test uses the
  // regime the advice actually names.)
  const u = Array.from({ length: 20 }, (_, i) => (i + 1) / 200); // 0.005 .. 0.100 m/s
  const stats = fieldStats(payload(
    { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 4, nLon: 5 }, u, u.map(() => 0),
  ));
  assert.ok(Math.abs(stats.p95Ms - 0.095) < 1e-12);
  const scale = Math.max(0.5, 2 * stats.p95Ms);
  assert.equal(scale, 0.5, 'the 0.5 m/s floor binds on a slow field');
  const adaptiveSpan = speedRampT(stats.maxMs, scale) - speedRampT(stats.minMs, scale);
  const defaultSpan = speedRampT(stats.maxMs, DEFAULT_SPEED_SCALE)
    - speedRampT(stats.minMs, DEFAULT_SPEED_SCALE);
  assert.ok(Math.abs(adaptiveSpan - 0.3332) < 0.001, `adaptive span ${adaptiveSpan}`);
  assert.ok(Math.abs(defaultSpan - 0.1821) < 0.001, `default span ${defaultSpan}`);
  assert.ok(adaptiveSpan > 1.5 * defaultSpan);
});

test('fieldStats refuses a component that is not an Array or typed array', () => {
  // A string, or any `{length: n}` stub, indexes to non-numbers; every one maps
  // to NaN, so the payload would load as a well-formed "no data anywhere"
  // ocean. That is the exact substitution this module exists to refuse.
  assert.throws(
    () => fieldStats(payload(STAT_GRID, 'abcdef', new Array(6).fill(0))),
    /payload\.u must be an Array or a typed array/,
  );
  assert.throws(
    () => fieldStats(payload(STAT_GRID, new Array(6).fill(0), { length: 6 })),
    /payload\.v must be an Array or a typed array/,
  );
  assert.throws(
    () => createFieldSampler(payload(UNIT_GRID, 'abcd', [0, 0, 0, 0])),
    /payload\.u must be an Array or a typed array/,
  );
});
