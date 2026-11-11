import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import {
  markerRows,
  testMarkerAtlas,
} from '../../../testSupport/mapMarkers.mjs';
import { createMapMarkers } from './mapMarkers.js';

test('surface placement keeps overlay anchors aligned, and horizon culling follows the camera', async (t) => {
  const engine = createFakeEngine();
  engine.fake.setPose({
    longitude: 0,
    latitude: 0,
    height: 1e6,
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  });
  engine.fake.script('terrainHeight', 125);
  const display = createMapMarkers(engine, { id: 'markers' });
  t.after(() => {
    display.destroy();
    engine.destroy();
  });
  const anchor = geo.cartesian3.fromDegrees(0, 0);
  const row = { id: 'near', position: anchor, point: { pixelSize: 10 } };
  display.show(true);
  await display.replace([
    row,
    {
      id: 'far',
      position: geo.cartesian3.fromDegrees(180, 0),
      point: { pixelSize: 10 },
    },
  ]);
  assert.equal(row.position, anchor);
  assert.ok(
    Math.abs(geo.cartographic.fromCartesian(anchor).height - 125) < 0.01,
  );
  assert.deepEqual(
    markerRows(engine, 'markers').map(({ id, show }) => [id, show]),
    [
      ['near', true],
      ['far', false],
    ],
  );
  assert.deepEqual(markerRows(engine, 'markers')[0].position, { ...anchor });
  engine.fake.setPose({
    longitude: Math.PI,
    latitude: 0,
    height: 1e6,
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  });
  engine.fake.emit('frames.preRender');
  assert.deepEqual(
    markerRows(engine, 'markers').map(({ show }) => show),
    [false, true],
  );
});

test('replaced or destroyed markers ignore an outstanding atlas decode', async (t) => {
  const engine = createFakeEngine();
  let resolveAtlas;
  const display = createMapMarkers(engine, {
    id: 'markers',
    drawAtlas: () =>
      new Promise((resolve) => {
        resolveAtlas = resolve;
      }),
  });
  t.after(() => {
    display.destroy();
    engine.destroy();
  });
  const sprite = {
    id: 'sprite',
    position: geo.cartesian3.fromDegrees(0, 0),
    billboard: { image: 'fixture', width: 16 },
  };
  const obsolete = display.replace([sprite]);
  await display.replace([
    { id: 'point', position: sprite.position, point: { pixelSize: 10 } },
  ]);
  resolveAtlas(testMarkerAtlas(['fixture']));
  await obsolete;
  assert.deepEqual(
    markerRows(engine, 'markers').map(({ id }) => id),
    ['point'],
  );
  const pending = display.replace([sprite]);
  display.destroy();
  resolveAtlas(testMarkerAtlas(['fixture']));
  await pending;
  assert.deepEqual(engine.movers.list(), []);
});
