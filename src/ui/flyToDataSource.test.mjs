import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { cancelCameraArrival } from '../data/cameraArrival.js';
import { createCesiumEngine } from '../globe/cesium/createCesiumEngine.js';
import { createFakeViewer } from '../globe/cesium/testing/fakeViewer.mjs';
import { dataSourcePoints, flyToDataSource } from './flyToDataSource.js';

/** The Cesium engine over a recording viewer, and the sphere flights it made. */
function cesiumEngine() {
  const viewer = createFakeViewer();
  const engine = createCesiumEngine(viewer, { requestRender() {} });
  const calls = () =>
    viewer
      .callsOf('camera.flyToBoundingSphere')
      .map(({ args: [sphere, options] }) => ({ sphere, options }));
  return { viewer, engine, calls };
}

function source() {
  const ds = new Cesium.CustomDataSource('t');
  ds.entities.add({
    position: Cesium.Cartesian3.fromDegrees(-122.4862, 37.7694, -2667),
    billboard: { heightReference: Cesium.HeightReference.CLAMP_TO_GROUND },
  });
  ds.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([
        -122.49, 37.77, -122.48, 37.771,
      ]),
    },
  });
  ds.entities.add({
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray([
        -122.5, 37.76, -122.49, 37.76, -122.49, 37.765,
      ]),
    },
  });
  return ds;
}

test('points come from positions, lines and polygons, as lon/lat only', () => {
  const points = dataSourcePoints(source());
  assert.equal(points.length, 6);
  assert.ok(Math.abs(points[0][0] + 122.4862) < 1e-6);
  assert.ok(Math.abs(points[0][1] - 37.7694) < 1e-6);
});

test('the camera frames the footprint at the surface, never a buried center', () => {
  const { engine, calls } = cesiumEngine();
  assert.equal(flyToDataSource(engine, source()), true);
  const [flight] = calls();
  const center = Cesium.Cartographic.fromCartesian(flight.sphere.center);
  assert.ok(Math.abs(center.height) < 50, `center height ${center.height}`);
  assert.ok(flight.options.offset.range >= 800);
  assert.equal(
    typeof flight.options.complete,
    'function',
    'the ground guard runs on landing',
  );
  assert.equal(
    flyToDataSource(engine, new Cesium.CustomDataSource('empty')),
    false,
  );
  assert.equal(
    calls().length,
    1,
    'empty sources never start deferred navigation',
  );
});

test('a very long track is framed without spreading it into a call', () => {
  // 400k vertices: `push(...line)` throws RangeError (too many arguments)
  // well below this; the walk keeps a bounded sample and both ends.
  const n = 400_000;
  const line = new Array(n);
  for (let i = 0; i < n; i++)
    line[i] = Cesium.Cartesian3.fromDegrees(-120 + (i / n) * 2, 40);
  const ds = new Cesium.CustomDataSource('long');
  ds.entities.add({ polyline: { positions: line } });
  ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(-110, 41) });
  const points = dataSourcePoints(ds);
  assert.equal(points.length, n + 1, 'every vertex contributes to framing');
  const lons = points.map(([lon]) => lon);
  assert.ok(
    lons.reduce((a, b) => Math.min(a, b), Infinity) < -119.99 &&
      lons.reduce((a, b) => Math.max(a, b), -Infinity) > -110.01,
  );
  assert.ok(lons.some((lon) => Math.abs(lon - -118.000005) < 0.01));
});

test('framing includes a sparse interior outlier, walls and rotated overlays', () => {
  const ds = new Cesium.CustomDataSource('bounds');
  const line = Array.from({ length: 200031 }, () =>
    Cesium.Cartesian3.fromDegrees(0, 0),
  );
  line[12345] = Cesium.Cartesian3.fromDegrees(20, 10);
  ds.entities.add({ polyline: { positions: line } });
  ds.entities.add({
    wall: { positions: Cesium.Cartesian3.fromDegreesArray([30, 10, 31, 11]) },
  });
  ds.entities.add({
    rectangle: {
      coordinates: Cesium.Rectangle.fromDegrees(40, 0, 41, 1),
      rotation: Math.PI / 4,
    },
  });
  const points = dataSourcePoints(ds);
  assert.ok(points.some(([lon]) => Math.abs(lon - 20) < 1e-6));
  assert.ok(points.some(([lon]) => Math.abs(lon - 31) < 1e-6));
  assert.ok(points.some(([lon]) => lon > 41));
});

test('portrait framing accounts for FOV, high ground and symmetric extents', () => {
  const ds = new Cesium.CustomDataSource('view');
  ds.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([-105, 39, -104.9, 39]),
    },
  });
  const { viewer, engine, calls } = cesiumEngine();
  viewer.scene.globe.getHeight = () => 2600;
  // A 60° field of view on the narrower side, as Cesium's frustum keeps it:
  // vertical in portrait, horizontal in landscape.
  const { frustum } = viewer.camera;
  frustum.aspectRatio = 390 / 844;
  frustum.fovy = Math.PI / 3;
  flyToDataSource(engine, ds);
  assert.ok(
    Math.abs(
      Cesium.Cartographic.fromCartesian(calls()[0].sphere.center).height - 2600,
    ) < 1e-6,
  );
  assert.equal(calls()[0].options.offset.pitch, -Math.PI / 2);
  frustum.aspectRatio = 16 / 9;
  frustum.fovy = 2 * Math.atan(Math.tan(Math.PI / 6) / frustum.aspectRatio);
  flyToDataSource(engine, ds);
  assert.ok(calls()[0].options.offset.range > calls()[1].options.offset.range);
  const symmetric = {
    entities: {
      values: [
        { position: { getValue: () => new Cesium.Cartesian3(6378137, 0, 0) } },
        { position: { getValue: () => new Cesium.Cartesian3(-6378137, 0, 0) } },
      ],
    },
  };
  assert.doesNotThrow(() => flyToDataSource(engine, symmetric));
  assert.ok(Number.isFinite(calls().at(-1).options.offset.range));
  assert.doesNotThrow(() => calls().at(-1).options.complete());
  cancelCameraArrival(engine);
});

test('non-finite positions and hidden features never enter the camera footprint', () => {
  const position = (p) => ({ position: { getValue: () => p } });
  const points = dataSourcePoints({
    entities: {
      values: [
        position(new Cesium.Cartesian3(NaN, 1, 2)),
        {
          ...position(Cesium.Cartesian3.fromDegrees(10, 10)),
          isShowing: false,
        },
        position(Cesium.Cartesian3.fromDegrees(20, 20)),
      ],
    },
  });
  assert.equal(points.length, 1);
  assert.ok(Math.abs(points[0][0] - 20) < 1e-6);
});

test('on a globe engine the footprint is flown to through flyToSphere, straight down at the surface', async () => {
  const { createFakeEngine } = await import('../globe/testing/fakeEngine.js');
  const engine = createFakeEngine({ kind: 'navara' });
  engine.fake.script('terrainHeight', 120);
  assert.equal(flyToDataSource(engine, source(), { duration: 0.5 }), true);
  const [call] = engine.fake.callsOf('camera.flyToSphere');
  assert.ok(call, 'one sphere flight');
  const [sphere, options] = call.args;
  const center = Cesium.Cartographic.fromCartesian(sphere.center);
  assert.ok(Math.abs(center.height - 120) < 1, 'centre on the terrain');
  assert.ok(sphere.radius > 100);
  assert.equal(options.pitch, -Math.PI / 2);
  assert.equal(options.duration, 0.5);
  assert.ok(options.range >= 800);
  assert.equal(typeof options.complete, 'function');
});
