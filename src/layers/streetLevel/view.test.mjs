import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  cameraNadir,
  createHorizonCull,
  groundUnderCamera,
  metresBetween,
  viewFocus,
  visibleBbox,
} from './view.js';
import { latToTileY, lonToTileX, tilesForBbox } from './tileMath.js';
import { rayCamera } from '../../testSupport/streetLevelFakes.mjs';

const RAD = Math.PI / 180;
/** A viewer 300 m above a street 1,600 m up (Denver-like). */
function viewer({ globeShown, globeHeight }) {
  return {
    camera: {
      positionCartographic: {
        longitude: -104.99 * RAD,
        latitude: 39.74 * RAD,
        height: 1900,
      },
    },
    scene: { globe: { show: globeShown, getHeight: () => globeHeight } },
  };
}

test('a shown globe answers the ground under the camera', () => {
  assert.equal(
    groundUnderCamera(viewer({ globeShown: true, globeHeight: 1600 })),
    1600,
  );
});

test('a hidden globe (Google 3D) or a missing sample gives no ground', () => {
  // A hidden globe's getHeight is ignored even when it returns a number.
  assert.equal(
    groundUnderCamera(viewer({ globeShown: false, globeHeight: 0 })),
    null,
  );
  assert.equal(
    groundUnderCamera(viewer({ globeShown: true, globeHeight: undefined })),
    null,
  );
  assert.equal(groundUnderCamera({}), null);
});

/** The Denver viewer with Google 3D: no globe, a sampleable rendered surface. */
function google3d(sample) {
  const view = viewer({ globeShown: false, globeHeight: 0 });
  view.scene.sampleHeightSupported = true;
  view.scene.sampleHeight = () => sample;
  return view;
}

test('on Google 3D the rendered surface answers the ground under the camera', () => {
  assert.equal(groundUnderCamera(google3d(1612)), 1612);
});

test('an implausible or above-camera surface sample gives no ground', () => {
  // Before tiles stream in, sampleHeight can read kilometres underground.
  assert.equal(groundUnderCamera(google3d(-14_886)), null);
  // A roof above the camera (1,900 m) would put the camera underground.
  assert.equal(groundUnderCamera(google3d(1950)), null);
  assert.equal(groundUnderCamera(google3d(undefined)), null);
});

/** A camera whose screen rays land on a grid of lon/lat points. */
function gridViewer(lons, lats) {
  const points = [];
  for (const lat of lats)
    for (const lon of lons)
      points.push(Cesium.Cartesian3.fromDegrees(lon, lat));
  let next = 0;
  return {
    scene: { canvas: { clientWidth: 100, clientHeight: 100 }, globe: {} },
    camera: {
      pickEllipsoid: () => points[next++ % points.length],
      positionCartographic: { longitude: 0, latitude: 0, height: 1000 },
    },
  };
}

test('a view across the date line is a narrow box with west > east', () => {
  const viewer = gridViewer([178, 179, -179, -178], [-1, 0, 1]);
  const bbox = visibleBbox(viewer);
  assert.ok(bbox[0] > 177 && bbox[0] < 179, `west ${bbox[0]}`);
  assert.ok(bbox[2] < -177 && bbox[2] > -179, `east ${bbox[2]}`);
});

test('an ordinary view keeps west < east', () => {
  const bbox = visibleBbox(gridViewer([10, 11, 12], [50, 51]));
  assert.ok(bbox[0] < bbox[2]);
});

/** A pinhole viewer `agl` m above ground `ground` m up, looking north. */
function pinhole({ lon, lat, ground, agl, pitch, w = 1600, h = 900 }) {
  return {
    scene: {
      canvas: { clientWidth: w, clientHeight: h },
      globe: { show: false, ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    camera: rayCamera({
      lon,
      lat,
      altitude: ground + agl,
      pitch,
      width: w,
      height: h,
    }),
  };
}

test('a tilted street view over high ground boxes the streets it looks at, not the horizon', () => {
  // Denver, 600 m above a street 1,610 m up, looking 20° down: the centre of
  // the screen meets the street about 1.65 km north of the camera.
  const view = pinhole({
    lon: -104.99,
    lat: 39.74,
    ground: 1610,
    agl: 600,
    pitch: -20,
  });
  const ahead = 39.74 + 1648 / 111_000;
  const unranged = visibleBbox(view);
  // Without options, rays to the bare ellipsoid travel 1.6 km further down:
  // the box is 20 km wide and starts past the street at the screen centre.
  assert.ok(unranged[2] - unranged[0] > 0.2);
  assert.ok(unranged[1] > ahead, 'the old box missed the street in view');
  const options = { groundHeight: 1610, maxRange: 6000 };
  const [west, south, east, north] = visibleBbox(view, options);
  assert.ok(north - south < 0.08 && east - west < 0.08, 'a street-sized box');
  assert.ok(south < ahead && north > ahead, 'the screen centre is inside');
  assert.ok(
    south > 39.74,
    'it starts ahead of the camera, where the view does',
  );
  assert.ok(west < -104.99 && east > -104.99);
  const nadir = cameraNadir(view);
  assert.ok(
    Math.abs(nadir.lat - 39.74) < 1e-9 && Math.abs(nadir.lon + 104.99) < 1e-9,
  );
});

test('a tilted view from 3 km loads the tile at the centre of the screen', () => {
  // 3 km up, 70° from straight down: the screen centre meets the ground
  // 8.2 km ahead, past the 3 × 3 z13 tiles around the camera's ground point.
  const lon = -121.49;
  const lat = 38.58;
  const view = pinhole({ lon, lat, ground: 10, agl: 3000, pitch: -20 });
  const ranged = { groundHeight: 10, maxRange: 30_000 };
  const bbox = visibleBbox(view, ranged);
  const ahead = lat + 3000 / Math.tan((20 * Math.PI) / 180) / 110_540;
  const centreTile = `${lonToTileX(lon, 13)}/${latToTileY(ahead, 13)}`;
  const chosen = (from) =>
    tilesForBbox(bbox, 13, { limit: 9, from }).tiles.map(
      (tile) => `${tile.x}/${tile.y}`,
    );
  assert.ok(
    !chosen(cameraNadir(view)).includes(centreTile),
    'ranked from the nadir alone, the screen centre is left out',
  );
  const focus = viewFocus(view, ranged);
  assert.ok(focus.lat > lat && focus.lat < ahead, 'between camera and centre');
  assert.ok(chosen(focus).includes(centreTile), 'the screen centre is loaded');
  // The bottom edge of the screen (50° down) meets the ground 2.5 km ahead.
  const nearest = lat + 3000 / Math.tan((50 * Math.PI) / 180) / 110_540;
  assert.ok(
    chosen(focus).includes(`${lonToTileX(lon, 13)}/${latToTileY(nearest, 13)}`),
    'and so is the nearest ground in view',
  );
});

test('looking straight down or at the sky, the focus is the ground under the camera', () => {
  const lon = -121.49;
  const lat = 38.58;
  const down = viewFocus(
    pinhole({ lon, lat, ground: 10, agl: 500, pitch: -90 }),
    { groundHeight: 10, maxRange: 5000 },
  );
  assert.ok(Math.abs(down.lat - lat) < 1e-4 && Math.abs(down.lon - lon) < 1e-4);
  const sky = viewFocus(pinhole({ lon, lat, ground: 10, agl: 2, pitch: 60 }), {
    groundHeight: 10,
    maxRange: 2500,
  });
  assert.ok(Math.abs(sky.lat - lat) < 1e-9 && Math.abs(sky.lon - lon) < 1e-9);
});

test('looking at the horizon from eye height boxes the near ground, not the horizon', () => {
  const view = pinhole({
    lon: -121.4944,
    lat: 38.5816,
    ground: 10,
    agl: 2,
    pitch: -5,
  });
  const [west, south, east, north] = visibleBbox(view, {
    groundHeight: 10,
    maxRange: 2500,
  });
  assert.ok(south > 38.5816 && south - 38.5816 < 0.001, 'from just ahead');
  assert.ok(north - 38.5816 < 2500 / 111_000, 'no further than the range');
  assert.ok(west < -121.4944 && east > -121.4944);
  // Looking at the sky, nothing is in range: no box, never the horizon's.
  const sky = pinhole({
    lon: -121.4944,
    lat: 38.5816,
    ground: 10,
    agl: 2,
    pitch: 60,
  });
  assert.equal(visibleBbox(sky, { groundHeight: 10, maxRange: 2500 }), null);
});

test('metresBetween measures the short way round the date line', () => {
  const east = { lon: 179.9999, lat: 0 };
  const west = { lon: -179.9999, lat: 0 };
  // 0.0002° of longitude at the equator, not 40,000 km round the other way.
  assert.ok(Math.abs(metresBetween(east, west) - 22.264) < 1e-6);
  assert.ok(Math.abs(metresBetween(west, east) - 22.264) < 1e-6);
  assert.ok(
    Math.abs(
      metresBetween({ lon: 180, lat: 0 }, { lon: -180, lat: 0.0001 }) - 11.054,
    ) < 1e-6,
    'the two names of the same meridian',
  );
  // Away from the date line nothing changes.
  assert.ok(
    Math.abs(
      metresBetween({ lon: 10, lat: 0 }, { lon: 10.001, lat: 0 }) - 111.32,
    ) < 1e-9,
  );
});

/**
 * A horizon cull over `items` for a camera the test moves, with the frame's
 * pre-render listeners and a count of the points tested against the horizon.
 */
function cullHarness(t, items) {
  const visible = t.mock.method(
    Cesium.EllipsoidalOccluder.prototype,
    'isPointVisible',
  );
  const preRender = new Set();
  const camera = { positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 1e7) };
  const viewer = {
    camera,
    scene: {
      preRender: {
        addEventListener(listener) {
          preRender.add(listener);
          return () => preRender.delete(listener);
        },
      },
    },
  };
  let changes = 0;
  const cull = createHorizonCull({
    getViewer: () => viewer,
    items: () => items,
    onChange: () => changes++,
  });
  return {
    cull,
    preRender,
    tested: () => visible.mock.callCount(),
    changes: () => changes,
    frame: () => {
      for (const listener of [...preRender]) listener();
    },
    // Moved in place, as Cesium updates positionWC.
    moveTo: (lon, lat) =>
      Cesium.Cartesian3.fromDegrees(
        lon,
        lat,
        1e7,
        undefined,
        camera.positionWC,
      ),
  };
}

const point = (lon, lat) => ({
  position: Cesium.Cartesian3.fromDegrees(lon, lat),
  show: true,
});

test('the horizon cull does no work while the camera stands still', (t) => {
  const near = point(0, 0);
  const far = point(180, 0);
  const h = cullHarness(t, [near, far]);
  h.cull.update();
  assert.equal(h.tested(), 2);
  assert.deepEqual([near.show, far.show], [true, false]);
  assert.equal(h.preRender.size, 1, 'listening for camera moves');
  for (let i = 0; i < 5; i++) h.frame();
  assert.equal(h.tested(), 2, 'a still camera re-culls nothing');
  h.moveTo(180, 0);
  h.frame();
  assert.equal(h.tested(), 4, 'a moved camera re-culls everything once');
  assert.deepEqual([near.show, far.show], [false, true]);
  h.frame();
  h.frame();
  assert.equal(h.tested(), 4, 'and then rests again');
  h.cull.stop();
  assert.equal(h.preRender.size, 0);
});

test('the horizon cull stops listening once nothing is left, and starts again for new items', (t) => {
  const items = [point(0, 0)];
  const h = cullHarness(t, items);
  h.cull.update();
  assert.equal(h.preRender.size, 1);
  // Every item goes (the tiles are dropped); the next camera move finds none.
  items.length = 0;
  h.moveTo(10, 0);
  h.frame();
  assert.equal(h.preRender.size, 0, 'the listener is removed');
  // New items arrive: they are culled now, and camera moves are watched again.
  const far = point(-170, 0);
  items.push(far);
  h.cull.update([far]);
  assert.equal(far.show, false, 'culled on arrival');
  assert.equal(h.preRender.size, 1, 'the listener is back');
  h.moveTo(-170, 0);
  h.frame();
  assert.equal(far.show, true, 're-culled when the camera moves');
  assert.equal(h.changes(), 2, 'a redraw for each change');
  h.cull.stop();
});

/** A cull over `points` ([lon, lat, height]) seen from a camera at `camera`. */
function cullFrom(camera, points) {
  const items = points.map(([lon, lat, height]) => ({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, height),
    show: true,
  }));
  const horizon = createHorizonCull({
    getViewer: () => ({
      camera: { positionWC: Cesium.Cartesian3.fromDegrees(...camera) },
      scene: { preRender: { addEventListener: () => () => {} } },
    }),
    items: () => items,
  });
  horizon.update();
  horizon.stop();
  return items.map((item) => item.show);
}

test('cones and the marker stay visible on ground below the WGS84 ellipsoid', () => {
  // NYC at street level: eye 2.4 m above ground at -22 m, a cone 10 m away.
  assert.deepEqual(
    cullFrom([-74.006, 40.7128, -19.6], [[-74.006, 40.71289, -22]]),
    [true],
  );
  // Colombo framing view: camera at -21 m, cones at -95 m about 80 m away.
  assert.deepEqual(
    cullFrom(
      [79.8612, 6.9271, -21],
      [
        [79.8612, 6.92782, -95],
        [79.86192, 6.9271, -95],
      ],
    ),
    [true, true],
  );
  // Austin, ground well above the ellipsoid.
  assert.deepEqual(
    cullFrom([-97.7431, 30.2672, 132], [[-97.7431, 30.2681, 130]]),
    [true],
  );
});

test('the horizon cull still hides the far side of the Earth from orbit', () => {
  assert.deepEqual(
    cullFrom(
      [0, 0, 20_000_000],
      [
        [10, 10, 0],
        [180, 0, 0],
      ],
    ),
    [true, false],
  );
});
