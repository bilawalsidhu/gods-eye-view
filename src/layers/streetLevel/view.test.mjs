import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cameraNadir,
  groundUnderCamera,
  metresBetween,
  viewCentre,
  viewFocus,
  visibleBbox,
} from './view.js';
import { latToTileY, lonToTileX, tilesForBbox } from './tileMath.js';
import { cameraEngine } from '../../testSupport/streetLevelFakes.mjs';

/**
 * The display's view of a fake engine (view.js reads `engine` only): 300 m
 * above a street 1,600 m up (Denver-like), the terrain at `terrain` and the
 * rendered surface at `sample`; `tiles` shows Google 3D (the globe hidden).
 */
async function denver({ terrain, sample, tiles = false }) {
  const engine = cameraEngine({ lon: -104.99, lat: 39.74, altitude: 1900 });
  engine.fake.script('terrainHeight', () => terrain);
  engine.fake.script('sampleHeight', () => sample);
  if (tiles) await engine.maps.setPhotorealTiles({ kind: 'photoreal' });
  return { engine };
}

test('a shown globe answers the ground under the camera', async () => {
  assert.equal(groundUnderCamera(await denver({ terrain: 1600 })), 1600);
});

test('a hidden globe (Google 3D) or a missing sample gives no ground', async () => {
  // A hidden globe's terrain is ignored even when it returns a number.
  assert.equal(
    groundUnderCamera(await denver({ terrain: 0, tiles: true })),
    null,
  );
  assert.equal(groundUnderCamera(await denver({ terrain: undefined })), null);
  assert.equal(groundUnderCamera({}), null);
  assert.equal(groundUnderCamera(null), null);
});

/** The Denver view with Google 3D: no globe, a sampleable rendered surface. */
const google3d = (sample) => denver({ terrain: 0, sample, tiles: true });

test('on Google 3D the rendered surface answers the ground under the camera', async () => {
  assert.equal(groundUnderCamera(await google3d(1612)), 1612);
});

test('an implausible or above-camera surface sample gives no ground', async () => {
  // Before tiles stream in, sampleHeight can read kilometres underground.
  assert.equal(groundUnderCamera(await google3d(-14_886)), null);
  // A roof above the camera (1,900 m) would put the camera underground.
  assert.equal(groundUnderCamera(await google3d(1950)), null);
  assert.equal(groundUnderCamera(await google3d(undefined)), null);
});

/** Straight down from `altitude` over `lon`/`lat` on a 100 px canvas. */
const downAt = (lon, lat, altitude) => ({
  engine: cameraEngine({ lon, lat, altitude, width: 100, height: 100 }),
});

test('a view across the date line is a narrow box with west > east', () => {
  // About ±1° around 180° from 200 km up.
  const bbox = visibleBbox(downAt(180, 0, 200_000));
  assert.ok(bbox[0] > 178 && bbox[0] < 180, `west ${bbox[0]}`);
  assert.ok(bbox[2] < -178 && bbox[2] > -180, `east ${bbox[2]}`);
  // Its middle is on the date line, not at 0°.
  assert.ok(
    Math.abs(Math.abs(viewCentre(downAt(180, 0, 200_000)).lon) - 180) < 0.01,
  );
});

test('an ordinary view keeps west < east', () => {
  const bbox = visibleBbox(downAt(11, 50.5, 50_000));
  assert.ok(bbox[0] < bbox[2]);
  assert.ok(bbox[0] < 11 && bbox[2] > 11 && bbox[1] < 50.5 && bbox[3] > 50.5);
});

test('without an engine or a canvas there is no box, and the centre is the nadir', () => {
  assert.equal(visibleBbox(null), null);
  assert.equal(viewCentre(null), null);
  const view = downAt(11, 50.5, 50_000);
  view.engine.fake.setSize(0, 0);
  assert.equal(visibleBbox(view), null);
  const centre = viewCentre(view);
  assert.ok(
    Math.abs(centre.lon - 11) < 1e-9 && Math.abs(centre.lat - 50.5) < 1e-9,
  );
});

/** A pinhole view `agl` m above ground `ground` m up, looking north. */
function pinhole({ lon, lat, ground, agl, pitch, w = 1600, h = 900 }) {
  return {
    engine: cameraEngine({
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
