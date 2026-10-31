import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  EL_MAX_DEG,
  EL_MIN_DEG,
  FOV_MAX_DEG,
  FOV_MIN_DEG,
  LIM_MAG_TABLE,
  azElFromEnu,
  azElToHeadingPitch,
  dragView,
  enuFromAzEl,
  fovAngles,
  frustumTangents,
  headingPitchToAzEl,
  inertiaStep,
  keyView,
  limMag,
  makeView,
  normalizeAz,
  pinchView,
  projectAzEl,
  skyBoxVisible,
  skyGradient,
  twilightPhase,
  twilightWash,
  unprojectPixel,
  wheelZoomFactor,
  zoomView,
} from './skyMath.js';

const DEG = Math.PI / 180;
const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
const azClose = (a, b, tol, msg) => {
  let d = Math.abs(normalizeAz(a) - normalizeAz(b));
  if (d > 180) d = 360 - d;
  assert.ok(d <= tol, `${msg ?? ''} az ${a} vs ${b}`);
};

test('normalizeAz wraps into [0, 360)', () => {
  assert.equal(normalizeAz(0), 0);
  assert.equal(normalizeAz(360), 0);
  assert.equal(normalizeAz(-90), 270);
  assert.equal(normalizeAz(725), 5);
  assert.equal(normalizeAz(Number.NaN), 0);
});

test('az/el <-> heading/pitch maths round trip within 0.01 deg on a 1-degree grid', () => {
  let worst = 0;
  for (let az = 0; az < 360; az += 1) {
    for (let el = EL_MIN_DEG; el <= EL_MAX_DEG; el += 1) {
      const { heading, pitch } = azElToHeadingPitch(az, el);
      const back = headingPitchToAzEl(heading, pitch);
      const enu = azElFromEnu(enuFromAzEl(az, el));
      worst = Math.max(
        worst,
        Math.abs(back.elDeg - el),
        Math.abs(enu.elDeg - el),
      );
      if (el < 90) {
        azClose(back.azDeg, az, 0.01);
        azClose(enu.azDeg, az, 0.01);
      }
    }
  }
  assert.ok(worst < 0.01, `worst elevation error ${worst}`);
});

test('makeView clamps elevation and fov and wraps azimuth', () => {
  const v = makeView({ azDeg: -30, elDeg: 120, fovDeg: 500 });
  assert.equal(v.azDeg, 330);
  assert.equal(v.elDeg, EL_MAX_DEG);
  assert.equal(v.fovDeg, FOV_MAX_DEG);
  assert.equal(makeView({ elDeg: -45, fovDeg: 1 }).elDeg, EL_MIN_DEG);
  assert.equal(makeView({ fovDeg: 1 }).fovDeg, FOV_MIN_DEG);
});

test('Cesium fov semantics pinned: horizontal in landscape, vertical in portrait', () => {
  for (const [width, height] of [
    [1600, 900],
    [900, 1600],
    [1000, 1000],
  ]) {
    const frustum = new Cesium.PerspectiveFrustum({
      fov: 60 * DEG,
      aspectRatio: width / height,
      near: 1,
      far: 1e7,
    });
    // fovy is computed lazily by the projection matrix.
    void frustum.projectionMatrix;
    const { horizontalDeg, verticalDeg } = fovAngles(60, width, height);
    close(verticalDeg, frustum.fovy / DEG, 1e-9, `vertical ${width}x${height}`);
    const cesiumHorizontal =
      (2 * Math.atan(Math.tan(frustum.fovy / 2) * frustum.aspectRatio)) / DEG;
    close(
      horizontalDeg,
      cesiumHorizontal,
      1e-9,
      `horizontal ${width}x${height}`,
    );
    if (width > height)
      close(horizontalDeg, 60, 1e-9, 'landscape: fov is horizontal');
    else close(verticalDeg, 60, 1e-9, 'portrait/square: fov is vertical');
  }
  // portrait: the narrower horizontal angle
  const portrait = fovAngles(60, 900, 1600);
  assert.ok(portrait.horizontalDeg < 60);
  close(portrait.verticalDeg, 60, 1e-9);
  const landscape = fovAngles(60, 1600, 900);
  assert.ok(landscape.verticalDeg < 60);
  close(landscape.horizontalDeg, 60, 1e-9);
});

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
    requestRender: () => {},
    preRender: new Cesium.Event(),
  };
  const camera = new Cesium.Camera(scene);
  camera.frustum.aspectRatio = width / height;
  return camera;
}

/** Pixel of a sky direction through Cesium's own view and projection matrices. */
function cesiumPixel(camera, position, azDeg, elDeg, width, height) {
  const enu = enuFromAzEl(azDeg, elDeg);
  const toFixed = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const dir = Cesium.Matrix4.multiplyByPointAsVector(
    toFixed,
    new Cesium.Cartesian3(...enu),
    new Cesium.Cartesian3(),
  );
  const point = Cesium.Cartesian3.add(
    position,
    Cesium.Cartesian3.multiplyByScalar(dir, 1000, new Cesium.Cartesian3()),
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

test('projectAzEl matches Cesium view+projection (landscape, portrait, with roll)', () => {
  const position = Cesium.Cartesian3.fromDegrees(-95.3698, 29.7604, 15);
  for (const [width, height] of [
    [1600, 900],
    [900, 1600],
  ]) {
    for (const view of [
      makeView({ azDeg: 0, elDeg: 0, fovDeg: 70 }),
      makeView({ azDeg: 123, elDeg: 35, fovDeg: 40 }),
      makeView({ azDeg: 250, elDeg: 80, fovDeg: 90, rollDeg: 20 }),
      makeView({ azDeg: 10, elDeg: -5, fovDeg: 100, rollDeg: -35 }),
    ]) {
      const camera = cesiumCamera(width, height);
      camera.setView({
        destination: position,
        orientation: azElToHeadingPitch(view.azDeg, view.elDeg, view.rollDeg),
      });
      camera.frustum.fov = view.fovDeg * DEG;
      for (const [dAz, dEl] of [
        [0, 0],
        [10, 5],
        [-15, -8],
        [20, 12],
      ]) {
        const az = view.azDeg + dAz;
        const elv = Math.min(89, view.elDeg + dEl);
        const ours = projectAzEl(az, elv, view, width, height);
        const theirs = cesiumPixel(camera, position, az, elv, width, height);
        assert.ok(ours, 'in front of the camera');
        close(
          ours.x,
          theirs.x,
          1e-3,
          `x ${width}x${height} ${JSON.stringify(view)}`,
        );
        close(
          ours.y,
          theirs.y,
          1e-3,
          `y ${width}x${height} ${JSON.stringify(view)}`,
        );
        const back = unprojectPixel(ours.x, ours.y, view, width, height);
        azClose(back.azDeg, az, 1e-6);
        close(back.elDeg, elv, 1e-6);
      }
    }
  }
});

test('projectAzEl: centre of view at the canvas centre, behind = null', () => {
  const view = makeView({ azDeg: 90, elDeg: 30, fovDeg: 60 });
  const p = projectAzEl(90, 30, view, 800, 600);
  close(p.x, 400, 1e-9);
  close(p.y, 300, 1e-9);
  assert.equal(projectAzEl(270, -30, view, 800, 600), null);
  // landscape fov is horizontal: an object 30 deg right is at the right edge
  const edge = projectAzEl(
    120,
    0,
    makeView({ azDeg: 90, elDeg: 0, fovDeg: 60 }),
    800,
    600,
  );
  close(edge.x, 800, 1e-6);
});

test('frustumTangents reports the aspect', () => {
  assert.equal(frustumTangents(60, 200, 100).aspect, 2);
});

test('drag grabs the sky: pointer right turns the view left, pointer down looks up', () => {
  const view = makeView({ azDeg: 100, elDeg: 20, fovDeg: 60 });
  const right = dragView(view, 100, 0, 1200, 800);
  assert.ok(right.azDeg < 100);
  const down = dragView(view, 0, 100, 1200, 800);
  assert.ok(down.elDeg > 20);
  // 1 canvas width of drag at the horizon = one horizontal fov
  const full = dragView(
    makeView({ azDeg: 100, elDeg: 0, fovDeg: 60 }),
    1200,
    0,
    1200,
    800,
  );
  close(full.azDeg, 40, 1e-9);
  // never flips over the zenith
  assert.equal(dragView(makeView({ elDeg: 85 }), 0, 5000, 1200, 800).elDeg, 90);
});

test('wheel, pinch and +/- zoom change fov within 5..100 deg', () => {
  const view = makeView({ fovDeg: 60 });
  assert.ok(zoomView(view, wheelZoomFactor(-100)).fovDeg < 60);
  assert.ok(zoomView(view, wheelZoomFactor(100)).fovDeg > 60);
  assert.equal(zoomView(view, 1000).fovDeg, FOV_MIN_DEG);
  assert.equal(zoomView(view, 0.001).fovDeg, FOV_MAX_DEG);
  assert.equal(zoomView(view, -1), view);
  close(pinchView(view, view, 100, 200).fovDeg, 30, 1e-9);
  assert.equal(pinchView(view, view, 0, 200), view);
  assert.ok(keyView(view, '+').fovDeg < 60);
  assert.ok(keyView(view, '-').fovDeg > 60);
});

test('keys: arrows look, N faces north, Z looks at the zenith, others ignored', () => {
  const view = makeView({ azDeg: 100, elDeg: 20, fovDeg: 50 });
  assert.equal(keyView(view, 'ArrowLeft').azDeg, 95);
  assert.equal(keyView(view, 'ArrowRight').azDeg, 105);
  assert.equal(keyView(view, 'ArrowUp').elDeg, 25);
  assert.equal(keyView(view, 'ArrowDown').elDeg, 15);
  assert.equal(keyView(view, 'n').azDeg, 0);
  assert.equal(keyView(view, 'Z').elDeg, 90);
  assert.equal(keyView(view, 'q'), null);
});

test('inertia decays to (almost) nothing within 300 ms', () => {
  let v = { az: 0.1, el: -0.05 };
  let total = 0;
  for (let t = 0; t < 300; t += 16) {
    const s = inertiaStep(v, 16);
    total += s.dAz;
    v = s.velocity;
  }
  assert.ok(Math.abs(v.az) < 0.1 * 0.06);
  assert.ok(total > 0 && total < 0.1 * 100);
});

test('limMag table: knots, daylight and night limits', () => {
  for (const [h, m] of LIM_MAG_TABLE) close(limMag(h), m, 1e-12, `knot ${h}`);
  assert.equal(limMag(45), -4);
  assert.equal(limMag(0), -4);
  close(limMag(-3), -1.5, 1e-12);
  close(limMag(-9), 2.25, 1e-12);
  close(limMag(-15), 5, 1e-12);
  assert.equal(limMag(-18), 6.5);
  assert.equal(limMag(-60), 6.5);
  assert.equal(limMag(Number.NaN), -4);
});

test('limMag is monotonic: darker sky never shows fewer stars', () => {
  let previous = limMag(90);
  for (let h = 90; h >= -90; h -= 0.25) {
    const m = limMag(h);
    assert.ok(m >= previous - 1e-12, `limMag(${h})=${m} < ${previous}`);
    previous = m;
  }
});

test('twilight phases', () => {
  assert.equal(twilightPhase(10), 'day');
  assert.equal(twilightPhase(-1), 'civil');
  assert.equal(twilightPhase(-7), 'nautical');
  assert.equal(twilightPhase(-13), 'astronomical');
  assert.equal(twilightPhase(-30), 'night');
  assert.equal(twilightPhase(Number.NaN), 'unknown');
});

test('skybox only after nautical twilight; twilight wash only between 0 and -12', () => {
  assert.equal(skyBoxVisible(10), false);
  assert.equal(skyBoxVisible(-5), false);
  assert.equal(skyBoxVisible(-12), true);
  assert.equal(skyBoxVisible(-40), true);
  assert.equal(skyBoxVisible(Number.NaN), false);
  assert.equal(twilightWash(5), null);
  assert.equal(twilightWash(-12), null);
  assert.equal(twilightWash(-30), null);
  const dusk = twilightWash(-3);
  assert.ok(dusk.alpha > 0 && dusk.alpha <= 0.55);
  assert.match(dusk.zenith, /^rgb\(/);
  assert.ok(twilightWash(-11).alpha < dusk.alpha);
});

test('skyGradient darkens from day to night', () => {
  const lum = (rgb) =>
    rgb
      .match(/\d+/g)
      .map(Number)
      .reduce((a, b) => a + b, 0);
  const day = skyGradient(20);
  const civil = skyGradient(-3);
  const night = skyGradient(-40);
  assert.ok(lum(day.zenith) > lum(civil.zenith));
  assert.ok(lum(civil.zenith) > lum(night.zenith));
  assert.equal(skyGradient(Number.NaN).zenith, night.zenith);
});
