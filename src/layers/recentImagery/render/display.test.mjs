// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';

import { BOX } from '../testDoubles.mjs';
import { createRecentImageryDisplay } from './display.js';

const S30 = { key: 'S30:2026-09-18', product: 'S30', day: '2026-09-18' };
const L30 = { key: 'L30:2026-09-16', product: 'L30', day: '2026-09-16' };
const VIIRS = { key: 'VIIRS:2026-09-20', product: 'VIIRS', day: '2026-09-20' };
const OTHER_BOX = { west: -97.9, south: 30.1, east: -97.6, north: 30.4 };

function fakeHarness() {
  const engine = createFakeEngine();
  return {
    name: 'the fake engine',
    engine,
    /** Each drawn layer as { url, maxLevel, opaque, rectangle, credit, alpha, split, shown }. */
    drawn: () =>
      engine.fake.imageryLayers().map((id) => {
        const { source, alpha, split, shown } = engine.fake.imageryLayer(id);
        return {
          url: source.url,
          maxLevel: source.maxLevel,
          opaque: source.opaque,
          rectangle: { ...source.rectangle },
          credit: source.credit,
          alpha,
          split,
          shown,
        };
      }),
    hideSurface() {
      engine.imagery.surface = () => 'none';
    },
    destroy: () => engine.destroy(),
  };
}

for (const make of [fakeHarness]) {
  const name = make().name;

  test(`${name}: a slot drapes one GIBS template bounded to the box; the same day only restyles it`, () => {
    const h = make();
    try {
      const display = createRecentImageryDisplay(h.engine);
      display.rebind(display.resolveHost());
      assert.deepEqual(display.resolveHost(), {
        identity: h.engine,
        kind: 'globe',
      });
      assert.equal(display.showSlot('a', S30, BOX, { alpha: 0.8 }), true);
      const [drawn] = h.drawn();
      assert.match(
        drawn.url,
        /^https:\/\/gibs-\{s\}\.earthdata\.nasa\.gov\/.*HLS_S30.*\/2026-09-18\/GoogleMapsCompatible_Level12\/\{z\}\/\{y\}\/\{x\}\.png$/,
      );
      assert.equal(drawn.maxLevel, 12);
      assert.equal(drawn.opaque, false);
      assert.equal(drawn.credit, 'NASA GIBS');
      assert.deepEqual(drawn.rectangle, BOX);
      assert.equal(drawn.alpha, 0.8);
      assert.deepEqual(display.getOwned().a, {
        key: 'S30:2026-09-18',
        kind: 'globe',
        alpha: 0.8,
        split: 'none',
      });
      display.showSlot('a', S30, BOX, { alpha: 0.5, splitDirection: 'left' });
      assert.equal(h.drawn().length, 1);
      assert.deepEqual([h.drawn()[0].alpha, h.drawn()[0].split], [0.5, 'left']);
      // Another day or box draws in the slot's place.
      display.showSlot('a', L30, OTHER_BOX, {
        alpha: 0.5,
        splitDirection: 'left',
      });
      assert.equal(h.drawn().length, 1);
      assert.match(h.drawn()[0].url, /HLS_L30/);
      assert.deepEqual(h.drawn()[0].rectangle, OTHER_BOX);
      // VIIRS is a level-9 JPEG overview with no alpha channel.
      display.showSlot('b', VIIRS, BOX, { splitDirection: 'right' });
      const [, viirs] = h.drawn();
      assert.equal(viirs.maxLevel, 9);
      assert.equal(viirs.opaque, true);
      assert.equal(viirs.split, 'right');
      display.setAlpha('b', 7);
      assert.equal(h.drawn()[1].alpha, 1, 'alpha clamps to 0–1');
      display.setSplit(0.3);
      assert.equal(h.engine.imagery.splitPosition(), 0.3);
      display.destroy();
      assert.deepEqual(h.drawn(), []);
      assert.equal(display.showSlot('a', S30, BOX), false, 'destroyed');
    } finally {
      h.destroy();
    }
  });

  test(`${name}: rapid replacement never owns more than two layers`, () => {
    const h = make();
    try {
      const display = createRecentImageryDisplay(h.engine);
      display.rebind(display.resolveHost());
      const days = [S30, L30, VIIRS];
      for (let i = 0; i < 10; i += 1) {
        display.showSlot('a', days[i % 3], BOX);
        display.showSlot('b', days[(i + 1) % 3], BOX);
        if (i % 4 === 0) display.hideSlot('a');
        assert.ok(h.drawn().length <= 2 && display.ownedCount() <= 2);
      }
      display.hideSlot('a');
      display.hideSlot('b');
      assert.deepEqual(h.drawn(), []);
    } finally {
      h.destroy();
    }
  });

  test(`${name}: without a surface a slot refuses and drops its layer`, () => {
    const h = make();
    try {
      const display = createRecentImageryDisplay(h.engine);
      display.rebind(display.resolveHost());
      display.showSlot('a', S30, BOX);
      h.hideSurface();
      const host = display.resolveHost();
      assert.deepEqual(host, { identity: null, kind: 'none' });
      display.rebind(host);
      assert.equal(display.showSlot('a', S30, BOX), false);
      assert.equal(display.ownedCount(), 0);
      assert.deepEqual(h.drawn(), []);
    } finally {
      h.destroy();
    }
  });

  test(`${name}: replacement imagery uses source-owned tile URLs and credit`, () => {
    const h = make();
    try {
      const display = createRecentImageryDisplay(h.engine, {
        tileTemplate: (product, day) =>
          `https://tiles.example/${product}/${day}/{z}/{x}/{y}`,
        credit: 'Example imagery',
      });
      display.rebind(display.resolveHost());
      assert.equal(display.showSlot('a', S30, BOX), true);
      const [drawn] = h.drawn();
      assert.equal(
        drawn.url,
        'https://tiles.example/S30/2026-09-18/{z}/{x}/{y}',
      );
      assert.equal(drawn.credit, 'Example imagery');
      display.destroy();
      assert.deepEqual(h.drawn(), []);
    } finally {
      h.destroy();
    }
  });
}

// The box tool's preview (the Navara box tool's; Cesium's tool draws its own).
test('the box preview is one ground cell, hidden with no box', () => {
  const h = fakeHarness();
  try {
    const display = createRecentImageryDisplay(h.engine);
    const listed = () =>
      h.engine.ground
        .list()
        .find((entry) => entry.id === 'recent-imagery:preview');
    assert.equal(listed(), undefined, 'none before a box');
    display.setBoxPreview(BOX);
    assert.deepEqual(
      { ...listed(), id: undefined },
      {
        id: undefined,
        kind: 'cell',
        count: 1,
        shown: true,
        order: 10,
        animated: false,
      },
    );
    display.setBoxPreview(null);
    assert.equal(listed().shown, false);
    // The press before a drag: a box without area shows nothing.
    display.setBoxPreview(BOX);
    display.setBoxPreview({ ...BOX, east: BOX.west, north: BOX.south });
    assert.equal(listed().shown, false);
    display.destroy();
    assert.equal(listed(), undefined);
  } finally {
    h.destroy();
  }
});
