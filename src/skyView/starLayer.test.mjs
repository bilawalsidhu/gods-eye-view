import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  COLOR_BUCKETS,
  SIZE_STEPS,
  SPRITE_MIN_R,
  STAR_UPDATE_MS,
  TERRAIN_ALPHA,
  colorBucket,
  createSpriteAtlas,
  createStarField,
  drawStars,
  makeProjector,
  sizeStep,
  starLimit,
  starModel,
  starRadius,
} from './starLayer.js';
import {
  DEG,
  azElToHeadingPitch,
  enuFromAzEl,
  limMag,
  makeView,
  projectAzEl,
  starAzEl,
  starFrame,
} from './skyMath.js';
import { parseSkyData } from './starData.js';

const data = parseSkyData(
  JSON.parse(readFileSync(new URL('./data/stars.json', import.meta.url))),
  JSON.parse(
    readFileSync(new URL('./data/constellations.json', import.meta.url)),
  ),
);
const HOUSTON = { latDeg: 29.7604, lonDeg: -95.3698 };
// 2026-01-15 21:00 CST: Orion is high in the south-east from Houston
// (Betelgeuse az 130.0 el 58.3, Rigel az 158.6 el 49.8, refracted).
const ORION_MS = Date.parse('2026-01-16T03:00:00Z');
const W = 1280;
const H = 800;
const indexOf = (name) =>
  [...data.stars.names].find(([, text]) => text === name)[0];

test('star size from magnitude: r = clamp(0.8 + 0.9 (lim - mag), 1, 7)', () => {
  assert.equal(starRadius(6.5, 6.5), 1);
  assert.equal(starRadius(6.0, 6.5), 1.25);
  assert.ok(Math.abs(starRadius(2.0, 6.5) - 4.85) < 1e-9);
  assert.equal(starRadius(-1.46, 6.5), 7);
  assert.equal(starRadius(5, 5), 1);
  assert.equal(sizeStep(1), 0);
  assert.equal(sizeStep(7), SIZE_STEPS - 1);
  assert.equal(sizeStep(4.85), 8);
});

test('B-V colour buckets: blue to red, unknown = white', () => {
  assert.equal(colorBucket(-0.3), 0);
  assert.equal(colorBucket(0.0), 1);
  assert.equal(colorBucket(0.65), 3);
  assert.equal(colorBucket(1.85), COLOR_BUCKETS.length - 1);
  assert.equal(colorBucket(NaN), 2);
  for (let bv = -0.5; bv < 2.5; bv += 0.05)
    assert.ok(colorBucket(bv) <= colorBucket(bv + 0.05));
});

test('limit = min(user 3..6.5, limMag(sun)); wide view caps the automatic limit at 5.0', () => {
  assert.equal(starLimit({ sunAltDeg: -30, fovDeg: 60 }), 6.5);
  assert.equal(starLimit({ sunAltDeg: -30, fovDeg: 70 }), 6.5);
  assert.equal(starLimit({ sunAltDeg: -30, fovDeg: 71 }), 5.0);
  assert.equal(starLimit({ sunAltDeg: -30, fovDeg: 90, userLimit: 6.2 }), 6.2);
  assert.equal(starLimit({ sunAltDeg: -30, fovDeg: 40, userLimit: 9 }), 6.5);
  assert.equal(starLimit({ sunAltDeg: -30, fovDeg: 40, userLimit: 1 }), 3);
  assert.equal(starLimit({ sunAltDeg: -9, fovDeg: 40 }), limMag(-9));
  assert.equal(starLimit({ sunAltDeg: 20, fovDeg: 40, userLimit: 6.5 }), -4);
});

test('star field: one-matrix batch equals skyMath.starAzEl (refraction on) for every star within 1e-4 deg', () => {
  const field = createStarField(data.stars);
  field.update(ORION_MS, HOUSTON);
  const frame = starFrame(ORION_MS, HOUSTON.latDeg, HOUSTON.lonDeg);
  let worst = 0;
  for (let i = 0; i < data.stars.count; i += 7) {
    const ref = starAzEl(
      frame,
      data.stars.ra[i],
      data.stars.dec[i],
      data.stars.pmRa[i],
      data.stars.pmDec[i],
      { refraction: true },
    );
    if (ref.elDeg < -2) continue;
    const want = enuFromAzEl(ref.azDeg, ref.elDeg);
    const got = [field.pos.e[i], field.pos.n[i], field.pos.u[i]];
    // atan2(|a x b|, a.b): acos loses ~0.02 deg near 1 with float32 inputs
    const dot = want.reduce((sum, v, k) => sum + v * got[k], 0);
    const cross = Math.hypot(
      want[1] * got[2] - want[2] * got[1],
      want[2] * got[0] - want[0] * got[2],
      want[0] * got[1] - want[1] * got[0],
    );
    const angle = Math.atan2(cross, dot) / DEG;
    worst = Math.max(worst, angle);
    assert.ok(Math.abs(field.pos.el[i] - ref.elDeg) < 1e-4, `el star ${i}`);
  }
  assert.ok(worst < 1e-4, `worst ${worst} deg`);
});

test('star field recomputes on the 2 s cadence, a time jump or an observer move', () => {
  const field = createStarField(data.stars);
  assert.equal(field.update(ORION_MS, HOUSTON), true);
  assert.equal(field.update(ORION_MS + STAR_UPDATE_MS - 1, HOUSTON), false);
  assert.equal(field.update(ORION_MS + STAR_UPDATE_MS, HOUSTON), true);
  assert.equal(field.update(ORION_MS - 3600_000, HOUSTON), true);
  assert.equal(
    field.update(ORION_MS - 3600_000, { latDeg: 40, lonDeg: -95.3698 }),
    true,
  );
  assert.equal(
    field.update(
      ORION_MS - 3600_000,
      { latDeg: 40, lonDeg: -95.3698 },
      {
        force: true,
      },
    ),
    true,
  );
});

test('makeProjector = skyMath.projectAzEl (landscape, portrait, roll) to 1e-6 px', () => {
  for (const [w, h] of [
    [1600, 900],
    [900, 1600],
  ])
    for (const view of [
      makeView({ azDeg: 160, elDeg: 40, fovDeg: 60 }),
      makeView({ azDeg: 10, elDeg: 85, fovDeg: 100, rollDeg: 25 }),
    ]) {
      const project = makeProjector(view, w, h);
      for (const [dAz, dEl] of [
        [0, 0],
        [12, 7],
        [-20, -10],
      ]) {
        const az = view.azDeg + dAz;
        const el = Math.min(89, view.elDeg + dEl);
        const a = projectAzEl(az, el, view, w, h);
        const b = project(...enuFromAzEl(az, el));
        assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6);
      }
      assert.equal(
        project(...enuFromAzEl(view.azDeg + 180, -view.elDeg)),
        null,
      );
    }
});

/** Pixel of a sky direction through Cesium's own camera matrices. */
function cesiumPixel(camera, position, azDeg, elDeg, width, height) {
  const toFixed = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const dir = Cesium.Matrix4.multiplyByPointAsVector(
    toFixed,
    new Cesium.Cartesian3(...enuFromAzEl(azDeg, elDeg)),
    new Cesium.Cartesian3(),
  );
  const point = Cesium.Cartesian3.add(
    position,
    Cesium.Cartesian3.multiplyByScalar(dir, 1e5, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const eye = Cesium.Matrix4.multiplyByPoint(
    camera.viewMatrix,
    point,
    new Cesium.Cartesian3(),
  );
  const clip = Cesium.Matrix4.multiplyByVector(
    camera.frustum.projectionMatrix,
    new Cesium.Cartesian4(eye.x, eye.y, eye.z, 1),
    new Cesium.Cartesian4(),
  );
  return {
    x: ((clip.x / clip.w + 1) / 2) * width,
    y: ((1 - clip.y / clip.w) / 2) * height,
  };
}

function cesiumCamera(width, height) {
  const scene = {
    canvas: { clientWidth: width, clientHeight: height, width, height },
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    mapProjection: new Cesium.GeographicProjection(Cesium.Ellipsoid.WGS84),
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    ellipsoid: Cesium.Ellipsoid.WGS84,
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    preRender: new Cesium.Event(),
  };
  const camera = new Cesium.Camera(scene);
  camera.frustum.aspectRatio = width / height;
  return camera;
}

test('ACCEPTANCE: Betelgeuse and Rigel drawn where skyMath az/el through the Cesium camera puts them (<= 1 px)', () => {
  const field = createStarField(data.stars);
  field.update(ORION_MS, HOUSTON);
  const frame = starFrame(ORION_MS, HOUSTON.latDeg, HOUSTON.lonDeg);
  const position = Cesium.Cartesian3.fromDegrees(
    HOUSTON.lonDeg,
    HOUSTON.latDeg,
    16.7,
  );
  const rows = [];
  for (const view of [
    makeView({ azDeg: 145, elDeg: 52, fovDeg: 60 }),
    makeView({ azDeg: 145, elDeg: 54, fovDeg: 25 }),
    makeView({ azDeg: 150, elDeg: 50, fovDeg: 90, rollDeg: 15 }),
  ]) {
    const camera = cesiumCamera(W, H);
    camera.setView({
      destination: position,
      orientation: azElToHeadingPitch(view.azDeg, view.elDeg, view.rollDeg),
    });
    camera.frustum.fov = view.fovDeg * DEG;
    const model = starModel(field, {
      view,
      width: W,
      height: H,
      lim: 6.5,
    });
    for (const name of ['Betelgeuse', 'Rigel']) {
      const i = indexOf(name);
      const k = [...model.index.subarray(0, model.count)].indexOf(i);
      assert.ok(k >= 0, `${name} drawn in ${JSON.stringify(view)}`);
      const ref = starAzEl(
        frame,
        data.stars.ra[i],
        data.stars.dec[i],
        data.stars.pmRa[i],
        data.stars.pmDec[i],
        { refraction: true },
      );
      const want = cesiumPixel(camera, position, ref.azDeg, ref.elDeg, W, H);
      const dx = model.x[k] - want.x;
      const dy = model.y[k] - want.y;
      rows.push({ name, fov: view.fovDeg, d: Math.hypot(dx, dy) });
      assert.ok(
        Math.hypot(dx, dy) <= 1,
        `${name} off by ${Math.hypot(dx, dy)} px`,
      );
    }
  }
  // positions are honest: Betelgeuse up in the south-east at this time
  const b = starAzEl(
    frame,
    data.stars.ra[indexOf('Betelgeuse')],
    data.stars.dec[indexOf('Betelgeuse')],
  );
  assert.ok(b.elDeg > 30 && b.azDeg > 100 && b.azDeg < 200, JSON.stringify(b));
  assert.ok(
    rows.every((r) => r.d < 0.01),
    JSON.stringify(rows),
  );
});

test('ACCEPTANCE: no star drawn fainter than the limit, and none at all in daylight', () => {
  const field = createStarField(data.stars);
  field.update(ORION_MS, HOUSTON);
  const view = makeView({ azDeg: 150, elDeg: 45, fovDeg: 100 });
  for (const sunAltDeg of [30, 0.5, 0, -1, -3, -6, -9, -12, -15, -18, -40]) {
    for (const userLimit of [null, 3, 5.5, 6.5]) {
      const lim = starLimit({ sunAltDeg, fovDeg: view.fovDeg, userLimit });
      const model = starModel(field, { view, width: W, height: H, lim });
      for (let k = 0; k < model.count; k++)
        assert.ok(data.stars.mag[model.index[k]] <= lim, `sun ${sunAltDeg}`);
      if (sunAltDeg >= 0)
        assert.equal(model.count, 0, `daylight sun ${sunAltDeg} draws no star`);
    }
  }
  const night = starModel(field, {
    view,
    width: W,
    height: H,
    lim: starLimit({ sunAltDeg: -40, fovDeg: 100 }),
  });
  assert.ok(night.count > 200, `night count ${night.count}`);
});

test('stars below the horizon are skipped; behind the terrain profile they are dimmed', () => {
  const field = createStarField(data.stars);
  field.update(ORION_MS, HOUSTON);
  const view = makeView({ azDeg: 90, elDeg: 0, fovDeg: 100 });
  const clear = starModel(field, { view, width: W, height: H, lim: 6.5 });
  for (let k = 0; k < clear.count; k++)
    assert.ok(field.pos.el[clear.index[k]] > 0);
  const hills = (az, el) => (el < 0 ? 'below' : el < 5 ? 'terrain' : 'clear');
  const dimmed = starModel(field, {
    view,
    width: W,
    height: H,
    lim: 6.5,
    occlusion: hills,
  });
  assert.equal(dimmed.count, clear.count);
  let low = 0;
  for (let k = 0; k < dimmed.count; k++) {
    const el = field.pos.el[dimmed.index[k]];
    assert.ok(Math.abs(dimmed.alpha[k] - (el < 5 ? TERRAIN_ALPHA : 1)) < 1e-6);
    if (el < 5) low++;
  }
  assert.ok(low > 0);
});

test('sprite atlas: one cell per (colour bucket x size); stars are blitted with drawImage', () => {
  const made = [];
  const calls = [];
  const fakeCtx = new Proxy(
    {},
    {
      get(target, key) {
        if (key in target) return target[key];
        if (key === 'createRadialGradient')
          return () => ({ addColorStop() {} });
        return (...args) => calls.push([key, ...args]);
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    },
  );
  const atlas = createSpriteAtlas((w, h) => {
    const canvas = { width: w, height: h, getContext: () => fakeCtx };
    made.push(canvas);
    return canvas;
  }, 2);
  assert.equal(made.length, 1);
  assert.equal(atlas.cells.length, COLOR_BUCKETS.length);
  assert.ok(atlas.cells.every((row) => row.length === SIZE_STEPS));
  assert.equal(
    calls.filter(([k]) => k === 'arc').length,
    COLOR_BUCKETS.length * SIZE_STEPS,
  );
  const field = createStarField(data.stars);
  field.update(ORION_MS, HOUSTON);
  const model = starModel(field, {
    view: makeView({ azDeg: 150, elDeg: 45, fovDeg: 60 }),
    width: W,
    height: H,
    lim: 6.5,
  });
  calls.length = 0;
  assert.equal(drawStars(fakeCtx, model, atlas), model.count);
  const big = [...model.r.subarray(0, model.count)].filter(
    (r) => r >= SPRITE_MIN_R,
  ).length;
  assert.ok(big > 5 && big < model.count, `big ${big} of ${model.count}`);
  const blits = calls.filter(([k]) => k === 'drawImage');
  assert.equal(blits.length, big, 'bright stars are sprites');
  assert.equal(blits[0][1], made[0]);
  const discs = calls.filter(([k]) => k === 'arc');
  assert.equal(discs.length, model.count - big, 'faint stars are discs');
  const fills = calls.filter(([k]) => k === 'fill');
  assert.ok(fills.length <= COLOR_BUCKETS.length * 2, `fills ${fills.length}`);
  assert.equal(
    createSpriteAtlas(() => null),
    null,
  );
});
