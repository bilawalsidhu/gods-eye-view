// Layer display behavior on the fake engine.

import assert from 'node:assert/strict';
import test from 'node:test';

import * as geo from '../../../geo/index.js';
import {
  GROUND_HARNESSES,
  createFakeGroundHarness,
} from '../../../testSupport/groundDisplayEngines.mjs';
import { rgbaFromCss } from '../../shared/color.js';
import { GNSS_LEVEL_COLORS } from '../records.js';
import { createGnssDisplay, defaultGnssViewAnchor } from './display.js';

const ALPHA = Object.freeze({ low: 0.3, medium: 0.42, high: 0.55 });
const cells = [
  { id: '280:420', west: 30, south: 50, east: 30.5, north: 50.5, level: 'low' },
  {
    id: '280:421',
    west: 30.5,
    south: 50,
    east: 31,
    north: 50.5,
    level: 'medium',
  },
  {
    id: '281:420',
    west: 30,
    south: 50.5,
    east: 30.5,
    north: 51,
    level: 'high',
  },
];
const fillOf = (level) =>
  rgbaFromCss(GNSS_LEVEL_COLORS[level]).withAlpha(ALPHA[level]).rgba();

const near = (actual, expected, label, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );

for (const makeHarness of GROUND_HARNESSES) {
  const { name } = makeHarness();

  test(`each cell is an unpicked ground cell in its level's colour and alpha (${name})`, () => {
    const h = makeHarness();
    const display = createGnssDisplay(h.engine);
    try {
      assert.equal(h.set('gnss-integrity').shown, false, 'hidden until shown');
      display.setVisible(true);
      display.replace(cells, ALPHA);
      const set = h.set('gnss-integrity');
      assert.equal(set.options.kind, 'cell');
      assert.equal(set.options.pickable, false);
      assert.equal(set.shown, true);
      assert.deepEqual(
        set.items,
        cells.map(({ west, south, east, north, level }) => ({
          west,
          south,
          east,
          north,
          fill: fillOf(level),
        })),
      );

      display.setVisible(false);
      assert.equal(h.set('gnss-integrity').shown, false);

      display.replace([], ALPHA);
      assert.equal(h.set('gnss-integrity').items.length, 0);
    } finally {
      display.destroy();
      display.destroy();
    }
    assert.equal(h.sets(), 0);
    display.replace(cells, ALPHA);
    display.setVisible(true);
    h.destroy();
  });

  test(`the camera and the view anchor are the engine's (${name})`, () => {
    const h = makeHarness();
    h.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(30.2, 50.2, 400_000),
    });
    const display = createGnssDisplay(h.engine);
    assert.equal(display.camera, h.engine.camera);
    const anchor = display.anchor();
    near(anchor.latitude, 50.2, 'latitude', 0.01);
    near(anchor.longitude, 30.2, 'longitude', 0.01);
    display.destroy();
    const seen = [];
    const custom = createGnssDisplay(h.engine, {
      viewAnchor: (engine) => {
        seen.push(engine);
        return { latitude: 1, longitude: 2 };
      },
    });
    assert.deepEqual(custom.anchor(), { latitude: 1, longitude: 2 });
    assert.deepEqual(seen, [h.engine]);
    custom.destroy();
    h.destroy();
  });
}

test('the anchor under a globe-wide view is the screen centre (the fake engine)', () => {
  const h = createFakeGroundHarness();
  h.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(-97, 30, 20_000_000),
  });
  const anchor = defaultGnssViewAnchor(h.engine);
  near(anchor.latitude, 30, 'latitude', 0.5);
  near(anchor.longitude, -97, 'longitude', 0.01);
  h.destroy();
});
