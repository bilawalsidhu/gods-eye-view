import test from 'node:test';
import assert from 'node:assert/strict';
import {
  windFrom,
  formatWindSpeed,
  inspectWindAtCenter,
} from './inspection.js';

test('wind directions describe the source of the flow and calm is not north', () => {
  assert.equal(windFrom(10, 0), 'W');
  assert.equal(windFrom(-10, 0), 'E');
  assert.equal(windFrom(0, 10), 'S');
  assert.equal(windFrom(0, -10), 'N');
  assert.equal(windFrom(0, 0), 'Calm');
  assert.equal(formatWindSpeed(10, 'km/h'), '36.0 km/h');
  assert.equal(formatWindSpeed(10, 'mph'), '22.4 mph');
});
test('center inspection uses a fixed forecast reading without double-converting scalar units', () => {
  const snapshot = {
    grid: { nx: 2, ny: 2, lo1: 0, la1: 90, dx: 180, dy: 180 },
    u: Float32Array.from([10, 10, 10, 10]),
    v: new Float32Array(4),
    scalar: {
      kind: 'temperature',
      units: '°C',
      values: Float32Array.from([20, 20, 20, 20]),
    },
  };
  const viewer = {
    camera: { pickEllipsoid: () => ({ longitude: 0, latitude: 0 }) },
    scene: { canvas: { clientWidth: 800, clientHeight: 600 } },
  };
  const cesium = {
    Cartesian2: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    },
    Ellipsoid: { WGS84: {} },
    Cartographic: { fromCartesian: (p) => p },
    Math: { toDegrees: (x) => (x * 180) / Math.PI },
  };
  const result = inspectWindAtCenter(snapshot, viewer, cesium, {
    overlay: 'temperature',
    units: 'km/h',
    model: 'GFS',
    validTime: 'fixed',
    status: 'forecast',
  });
  assert.equal(result.wind, '36.0 km/h from W');
  assert.equal(result.scalarValue, '20.0 °C');
  assert.equal(result.validTime, 'fixed');
  assert.equal(result.coordinates, '0.00°N · 0.00°E');
  viewer.camera.pickEllipsoid = () => null;
  assert.equal(
    inspectWindAtCenter(snapshot, viewer, cesium).coordinates,
    'No surface reading',
  );
});

test('inspection marker follows only its captured point, hides beyond limb, and releases its listener', async () => {
  const { createWindInspectionMarker } = await import('./inspection.js');
  let listener = null;
  let visible = true;
  const projected = [];
  const nodes = [];
  const container = {
    ownerDocument: {
      createElement: () => ({
        style: {},
        setAttribute() {},
        remove() {
          nodes.splice(nodes.indexOf(this), 1);
        },
      }),
    },
    appendChild(node) {
      nodes.push(node);
    },
    getBoundingClientRect: () => ({ left: 5, top: 10 }),
  };
  const viewer = {
    camera: { positionWC: {} },
    scene: {
      mode: 3,
      canvas: {
        clientWidth: 800,
        clientHeight: 600,
        getBoundingClientRect: () => ({ left: 15, top: 30 }),
      },
      postRender: {
        addEventListener(fn) {
          assert.equal(listener, null);
          listener = fn;
          return () => {
            listener = null;
          };
        },
      },
      cartesianToCanvasCoordinates(point) {
        projected.push(point);
        return { x: 100, y: 200 };
      },
      requestRender() {},
    },
  };
  const cesium = {
    SceneMode: { SCENE3D: 3 },
    Ellipsoid: { WGS84: {} },
    EllipsoidalOccluder: class {
      isPointVisible() {
        return visible;
      }
    },
  };
  const owner = createWindInspectionMarker({ container, viewer, cesium });
  const point = { x: 1, y: 2, z: 3 };
  owner.show(point);
  assert.equal(nodes.length, 1);
  assert.match(nodes[0].style.cssText, /pointer-events:none/);
  assert.equal(nodes[0].style.left, '110px');
  assert.equal(nodes[0].style.top, '220px');
  viewer.camera.positionWC = { moved: true };
  visible = false;
  listener();
  assert.equal(nodes[0].hidden, true);
  assert.ok(projected.every((value) => value === point));
  visible = true;
  listener();
  assert.equal(nodes[0].hidden, false);
  owner.show({ x: 4 });
  assert.equal(nodes.length, 1);
  owner.clear();
  assert.equal(nodes.length, 0);
  assert.equal(listener, null);
  owner.show(point);
  owner.destroy();
  owner.destroy();
  assert.equal(nodes.length, 0);
  assert.equal(listener, null);
});
