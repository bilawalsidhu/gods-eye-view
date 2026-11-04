import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PORTS } from '../contract/index.js';
import { createStubRenderer } from '../stub/index.js';
import { toEcef } from '../stub/math.js';
import { CALIBRATION_PATH, REFERENCE_SCENES, sceneSupport } from './scenes.js';
import { compareImages } from './visual.js';

/**
 * The stub behind proxies that throw on any member the contract does not
 * list, so a scene that reaches past the contract fails here.
 */
const MEMBERS = { ...PORTS, handle: { dispose: null, update: null } };

function contractOnly(renderer) {
  const guard = (target, port, prefix = '') =>
    new Proxy(target, {
      get(obj, key, receiver) {
        if (typeof key === 'symbol' || key === 'then')
          return Reflect.get(obj, key, receiver);
        const member = prefix + key;
        if (!(member in MEMBERS[port]))
          throw new Error(`${port}.${member} is not in the contract`);
        const value = Reflect.get(obj, key, receiver);
        if (port === 'draw' && typeof value === 'function')
          return (...args) =>
            guard(
              value.apply(obj, args),
              key === 'field' || key === 'celestial' ? 'handle' : 'drawSet',
            );
        const nested = Object.keys(MEMBERS[port]).some((m) =>
          m.startsWith(`${member}.`),
        );
        if (value && typeof value === 'object' && nested)
          return guard(value, port, `${member}.`);
        return typeof value === 'function' ? value.bind(obj) : value;
      },
    });
  const wrapped = {};
  for (const port of Object.keys(PORTS.renderer)) {
    const value = renderer[port];
    wrapped[port] =
      MEMBERS[port] && typeof value === 'object' ? guard(value, port) : value;
  }
  return wrapped;
}

const ctx = { toEcef, assets: { model: '/models/c172.glb' } };

test('every reference scene builds and disposes on the stub through the contract alone', async () => {
  const ids = new Set();
  for (const scene of REFERENCE_SCENES) {
    assert.ok(!ids.has(scene.id), `${scene.id} is unique`);
    ids.add(scene.id);
    const stub = createStubRenderer();
    // Models report ready once their asset loads; the stub has none to load.
    if (scene.capability === 'models') continue;
    assert.equal(sceneSupport(scene, stub, ctx), null, scene.id);
    const renderer = contractOnly(stub);
    const dispose = await scene.build(renderer, ctx);
    assert.ok(
      stub.testing.sets().length > 0 || scene.family === 'fields',
      `${scene.id} drew something`,
    );
    for (const view of scene.views) renderer.camera.setView(view.view);
    dispose();
    assert.deepEqual(
      stub.testing.sets(),
      [],
      `${scene.id} left nothing behind`,
    );
    assert.ok(scene.views.length > 0, `${scene.id} has views`);
  }
  for (const family of [
    'icons',
    'points',
    'lines',
    'shapes',
    'models',
    'quads',
    'meshes',
    'fields',
    'agents',
    'city',
  ])
    assert.ok(ids.has(family), `a ${family} scene`);
});

test('a scene a renderer cannot draw says why', () => {
  const stub = createStubRenderer({ capabilities: [] });
  const models = REFERENCE_SCENES.find((s) => s.id === 'models');
  assert.equal(sceneSupport(models, stub, ctx), 'no models');
  assert.equal(
    sceneSupport(models, createStubRenderer(), {}),
    'no model asset',
  );
});

test('the calibration path runs from orbit to street over the city scene', () => {
  assert.ok(REFERENCE_SCENES.some((s) => s.id === CALIBRATION_PATH.scene));
  const heights = CALIBRATION_PATH.poses.map((p) => p.destination.height);
  assert.deepEqual(
    heights,
    [...heights].sort((a, b) => b - a),
  );
  assert.ok(heights[0] >= 1e7 && heights.at(-1) <= 100);
});

const image = (w, h, fill) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < data.length; p += 4) data.set(fill(p / 4), p);
  return { width: w, height: h, data };
};

test('the image comparison passes rounding and fails a moved item', () => {
  const base = image(100, 100, (i) =>
    i % 100 > 40 && i % 100 < 60 && i < 5000
      ? [255, 0, 0, 255]
      : [20, 30, 40, 255],
  );
  const rounded = image(100, 100, (i) =>
    [...base.data.slice(i * 4, i * 4 + 3)]
      .map((c) => Math.min(255, c + 2))
      .concat(255),
  );
  assert.equal(compareImages(rounded, base).match, true);
  const moved = image(100, 100, (i) =>
    i % 100 > 10 && i % 100 < 30 && i < 5000
      ? [255, 0, 0, 255]
      : [20, 30, 40, 255],
  );
  const result = compareImages(moved, base);
  assert.equal(result.match, false);
  assert.ok(result.diffFraction > 0.1);
  assert.ok(result.solidPixels > 100);
  assert.equal(
    compareImages(
      image(10, 10, () => [0, 0, 0, 255]),
      base,
    ).match,
    false,
  );
});

test('the image comparison drops one-pixel fringes and catches a small item', () => {
  const blank = image(100, 100, () => [20, 30, 40, 255]);
  // Antialiasing: a one-pixel ring and a one-pixel line differ, nothing solid.
  const fringe = image(100, 100, (i) => {
    const x = i % 100;
    const y = (i - x) / 100;
    const ring = Math.abs(Math.hypot(x - 50, y - 50) - 20) < 0.5;
    return ring || x === 80 ? [200, 200, 200, 255] : [20, 30, 40, 255];
  });
  const fringed = compareImages(fringe, blank);
  assert.ok(fringed.diffPixels > 100, 'many pixels differ');
  assert.equal(fringed.solidPixels, 0);
  assert.equal(fringed.match, true);
  // The smallest reference item: a 4 px point.
  const point = image(100, 100, (i) => {
    const x = i % 100;
    const y = (i - x) / 100;
    return Math.hypot(x - 30.5, y - 30.5) <= 2.2
      ? [255, 0, 0, 255]
      : [20, 30, 40, 255];
  });
  const dropped = compareImages(blank, point);
  assert.ok(dropped.solidPixels > 2, `solid ${dropped.solidPixels}`);
  assert.equal(dropped.match, false);
});

test('the image comparison catches a dropped thin line and a one-pixel shift', () => {
  const at = (fill) =>
    image(200, 200, (i) => {
      const x = i % 200;
      return fill(x, (i - x) / 200) ? [255, 255, 255, 255] : [20, 30, 40, 255];
    });
  const blank = at(() => false);
  // These 160 px lines, 2 and 3 px wide, cover 320 and 480 px: over the
  // 250 px limit. A thin change covering less passes (see visual.js).
  for (const width of [2, 3]) {
    const line = at(
      (x, y) => x >= 20 && x < 180 && y >= 100 && y < 100 + width,
    );
    assert.equal(
      compareImages(blank, line).match,
      false,
      `a dropped ${width} px line`,
    );
  }
  const box = (dx, dy) =>
    at((x, y) => x >= 40 + dx && x < 160 + dx && y >= 50 + dy && y < 150 + dy);
  // A 120×100 box moved leaves strips on the sides it moves across: caught
  // when they cover more than 250 px. Moved 1 px along one axis, it covers 200
  // and passes; these cover more.
  for (const [dx, dy] of [
    [1, 1],
    [2, 0],
    [2, 2],
  ])
    assert.equal(
      compareImages(box(dx, dy), box(0, 0)).match,
      false,
      `a box moved by (${dx}, ${dy})`,
    );
});

test('the image comparison takes pixel data that does not start on a word', () => {
  const base = image(4, 4, () => [20, 30, 40, 255]);
  const bytes = new Uint8ClampedArray(base.data.length + 1);
  bytes.set(base.data, 1);
  const sliced = { width: 4, height: 4, data: bytes.subarray(1) };
  assert.equal(compareImages(sliced, base).match, true);
});

test('a thin change under 250 px passes, as documented', () => {
  const at = (fill) =>
    image(200, 200, (i) => {
      const x = i % 200;
      return fill(x, (i - x) / 200) ? [255, 255, 255, 255] : [20, 30, 40, 255];
    });
  const line = at((x, y) => x >= 20 && x < 100 && y >= 100 && y < 102);
  const result = compareImages(
    at(() => false),
    line,
  );
  assert.equal(result.solidPixels, 0);
  assert.equal(result.mismatchedPixels, 160);
  assert.equal(result.match, true);
});
