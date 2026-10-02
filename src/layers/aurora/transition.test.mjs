import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuroraRaster,
  createAuroraRendering,
  sampleProbability,
  AURORA_TRANSITION_MS,
  AURORA_SHELL_STACK,
} from './rendering.js';
import {
  dipoleAxis,
  mltRotationRadians,
  rotateAbout,
  unitVector,
} from './magneticLocalTime.js';

/**
 * Rotate a whole field about an axis, sampled directly.
 *
 * Deliberately not built with createAuroraRaster: the expected field in the
 * slide test must not come from the function being tested, or the test would
 * only prove the code agrees with itself.
 *
 * @param {object} field Source snapshot.
 * @param {object} axis Unit axis.
 * @param {number} radians Rotation to apply.
 * @returns {object} A snapshot of the rotated field.
 */
function rotateField(field, axis, radians) {
  const { nx, ny } = field.grid;
  const probabilities = new Array(nx * ny);
  for (let lat = 0; lat < ny; lat += 1) {
    for (let lon = 0; lon < nx; lon += 1) {
      const v = rotateAbout(unitVector(lat - 90, lon), axis, -radians);
      probabilities[lat * nx + lon] = sampleProbability(
        field,
        (Math.asin(Math.max(-1, Math.min(1, v.z))) * 180) / Math.PI,
        (Math.atan2(v.y, v.x) * 180) / Math.PI,
      );
    }
  }
  return { grid: field.grid, probabilities };
}

/** A grid with one bright patch, so movement is measurable. */
function fieldWith(peakLatDeg, peakLonDeg, nx = 360, ny = 181) {
  const probabilities = new Array(nx * ny).fill(0);
  for (let lat = 0; lat < ny; lat += 1) {
    for (let lon = 0; lon < nx; lon += 1) {
      const dLat = lat - 90 - peakLatDeg;
      let dLon = lon - peakLonDeg;
      dLon = ((((dLon + 180) % 360) + 360) % 360) - 180;
      const r2 = dLat * dLat + dLon * dLon * 0.2;
      probabilities[lat * nx + lon] = Math.round(100 * Math.exp(-r2 / 50));
    }
  }
  return {
    grid: { nx, ny, lo1: 0, la1: -90, dx: 1, dy: 1 },
    probabilities,
  };
}

/** Brightest cell of a raster, as grid coordinates. */
function peakOf(raster) {
  let best = -1;
  let at = null;
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      // Alpha carries the probability ramp monotonically.
      const a = raster.rgba[(y * raster.width + x) * 4 + 3];
      if (a > best) {
        best = a;
        at = { latitudeDeg: raster.height - 1 - y - 90, longitudeDeg: x };
      }
    }
  }
  return at;
}

test('bilinear sampling reads grid cells exactly and interpolates between them', () => {
  const field = {
    grid: { nx: 4, ny: 3, lo1: 0, la1: -90, dx: 1, dy: 1 },
    probabilities: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 10],
  };
  // On a cell centre the sample is that cell.
  assert.equal(sampleProbability(field, -90, 1), 10);
  assert.equal(sampleProbability(field, -89, 2), 60);
  // Halfway between two cells is their mean.
  assert.equal(sampleProbability(field, -90, 1.5), 15);
  // Column 1 holds 10 on the first row and 50 on the second, so halfway is 30.
  assert.equal(sampleProbability(field, -89.5, 1), 30);
  // Longitude wraps rather than clamping: 3.5 sits between column 3 and 0.
  assert.equal(sampleProbability(field, -90, 3.5), 15);
  assert.equal(sampleProbability(field, -90, 360), 0);
  // Latitude clamps, because there is no cell past the pole.
  assert.equal(sampleProbability(field, -200, 0), 0);
  assert.equal(sampleProbability(field, 200, 0), 80);
});

test('with no transition the raster is byte-for-byte the direct copy', () => {
  // The common path must not change just because the blending path exists.
  const field = fieldWith(68, 250);
  const plain = createAuroraRaster(field);
  for (const transition of [
    null,
    { previous: null, mix: 0.5, axis: dipoleAxis(new Date()) },
    { previous: field, mix: 0, axis: dipoleAxis(new Date()) },
    { previous: field, mix: 1, axis: dipoleAxis(new Date()) },
  ]) {
    const got = createAuroraRaster(field, transition);
    assert.deepEqual(got.rgba, plain.rgba, `transition ${JSON.stringify(transition?.mix)}`);
  }
});

test('blending a field with itself at zero rotation is the identity', () => {
  // The resampling path and the direct path must agree, or every transition
  // would start with a visible jolt as one handed over to the other.
  const field = fieldWith(68, 250);
  const plain = createAuroraRaster(field);
  const blended = createAuroraRaster(field, {
    previous: field,
    mix: 0.5,
    axis: dipoleAxis(new Date()),
    rotationRadians: 0,
  });
  assert.deepEqual(blended.rgba, plain.rgba);
});

test('the oval slides between forecasts instead of ghosting', () => {
  // Two forecasts five minutes apart: the same oval, turned in magnetic local
  // time. Blended flat it would dissolve in one place and appear in another.
  // Rotated to a shared frame first, the peak should travel monotonically.
  const from = new Date('2026-10-02T03:18:00Z');
  const to = new Date('2026-10-02T03:23:00Z');
  const rotationRadians = mltRotationRadians(from, to);
  const axis = dipoleAxis(to);

  const previous = fieldWith(68, 250);
  // The newer forecast is the older one turned by exactly the magnetic local
  // time step, so a correct blend has to walk the peak from one to the other.
  const current = rotateField(previous, axis, rotationRadians);

  const peaks = [0, 0.25, 0.5, 0.75, 1].map((mix) =>
    peakOf(createAuroraRaster(current, { previous, mix, axis, rotationRadians })),
  );
  const longitudes = peaks.map((p) => p.longitudeDeg);
  // It must actually move, and in one direction.
  assert.notEqual(longitudes[0], longitudes.at(-1), 'the peak never moved');
  const deltas = longitudes.slice(1).map((v, i) => v - longitudes[i]);
  assert.ok(
    deltas.every((d) => d >= 0) || deltas.every((d) => d <= 0),
    `the peak doubled back: ${longitudes.join(' -> ')}`,
  );
  // And it must stay a single peak rather than splitting into two ghosts.
  for (const mix of [0.25, 0.5, 0.75]) {
    const raster = createAuroraRaster(current, { previous, mix, axis, rotationRadians });
    const brightest = Math.max(...raster.rgba.filter((_, i) => i % 4 === 3));
    const plainPeak = Math.max(
      ...createAuroraRaster(current).rgba.filter((_, i) => i % 4 === 3),
    );
    assert.ok(
      brightest >= plainPeak * 0.9,
      `mix ${mix} dimmed the peak to ${brightest} from ${plainPeak}, which is what ghosting looks like`,
    );
  }
});

/** Minimal renderer harness: records the canvases handed to the shells. */
function renderingHarness() {
  const images = [];
  const canvases = [];
  const makeCanvas = () => {
    const canvas = {
      id: canvases.length,
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
      }),
    };
    canvases.push(canvas);
    return canvas;
  };
  let clock = 1000;
  const rendering = createAuroraRendering({
    viewer: { scene: { requestRender: () => {} } },
    cesium: { Rectangle: { MAX_VALUE: Symbol('r') } },
    getHost: () => ({ kind: 'globe', collection: {} }),
    createCanvas: makeCanvas,
    now: () => clock,
    createSurface: () => ({
      setImage: (image) => images.push(image),
      setAlpha() {},
      destroy() {},
    }),
  });
  return {
    rendering,
    images,
    canvases,
    advanceClock: (ms) => {
      clock += ms;
    },
  };
}

test('consecutive forecasts transition; anything else installs outright', () => {
  const a = { ...fieldWith(68, 250), forecastTime: '2026-10-02T04:32:00Z' };
  const b = { ...fieldWith(68, 252), forecastTime: '2026-10-02T04:37:00Z' };

  const first = renderingHarness();
  first.rendering.setField(a);
  assert.equal(first.rendering.isTransitioning(), false, 'nothing to blend from');

  first.rendering.setField(b);
  assert.equal(first.rendering.isTransitioning(), true);

  // An older or identical forecast is not a continuation, so it must not blend
  // backwards; that would run the oval the wrong way.
  const second = renderingHarness();
  second.rendering.setField(b);
  second.rendering.setField(a);
  assert.equal(second.rendering.isTransitioning(), false);
});

test('a transition advances to completion and then stops', () => {
  const a = { ...fieldWith(68, 250), forecastTime: '2026-10-02T04:32:00Z' };
  const b = { ...fieldWith(68, 252), forecastTime: '2026-10-02T04:37:00Z' };
  const h = renderingHarness();
  h.rendering.setField(a);
  h.rendering.setField(b);

  assert.equal(h.rendering.advance(), true, 'still mid-transition');
  h.advanceClock(AURORA_TRANSITION_MS / 2);
  assert.equal(h.rendering.advance(), true);
  h.advanceClock(AURORA_TRANSITION_MS);
  assert.equal(h.rendering.advance(), false, 'must finish');
  assert.equal(h.rendering.isTransitioning(), false);
  assert.equal(h.rendering.advance(), false, 'and stay finished');
});

test('successive frames alternate canvases so the texture actually re-uploads', () => {
  // shellRendering.setImage ignores a value identical to the one it holds, so
  // repainting one canvas in place would silently freeze the oval.
  const a = { ...fieldWith(68, 250), forecastTime: '2026-10-02T04:32:00Z' };
  const b = { ...fieldWith(68, 252), forecastTime: '2026-10-02T04:37:00Z' };
  const h = renderingHarness();
  h.rendering.setField(a);
  h.rendering.setField(b);
  h.advanceClock(200);
  h.rendering.advance();
  h.advanceClock(200);
  h.rendering.advance();

  // One entry per shell per paint.
  const perPaint = AURORA_SHELL_STACK.length;
  const paints = [];
  for (let i = 0; i < h.images.length; i += perPaint)
    paints.push(h.images[i]);
  assert.ok(paints.length >= 3, `only ${paints.length} paints`);
  for (let i = 1; i < paints.length; i += 1)
    assert.notEqual(
      paints[i],
      paints[i - 1],
      `paint ${i} reused the previous canvas and would not upload`,
    );
  assert.equal(h.canvases.length, 2, 'two buffers is enough; more is a leak');
});

test('clearing mid-transition leaves nothing running', () => {
  const a = { ...fieldWith(68, 250), forecastTime: '2026-10-02T04:32:00Z' };
  const b = { ...fieldWith(68, 252), forecastTime: '2026-10-02T04:37:00Z' };
  const h = renderingHarness();
  h.rendering.setField(a);
  h.rendering.setField(b);
  assert.equal(h.rendering.isTransitioning(), true);
  h.rendering.clear();
  assert.equal(h.rendering.isTransitioning(), false);
  assert.equal(h.rendering.advance(), false);
});

test('republishing the same forecast is a no-op, not a rebuild', () => {
  // SWPC serves the same forecast between polls more often than not. Treating
  // that as a new field would rebuild nine shells to draw identical pixels, and
  // would restart a transition already in flight.
  const a = { ...fieldWith(68, 250), forecastTime: '2026-10-02T04:32:00Z' };
  const same = { ...fieldWith(68, 250), forecastTime: '2026-10-02T04:32:00Z' };
  const h = renderingHarness();
  h.rendering.setField(a);
  const paintsAfterFirst = h.images.length;
  h.rendering.setField(same);
  assert.equal(h.images.length, paintsAfterFirst, 'redrew an unchanged field');
  assert.equal(h.rendering.isTransitioning(), false);

  // And it must not block a genuinely newer forecast afterwards.
  const b = { ...fieldWith(68, 252), forecastTime: '2026-10-02T04:37:00Z' };
  h.rendering.setField(b);
  assert.equal(h.rendering.isTransitioning(), true);
});
