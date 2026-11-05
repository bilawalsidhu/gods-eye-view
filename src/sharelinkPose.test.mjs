// Share links read the camera through the globe engine and write heading and
// roll the way Cesium's camera reports them (in (0, 2π]), so a link made on
// any engine reads as one made on Cesium.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from './geo/index.js';
import { createFakeEngine } from './globe/testing/fakeEngine.js';
import { ShareLinkManager } from './sharelink.js';

function linkFor(pose) {
  globalThis.window = { location: { hash: '', href: 'http://localhost/' } };
  const engine = createFakeEngine();
  engine.fake.setPose(pose);
  const manager = new ShareLinkManager(engine);
  const params = new URLSearchParams(manager._buildHashParams().toString());
  manager.destroy();
  return Object.fromEntries(
    ['lat', 'lon', 'alt', 'heading', 'pitch', 'roll'].map((k) => [
      k,
      params.get(k),
    ]),
  );
}

const at = (heading, pitch, roll = 0) => ({
  position: geo.cartesian3.fromDegrees(-73.9857, 40.7484, 1800),
  heading: geo.math.toRadians(heading),
  pitch: geo.math.toRadians(pitch),
  roll: geo.math.toRadians(roll),
});

test('a level north-facing view writes heading and roll 360, as Cesium reports them', () => {
  assert.deepEqual(linkFor(at(0, -30)), {
    lat: '40.7484',
    lon: '-73.9857',
    alt: '1800',
    heading: '360',
    pitch: '-30',
    roll: '360',
  });
});

test('a straight-down view writes roll 0; other angles round as before', () => {
  const down = linkFor(at(0, -90));
  assert.equal(down.heading, '360');
  assert.equal(down.roll, '0');
  assert.equal(down.pitch, '-90');
  const oblique = linkFor(at(45.4, -29.6, 2));
  assert.deepEqual(
    [oblique.heading, oblique.pitch, oblique.roll],
    ['45', '-30', '2'],
  );
  assert.equal(linkFor(at(359.7, -30)).heading, '360');
});

test('the camera changed event schedules a hash update and destroy unsubscribes', () => {
  globalThis.window = { location: { hash: '', href: 'http://localhost/' } };
  const engine = createFakeEngine();
  const manager = new ShareLinkManager(engine);
  assert.equal(engine.camera.changed.numberOfListeners, 1);
  manager.destroy();
  assert.equal(engine.camera.changed.numberOfListeners, 0);
});
