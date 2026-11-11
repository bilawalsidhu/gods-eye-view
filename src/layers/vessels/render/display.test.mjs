import { createFakeGroundHarness as fakeHarness } from '../../../testSupport/groundDisplayEngines.mjs';
// The vessels display on the engine contract, on the fake engine and on the
// Cesium engine (real Cesium billboards and polylines over a stub scene:
// they draw nothing but hold what the engine writes): the chevron bank
// (no depth test, centred, screen-aligned, 32 px artwork), handle writes
// committed once per frame, picks by source id, the follow signal, the view and
// the trail on engine.lines with its pick namespace.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';

import { createPickRegistry } from '../../../data/pickRegistry.js';
import { SPRITE_LAYER_ORDER } from '../../../data/spriteOrder.js';
import { vesselTypeCss } from '../../../data/vesselLabels.js';
import { WHITE } from '../../shared/color.js';
import { vesselChevronIcon } from '../icons.js';
import { createVesselsDisplay, vesselAtlasLayout } from './display.js';

const layout = vesselAtlasLayout();
const drawAtlas = async () => ({
  canvas: { width: layout.width, height: layout.height },
  cells: layout.cells,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const near = (actual, expected, label, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );
const CARGO = vesselChevronIcon(vesselTypeCss('Cargo'), false);
const SELECTED = vesselChevronIcon('#ffffff', true);

const HARNESSES = [fakeHarness];

async function setup(makeHarness) {
  const harness = makeHarness();
  harness.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(-73.9, 40.6, 50_000),
  });
  const display = createVesselsDisplay(harness.engine, { drawAtlas });
  await display.whenReady();
  return { ...harness, display };
}

const chevronSets = (engine) =>
  engine.movers
    .list()
    .filter(({ id }) => id.startsWith('ais-live-vessels-chevrons'));

const spec = (record, overrides = {}) => ({
  position: geo.cartesian3.fromDegrees(-73.9, 40.6, 1),
  show: true,
  image: CARGO,
  scale: 0.6,
  rotation: 0,
  id: record,
  ...overrides,
});

/** What a chevron draws. */
function drawn(h, setId, index) {
  const { store } = h.engine.fake.moverSet(setId);
  return {
    id: store.pickIds[index],
    position: {
      x: store.positions[index * 3],
      y: store.positions[index * 3 + 1],
      z: store.positions[index * 3 + 2],
    },
    scale: store.scales[index],
    rotation: store.rotations[index],
    alpha: store.colors[index * 4 + 3],
    show: store.shows[index] === 1,
    cell: store.cellKeys[store.cells[index]],
  };
}

test('the chevron atlas has one 32 px cell per chevron the layer draws', () => {
  for (const icon of [CARGO, SELECTED]) {
    const [u0, v0, u1, v1] = layout.cells[icon];
    near((u1 - u0) * layout.width, 32, 'cell width');
    near((v1 - v0) * layout.height, 32, 'cell height');
  }
});

test('trail picks belong to the trail owner, so no layer reads one as empty space', () => {
  const { findPickOwner } = createPickRegistry();
  assert.equal(findPickOwner('gev-trail:ais-live-vessels-1'), 'trails');
  assert.equal(findPickOwner('gev-trail:flights-1'), 'trails');
  assert.equal(findPickOwner('gev-trailing-contact'), null);
});

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();

  test(`chevrons draw centred, screen-aligned and never depth-tested, written once per frame (${name})`, async () => {
    const h = await setup(makeHarness);
    const { engine, display } = h;
    assert.equal(display.fleet.attached(), false);
    const record = { id: '111', mmsi: '999' };
    // Added before the fleet attaches: drawn once it does.
    const handle = display.fleet.add(spec(record));
    display.fleet.attach({ show: true });
    assert.equal(display.fleet.attached(), true);
    await settle();
    const [listed] = chevronSets(engine);
    assert.equal(listed.count, 1);
    assert.equal(handle.id, record);
    assert.equal(handle.width, 32);
    assert.equal(handle.height, 32);
    assert.equal(handle.disableDepthTestDistance, Number.POSITIVE_INFINITY);
    let chevron = drawn(h, listed.id, 0);
    assert.equal(chevron.id, '111', 'picks name the MMSI');
    near(chevron.scale, 0.6, 'scale');
    assert.equal(chevron.show, true);
    {
      const { options } = engine.fake.moverSet(listed.id);
      assert.equal(options.depthTest, 'always');
      assert.equal(options.sprite.sizePx, 32);
      assert.equal(options.sprite.scaleByDistance ?? null, null);
      assert.equal(options.order, SPRITE_LAYER_ORDER.indexOf('ais'));
      assert.equal(options.pickable, true);
      assert.equal(chevron.cell, CARGO);
    }
    // Writes inside a frame listener commit at its end, once.
    const commits = () => engine.fake.moverSet(listed.id).commits;
    const before = commits?.();
    const moved = geo.cartesian3.fromDegrees(-73.8, 40.6, 1);
    const remove = display.view.on('preRender', () => {
      handle.position = moved;
      handle.rotation = 0.5;
      handle.scale = 0.72;
      handle.image = SELECTED;
      handle.color = handle.color.withAlpha(0.3);
    });
    h.frame();
    remove();
    if (commits) assert.equal(commits(), before + 1);
    chevron = drawn(h, listed.id, 0);
    near(chevron.position.x, moved.x, 'position');
    near(chevron.rotation, 0.5, 'rotation');
    near(chevron.scale, 0.72, 'scale');
    near(chevron.alpha, 0.3, 'alpha');
    assert.equal(chevron.cell, SELECTED);
    // Reads are the display's own copies.
    assert.equal(handle.image, SELECTED);
    assert.equal(handle.color.alpha, 0.3);
    assert.equal(handle.color.red, 1);
    assert.equal(typeof handle.color.withAlpha, 'function');
    handle.show = false;
    await settle();
    assert.equal(drawn(h, listed.id, 0).show, false);
    // Removal moves the last chevron into the hole.
    const other = display.fleet.add(spec({ id: '222', mmsi: '999' }));
    display.fleet.remove(handle);
    await settle();
    assert.equal(chevronSets(engine)[0].count, 1);
    assert.equal(other.gevIndex, 0);
    assert.equal(drawn(h, listed.id, 0).id, '222');
    // Hidden with the layer, shown again.
    display.fleet.setVisible(false);
    await settle();
    assert.equal(chevronSets(engine)[0].count, 0);
    display.fleet.setVisible(true);
    await settle();
    assert.equal(chevronSets(engine)[0].count, 1);
    display.fleet.detach();
    assert.equal(display.fleet.attached(), false);
    assert.equal(chevronSets(engine).length, 0);
    display.destroy();
    assert.equal(engine.movers.list().length, 0, 'no set left behind');
    h.destroy();
  });

  test(`a pick names the vessel record it is of, keyed or not (${name})`, async () => {
    const h = await setup(makeHarness);
    const { display } = h;
    display.fleet.attach({ show: true });
    const keyed = { id: '111', mmsi: '999' };
    const unkeyed = { id: '', mmsi: '' };
    display.fleet.add(spec(keyed));
    const loose = display.fleet.add(spec(unkeyed));
    await settle();
    assert.equal(display.pickedRecord({ id: '111' }), keyed);
    assert.equal(display.pickedRecord({ id: loose.pickId }), unkeyed);
    assert.match(loose.pickId, /^gev-vessel-unkeyed:/);
    assert.equal(display.pickedRecord({ id: 'ae01ce' }), null);
    assert.equal(display.pickedRecord(undefined), null);
    display.fleet.remove(loose);
    assert.equal(display.pickedRecord({ id: loose.pickId }), null);
    display.destroy();
    h.destroy();
  });

  test(`a follow that starts anywhere tells the layer another layer took the camera (${name})`, async () => {
    const h = await setup(makeHarness);
    const { engine, display } = h;
    const changes = [];
    const remove = display.follow.onChanged(() =>
      changes.push(display.follow.active()),
    );
    assert.equal(display.follow.active(), false);
    const handle = engine.camera.follow({
      native: { id: 'flight' },
      position: () => geo.cartesian3.fromDegrees(-73.9, 40.6, 3000),
      viewFrom: { x: 0, y: -100, z: 100 },
    });
    assert.equal(display.follow.active(), true);
    assert.ok(changes.includes(true));
    handle.stop();
    assert.equal(display.follow.active(), false);
    remove();
    display.destroy();
    h.destroy();
  });

  test(`the view reads the engine's camera, horizon, projection and canvas (${name})`, async () => {
    const h = await setup(makeHarness);
    const { engine, display } = h;
    const { view } = display;
    near(view.camera.positionCartographic.height, 50_000, 'height', 1);
    const below = geo.cartesian3.fromDegrees(-73.9, 40.6, 0);
    const farSide = geo.cartesian3.fromDegrees(106.1, -40.6, 0);
    assert.equal(view.horizon().isPointVisible(below), true);
    assert.equal(view.horizon().isPointVisible(farSide), false);
    const screen = view.worldToWindow(below);
    const { width, height } = view.canvasSize();
    assert.deepEqual({ width, height }, engine.host.size());
    near(screen.x, width / 2, 'centre x', 1);
    near(screen.y, height / 2, 'centre y', 1);
    assert.equal(
      view.on('nothing', () => {}),
      null,
    );
    display.destroy();
    h.destroy();
  });

  test(`the trail is a geodesic engine line in the trail pick namespace, dimmed where the scene hides it (${name})`, async () => {
    const h = await setup(makeHarness);
    const { engine, display } = h;
    const trail = display.trails.create({ color: '#00d4ff', width: 2.5 });
    assert.equal(engine.lines.list().length, 0, 'drawn on the first fix');
    const a = geo.cartesian3.fromDegrees(-73.9, 40.6, 2);
    const b = geo.cartesian3.fromDegrees(-73.8, 40.6, 2);
    trail.setPositions([a, a, null, b]);
    const [line] = engine.lines.list();
    assert.match(line.id, /^gev-trail:ais-live-vessels-\d+$/);
    assert.equal(line.points, 2, 'near-duplicates and gaps dropped');
    const base = Cesium.Color.fromCssColorString('#00d4ff');
    {
      const { options } = engine.fake.line(line.id);
      assert.equal(options.arc, 'geodesic');
      assert.equal(options.pickId, line.id);
      assert.equal(options.widthPx, 2.5);
      near(options.color[0], base.red, 'red');
      near(options.color[3], 0.85, 'alpha');
      near(options.color[3] * options.depthFailAlpha, 0.4, 'occluded alpha');
    }
    trail.setVisible(false);
    assert.equal(engine.lines.list()[0].shown, false);
    trail.setPositions([a, b]);
    assert.equal(engine.lines.list()[0].shown, false, 'hidden keeps history');
    assert.equal(engine.lines.list()[0].points, 2);
    trail.setVisible(true);
    trail.setPositions([a]);
    assert.equal(engine.lines.list()[0].points, 0, 'one point draws nothing');
    trail.clear();
    assert.equal(engine.lines.list()[0].points, 0);
    trail.destroy();
    assert.equal(engine.lines.list().length, 0);
    trail.setPositions([a, b]);
    assert.equal(engine.lines.list().length, 0, 'a destroyed trail stays gone');
    // The display releases what the layer left.
    display.trails.create({ color: '#00d4ff' }).setPositions([a, b]);
    assert.equal(engine.lines.list().length, 1);
    display.destroy();
    assert.equal(engine.lines.list().length, 0);
    h.destroy();
  });
}

test('a display destroyed before its atlas is drawn draws nothing', async () => {
  const engine = createFakeEngine();
  let release;
  const display = createVesselsDisplay(engine, {
    drawAtlas: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  display.fleet.attach({ show: true });
  display.fleet.add(spec({ id: '111', mmsi: '999' }));
  await settle();
  display.destroy();
  release({ canvas: {}, cells: layout.cells });
  await display.whenReady();
  assert.equal(engine.movers.list().length, 0);
  engine.destroy();
});

test('a failed atlas warns and leaves the layer without chevrons', async () => {
  const engine = createFakeEngine();
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const display = createVesselsDisplay(engine, {
      drawAtlas: async () => {
        throw new Error('no canvas');
      },
    });
    display.fleet.attach({ show: true });
    display.fleet.add(spec({ id: '111', mmsi: '999' }));
    await display.whenReady();
    assert.equal(engine.movers.list().length, 0);
    assert.equal(warnings.length, 1);
    display.destroy();
  } finally {
    console.warn = warn;
    engine.destroy();
  }
});

test('handles keep the colour they are given as plain copies', async () => {
  const engine = createFakeEngine();
  const display = createVesselsDisplay(engine, { drawAtlas });
  await display.whenReady();
  display.fleet.attach({ show: true });
  const handle = display.fleet.add(spec({ id: '111', mmsi: '999' }));
  const color = WHITE.withAlpha(0.5);
  handle.color = color;
  assert.notEqual(handle.color, color);
  assert.equal(handle.color.alpha, 0.5);
  display.destroy();
  engine.destroy();
});
