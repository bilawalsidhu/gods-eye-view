// The view-centred search helpers read the camera through the globe engine
// (src/locations.js searchAndFlyTo and the annotation board hand it to them).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { FEATURE_SOURCE_METHODS } from '../sources/featureSource.js';
import { createAnnotationResolver } from './resolver.js';

const resolver = createAnnotationResolver({
  featureSource: Object.fromEntries(
    FEATURE_SOURCE_METHODS.map((method) => [method, async () => null]),
  ),
});

function lookingDownAt(lon, lat, height = 20000) {
  const engine = createFakeEngine();
  engine.fake.setPose({
    position: geo.cartesian3.fromDegrees(lon, lat, height),
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  });
  return engine;
}

test('viewportBias reads the engine view rectangle', () => {
  const engine = lookingDownAt(-97.7431, 30.2672);
  engine.fake.script('viewRectangle', {
    west: geo.math.toRadians(-98),
    south: geo.math.toRadians(30),
    east: geo.math.toRadians(-97.5),
    north: geo.math.toRadians(30.5),
  });
  assert.equal(
    resolver.viewportBias(engine),
    '30.0000,-98.0000|30.5000,-97.5000',
  );
  engine.fake.script('viewRectangle', undefined);
  assert.equal(resolver.viewportBias(engine), null);
});

test('pickWorldFromScreen tries the depth pick, then the ellipsoid, then the globe', () => {
  const engine = lookingDownAt(-97.7431, 30.2672);
  const depth = geo.cartesian3.fromDegrees(-97.7, 30.3, 210);
  engine.fake.script('pickPosition', depth);
  const picked = resolver.pickWorldFromScreen(engine, 0.5, 0.5);
  assert.ok(
    Math.abs(picked.lat - 30.3) < 1e-9 && Math.abs(picked.height - 210) < 1e-6,
  );
  const [screen] = engine.fake.callsOf('picker.pickPosition')[0].args;
  assert.deepEqual([screen.x, screen.y], [512, 384]);

  engine.fake.script('pickPosition', undefined);
  const ellipsoid = resolver.pickWorldFromScreen(engine, 0.5, 0.5);
  assert.ok(Math.abs(ellipsoid.lon - -97.7431) < 0.01);
  assert.ok(Math.abs(ellipsoid.height) < 1e-3);

  engine.fake.script('pickEllipsoid', undefined);
  engine.fake.script(
    'pickGlobe',
    geo.cartesian3.fromDegrees(-97.71, 30.25, 300),
  );
  const globe = resolver.pickWorldFromScreen(engine, 0.5, 0.5);
  assert.ok(Math.abs(globe.height - 300) < 1e-6);
  engine.fake.script('pickGlobe', undefined);
  assert.equal(resolver.pickWorldFromScreen(engine, 0.5, 0.5), null);
});

test('a depth pick at the camera itself (an overlay at the near plane) is a miss', () => {
  const engine = lookingDownAt(-97.7431, 30.2672);
  // Navara reads a screen-space preview line at the near plane: a point a
  // metre from the camera, 20 km above the ground.
  engine.fake.script(
    'pickPosition',
    geo.cartesian3.fromDegrees(-97.7431, 30.2672, 19999),
  );
  const picked = resolver.pickWorldFromScreen(engine, 0.5, 0.5);
  assert.ok(Math.abs(picked.height) < 1e-3, 'the ellipsoid answers instead');
  // A roof well below the camera is kept.
  engine.fake.script(
    'pickPosition',
    geo.cartesian3.fromDegrees(-97.7431, 30.2672, 400),
  );
  assert.ok(
    Math.abs(resolver.pickWorldFromScreen(engine, 0.5, 0.5).height - 400) <
      1e-6,
  );
});

test('near-view recovery centres on the engine camera when nothing is picked', async () => {
  const engine = lookingDownAt(2.35, 48.85, 10000);
  for (const name of ['pickPosition', 'pickEllipsoid', 'pickGlobe'])
    engine.fake.script(name, undefined);
  const centres = [];
  const placeSearch = {
    textSearch: async (query, centre) => {
      centres.push(centre);
      return [];
    },
  };
  await resolver.placesNearViewRecovery(
    engine,
    'cafe',
    null,
    undefined,
    placeSearch,
  );
  assert.equal(centres.length, 1);
  assert.ok(Math.abs(centres[0].latitude - 48.85) < 1e-9);
  assert.ok(Math.abs(centres[0].longitude - 2.35) < 1e-9);
});
