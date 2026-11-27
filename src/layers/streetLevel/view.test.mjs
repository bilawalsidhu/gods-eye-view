import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  cameraNadir,
  groundUnderCamera,
  viewFocus,
  visibleBbox,
} from './view.js';
import { latToTileY, lonToTileX, tilesForBbox } from './tileMath.js';
import { rayCamera, streetPorts } from '../../testSupport/streetLevelFakes.mjs';
import { bindFakeCesiumCamera } from '../../testSupport/fakeCameraPort.mjs';
import { bindRenderer } from '../../render/rendererOf.js';

const RAD = Math.PI / 180;
/** A viewer 300 m above a street 1,600 m up (Denver-like). */
function viewer({ globeShown, globeHeight }) {
  const view = {
    camera: {
      positionCartographic: {
        longitude: -104.99 * RAD,
        latitude: 39.74 * RAD,
        height: 1900,
      },
    },
    scene: { globe: { show: globeShown, getHeight: () => globeHeight } },
  };
  return bindFakeCesiumCamera(view, streetPorts(view));
}

test('a shown globe answers the ground under the camera', () => {
  assert.equal(
    groundUnderCamera(viewer({ globeShown: true, globeHeight: 1600 })),
    1600,
  );
});

test('without 3D tiles under the camera the terrain answers; a missing sample gives no ground', () => {
  // No tiles drawn there: the terrain answers, globe shown or hidden.
  assert.equal(
    groundUnderCamera(viewer({ globeShown: false, globeHeight: 0 })),
    0,
  );
  assert.equal(
    groundUnderCamera(viewer({ globeShown: true, globeHeight: undefined })),
    null,
  );
  assert.equal(groundUnderCamera({}), null);
  assert.equal(groundUnderCamera(null), null);
});

/** The Denver viewer with Google 3D: no globe, a sampleable rendered surface. */
function google3d(sample) {
  const view = viewer({ globeShown: false, globeHeight: undefined });
  view.scene.sampleHeightSupported = true;
  view.scene.sampleHeight = () => sample;
  return view;
}

test('on Google 3D the rendered surface answers the ground under the camera', () => {
  assert.equal(groundUnderCamera(google3d(1612)), 1612);
});

test('where the 3D tiles answer, they decide, whatever the terrain says', () => {
  const view = google3d(1612);
  // A hidden globe's terrain can be stale (or the bare ellipsoid's 0).
  view.scene.globe.getHeight = () => 0;
  assert.equal(groundUnderCamera(view), 1612);
  // A roof above the camera is not the ground, and tiles still loading
  // (kilometres underground) are not either: unknown, so measured again.
  view.scene.sampleHeight = () => 1950;
  assert.equal(groundUnderCamera(view), null);
  view.scene.sampleHeight = () => -14_886;
  assert.equal(groundUnderCamera(view), null);
  // No tiles there at all: the terrain answers.
  view.scene.sampleHeight = () => undefined;
  assert.equal(groundUnderCamera(view), 0);
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
  for (const lat of lats) for (const lon of lons) points.push([lon, lat]);
  let next = 0;
  const viewer = {};
  bindRenderer(viewer, {
    canvas: { clientWidth: 100, clientHeight: 100 },
    camera: {
      pose: () => ({ lon: 0, lat: 0, height: 1000 }),
    },
    query: {
      // Straight down onto the next grid point, from 1 km above it.
      pickRay() {
        const [lon, lat] = points[next++ % points.length];
        const origin = Cesium.Cartesian3.fromDegrees(lon, lat, 1000);
        const ground = Cesium.Cartesian3.fromDegrees(lon, lat);
        const direction = Cesium.Cartesian3.normalize(
          Cesium.Cartesian3.subtract(ground, origin, new Cesium.Cartesian3()),
          new Cesium.Cartesian3(),
        );
        return { origin, direction };
      },
    },
  });
  return viewer;
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
  const view = {
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
  return bindFakeCesiumCamera(view, streetPorts(view));
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
    tilesForBbox(bbox, 13, { limit: 9, from }).map(
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
