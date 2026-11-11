import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../../geo/index.js';
import { createGroundClick, groundClickHeightOk } from './groundClick.js';
import * as scenePick from '../../data/scenePick.js';
import { cameraEngine } from '../../testSupport/streetLevelFakes.mjs';

const GROUND = geo.cartesian3.fromDegrees(-121.4944, 38.5816, 10);
const TILESET = { isCesium3DTileset: true };

/**
 * A layer state with providers `{id, on, groundClick, configured, available}`;
 * `picked` is where the depth buffer lands, `ellipsoid` the fallback hit.
 */
function harness({
  providers = [
    { id: 'mapillary', groundClick: false },
    { id: 'google', groundClick: true },
  ],
  height = 400,
  enabled = true,
  picked = GROUND,
  ellipsoid = undefined,
} = {}) {
  const opened = [];
  // The display's engine: the camera `height` m up, the depth buffer and the
  // ellipsoid as scripted.
  const engine = cameraEngine({
    lon: -121.4944,
    lat: 38.5816,
    altitude: height,
  });
  engine.fake.script('pickPosition', () => picked);
  engine.fake.script('pickEllipsoid', () => ellipsoid);
  const state = {
    enabled,
    services: { scenePick },
    providers: new Map(
      providers.map(
        ({
          id,
          on = true,
          groundClick,
          configured = true,
          available = true,
        }) => [
          id,
          { on, def: { id, groundClick }, status: { configured }, available },
        ],
      ),
    ),
    map: { engine },
  };
  const openAtGround = createGroundClick({
    state,
    openNearest: (point, options) => {
      opened.push({ point, options });
      return Promise.resolve(true);
    },
    isAvailable: (entry) => entry.available,
  });
  return { opened, openAtGround };
}

const near = (point) =>
  Math.abs(point.lon - -121.4944) < 1e-9 &&
  Math.abs(point.lat - 38.5816) < 1e-9;

test('a click on the map opens the click-to-open providers there, without moving the camera', () => {
  for (const picked of [undefined, { primitive: TILESET }, { content: {} }]) {
    const { opened, openAtGround } = harness();
    openAtGround({ x: 10, y: 20 }, picked);
    assert.equal(opened.length, 1, JSON.stringify(picked));
    assert.ok(near(opened[0].point));
    assert.deepEqual(opened[0].options, {
      providerIds: ['google'],
      frame: false,
    });
  }
});

test('where the depth buffer names no place, the ellipsoid answers', () => {
  const { opened, openAtGround } = harness({
    picked: geo.cartesian3.create(500, 0, 0),
    ellipsoid: GROUND,
  });
  openAtGround({ x: 1, y: 1 });
  assert.ok(near(opened[0].point));
});

test('nothing opens over another layer’s object, the sky, from high up, off its map stack, or with the provider off', () => {
  const cases = [
    { picked: { id: { id: 'flight:1' } }, label: 'an entity' },
    { picked: { id: 'cctv:7', primitive: TILESET }, label: 'an id on a tile' },
    { options: { picked: null, ellipsoid: undefined }, label: 'the sky' },
    { options: { height: 5000 }, label: 'high up' },
    {
      options: {
        providers: [{ id: 'google', groundClick: true, available: false }],
      },
      label: 'not Google 3D',
    },
    {
      options: { providers: [{ id: 'google', groundClick: true, on: false }] },
      label: 'off',
    },
    {
      options: {
        providers: [{ id: 'google', groundClick: true, configured: false }],
      },
      label: 'no key',
    },
    { options: { enabled: false }, label: 'layer off' },
  ];
  for (const { picked, options = {}, label } of cases) {
    const { opened, openAtGround } = harness(options);
    assert.equal(openAtGround({ x: 1, y: 1 }, picked), false, label);
    assert.equal(opened.length, 0, label);
  }
});

test('street zoom is measured above the ground under the camera', () => {
  const map = (height) => {
    const engine = cameraEngine({ lon: 0, lat: 0, altitude: height });
    engine.fake.script('terrainHeight', () => 1500);
    return { engine };
  };
  // 1,500 m up a plateau, 2,000 m above it: still a street.
  assert.equal(groundClickHeightOk(map(3500)), true);
  assert.equal(groundClickHeightOk(map(5000)), false);
  assert.equal(groundClickHeightOk(null), false);
});
