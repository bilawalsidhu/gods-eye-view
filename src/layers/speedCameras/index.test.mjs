import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createSpeedCamerasLayer } from './index.js';

/** Viewer stand-in whose camera looks straight down at Brisbane from 25 km. */
function fakeViewer() {
  const focus = Cesium.Cartesian3.fromDegrees(153.0, -27.5);
  return {
    dataSources: {
      _list: [],
      add(value) {
        this._list.push(value);
      },
      remove(value) {
        this._list.splice(this._list.indexOf(value), 1);
      },
    },
    scene: {
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
    },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(153.0, -27.5, 25000),
      pickEllipsoid: () => focus,
      moveEnd: {
        addEventListener() {
          return () => {};
        },
      },
    },
  };
}

function harness(source) {
  const viewer = fakeViewer();
  const overlayEvents = [];
  const layer = createSpeedCamerasLayer({
    source,
    overlayHost: {
      setEntries(...args) {
        overlayEvents.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, overlayEvents };
}

const SNAPSHOT = {
  records: [
    {
      id: 'speed-camera:1',
      osmId: 1,
      latitude: -27.5,
      longitude: 153.0,
      directionDeg: 205,
      maxspeedKph: 100,
      enforcement: null,
      operator: null,
      ref: 'REF-1',
      lastVerified: null,
      source: null,
    },
  ],
  stale: false,
  saturated: false,
};

test('layer requires a fetch source and an overlay host', () => {
  assert.throws(() => createSpeedCamerasLayer({}), TypeError);
  assert.throws(
    () => createSpeedCamerasLayer({ source: { getSnapshot: () => {} } }),
    TypeError,
  );
});

test('update publishes entities, overlay entries and stats', async () => {
  const h = harness({ fetch: async () => SNAPSHOT });
  const updated = await h.layer.update(h.viewer);
  assert.equal(updated, true);
  const dataSource = h.viewer.dataSources._list[0];
  assert.equal(dataSource.entities.values.length, 1);
  assert.equal(h.overlayEvents.length, 1);
  assert.equal(h.overlayEvents[0][0], 'speed-cameras');
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.layer.getStats().status, 'ready');
  assert.deepEqual(h.layer.getAnalystRecords()[0], {
    id: 'speed-camera:1',
    osmId: 1,
    latitude: -27.5,
    longitude: 153,
    maxspeedKph: 100,
    enforcement: null,
    operator: null,
    ref: 'REF-1',
    directionDeg: 205,
    lastVerified: null,
    source: null,
  });
  h.layer.destroy(h.viewer);
});

test('a view inside the last query box reuses records without a request', async () => {
  let fetches = 0;
  const h = harness({
    fetch: async () => {
      fetches++;
      return SNAPSHOT;
    },
  });
  await h.layer.update(h.viewer);
  assert.equal(fetches, 1);
  await h.layer.update(h.viewer);
  assert.equal(fetches, 1, 'same view must be a local re-filter');
  h.layer.destroy(h.viewer);
});

test('late refresh cannot publish after disable or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let signal;
    let resolve;
    const h = harness({
      fetch: (box, abortSignal) =>
        new Promise((done) => {
          signal = abortSignal;
          resolve = done;
        }),
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true, `${action} must abort the in-flight read`);
    resolve(SNAPSHOT);
    assert.equal(await pending, undefined);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.overlayEvents.length, 0);
    if (action === 'disable') h.layer.destroy(h.viewer);
  }
});

test('failed queries keep the last accepted records and box', async () => {
  const h = harness({
    fetch: async () => SNAPSHOT,
  });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().count, 1);
  // Move the view outside the snapped box, then fail the next query.
  h.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    153.4,
    -27.5,
    25000,
  );
  h.viewer.camera.pickEllipsoid = () =>
    Cesium.Cartesian3.fromDegrees(153.4, -27.5);
  const failing = harness({
    fetch: async () => {
      throw new Error('Overpass timed out');
    },
  });
  failing.layer.update(failing.viewer);
  assert.equal(failing.layer.getStats().status, 'loading');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(failing.layer.getStats().error, 'Overpass timed out');
  h.layer.destroy(h.viewer);
  failing.layer.destroy(failing.viewer);
});

test('a camera-less view reports zoom-in and clears records', async () => {
  const viewer = fakeViewer();
  viewer.camera.pickEllipsoid = () => null;
  const h = harness({ fetch: async () => SNAPSHOT });
  h.layer.destroy(viewer);
  const layer = createSpeedCamerasLayer({
    source: { fetch: async () => SNAPSHOT },
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  const updated = await layer.update(viewer);
  // Not false: a zoomed-out view is guidance, not a rejected refresh.
  assert.equal(updated, undefined);
  assert.equal(layer.getStats().status, 'zoom-in');
  layer.destroy(viewer);
});

test('two displays own separate data sources and destruction', async () => {
  const a = harness({ fetch: async () => SNAPSHOT });
  const b = harness({ fetch: async () => ({ ...SNAPSHOT, records: [] }) });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  assert.equal(a.layer.getStats().count, 1);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.viewer.dataSources._list.length, 0);
  assert.equal(b.viewer.dataSources._list.length, 1);
  b.layer.destroy();
});
