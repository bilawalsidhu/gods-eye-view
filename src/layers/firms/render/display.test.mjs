// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';

import { SPRITE_LAYER_ORDER } from '../../../data/spriteOrder.js';
import { constantRgba } from '../../shared/color.js';
import { createFirmsDisplay } from './display.js';
import { FIRMS_SPRITE_ORDER } from './sprites.js';

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};
const FIRE = { lon: -98.2, lat: 30.5 };
const at = (lon, lat, height = 0) =>
  geo.cartesian3.fromDegrees(lon, lat, height);
// Glow PNGs as their size: `glow-<side>`.
const loadImage = async (url) => {
  const side = Number(url.split('-')[1]);
  return { width: side, height: side };
};
const createCanvas = () => ({
  width: 0,
  height: 0,
  getContext: () => ({ drawImage() {} }),
});

// What each ground set was given, by id.
function watchGround(engine) {
  const items = new Map();
  const createSet = engine.ground.createSet.bind(engine.ground);
  engine.ground.createSet = (options) => {
    const set = createSet(options);
    const { replace } = set;
    set.replace = (next) => {
      replace(next);
      items.set(options.id, next);
    };
    return set;
  };
  return {
    items: (id) => items.get(id) ?? [],
    listed: (id) => engine.ground.list().find((entry) => entry.id === id),
  };
}

function fakeHarness() {
  const engine = createFakeEngine();
  engine.fake.setPose({
    longitude: geo.math.toRadians(FIRE.lon),
    latitude: geo.math.toRadians(FIRE.lat),
    height: 2_000_000,
  });
  const ground = watchGround(engine);
  return {
    name: 'the fake engine',
    engine,
    ground,
    /** The sprite set as drawn: its options and shown instances. */
    sprites(id) {
      const set = engine.fake.moverSet(id);
      if (!set) return null;
      const { store, options } = set;
      return {
        options,
        count: store.count,
        instances: Array.from({ length: store.count }, (_, i) => ({
          show: store.shows[i] === 1,
          scale: store.scales[i],
          alpha: store.colors[i * 4 + 3],
          pickId: store.pickIds[i],
        })),
      };
    },
    click(picked) {
      engine.fake.script('pick', picked);
      engine.fake.script('drillPick', picked ? [picked] : []);
      engine.fake.input('click', { position: { x: 10, y: 20 } });
      engine.fake.unscript('pick');
      engine.fake.unscript('drillPick');
    },
    pickOf: (setId, instance, pickId) => ({
      id: pickId,
      owner: setId,
      instance,
    }),
    destroy: () => engine.destroy(),
  };
}

const HARNESSES = [fakeHarness];
const display = (h, options = {}) =>
  createFirmsDisplay(h.engine, {
    id: 'firms-fixture',
    loadImage,
    createCanvas,
    ...options,
  });

for (const make of HARNESSES) {
  const name = make().name;

  test(`${name}: cells are one ground cell set in each cell's colour, committed once per batch`, async () => {
    const h = make();
    try {
      const r = display(h);
      const id = 'firms-fixture:cells';
      assert.equal(h.ground.listed(id).shown, false, 'hidden until shown');
      r.setVisible(true);
      assert.equal(h.ground.listed(id).shown, true);
      r.clearCells();
      r.addCell({
        west: 179,
        south: 40,
        east: 180,
        north: 42,
        color: constantRgba(1, 165 / 255, 0, 0.66),
        position: at(179.5, 41),
        properties: { count: 7 },
      });
      r.addCell({
        west: 0,
        south: 0,
        east: 1,
        north: 1,
        color: constantRgba(1, 0, 0, 0.3),
      });
      assert.equal(r.cellCount(), 0, 'drawn on the next microtask');
      await settle();
      assert.equal(r.cellCount(), 2);
      assert.deepEqual(h.ground.items(id)[0], {
        west: 179,
        south: 40,
        east: 180,
        north: 42,
        fill: [1, 165 / 255, 0, 0.66],
      });
      if (h.groundPrimitives) {
        const { values } = h.groundPrimitives(id);
        assert.equal(values.length, 1, 'fills only: no outline');
        const [fills] = values;
        assert.equal(fills.classificationType, Cesium.ClassificationType.BOTH);
        assert.equal(fills.gevPickable, false, 'cells stay out of picks');
        const rectangle = fills.geometryInstances[0].geometry._rectangle;
        assert.ok(
          Math.abs(rectangle.west - Cesium.Math.toRadians(179)) < 1e-12,
        );
        assert.ok(
          Math.abs(rectangle.north - Cesium.Math.toRadians(42)) < 1e-12,
        );
        assert.deepEqual(
          Array.from(fills.geometryInstances[0].attributes.color.value),
          [255, 165, 0, Math.round(0.66 * 255)],
        );
      }
      r.setVisible(false);
      assert.equal(h.ground.listed(id).shown, false);
      assert.equal(r.visible(), false);
      r.clearCells();
      await settle();
      assert.equal(r.cellCount(), 0);
      r.destroy();
      assert.equal(h.ground.listed(id), undefined);
    } finally {
      h.destroy();
    }
  });

  test(`${name}: glows are one sprite set at their own size, over the scene, in the firms sprite slot`, async () => {
    const h = make();
    try {
      const r = display(h);
      r.setVisible(true);
      const collection = r.ensureSprites();
      assert.equal(collection, r.ensureSprites());
      const small = r.addSprite({
        id: 'firms-0',
        position: at(FIRE.lon, FIRE.lat),
        image: 'glow-16',
      });
      r.addSprite({
        id: 'firms-1',
        position: at(FIRE.lon + 1, FIRE.lat),
        image: 'glow-56',
      });
      assert.equal(collection.length, 2);
      await settle();
      const drawn = h.sprites('firms:firms-fixture');
      assert.equal(drawn.count, 2);
      assert.ok(Math.abs(drawn.instances[0].scale - 16 / 56) < 1e-7);
      assert.equal(drawn.instances[1].scale, 1);
      assert.deepEqual(
        drawn.instances.map((i) => i.pickId),
        ['firms-0', 'firms-1'],
      );
      assert.deepEqual(
        drawn.instances.map((i) => i.alpha),
        [1, 1],
      );
      assert.equal(FIRMS_SPRITE_ORDER, SPRITE_LAYER_ORDER.indexOf('firms'));
      if (drawn.options) {
        assert.equal(drawn.options.order, FIRMS_SPRITE_ORDER);
        assert.equal(drawn.options.depthTest, 'always');
        assert.equal(drawn.options.pickable, true);
        assert.equal(drawn.options.sharpen, true);
        assert.equal(drawn.options.sprite.sizePx, 56);
      } else {
        const { billboard } = drawn.instances[0];
        assert.equal(billboard.disableDepthTestDistance, Infinity);
        assert.equal(billboard.width, 56);
        assert.equal(billboard.verticalOrigin, Cesium.VerticalOrigin.CENTER);
        assert.equal(
          billboard.horizontalOrigin,
          Cesium.HorizontalOrigin.CENTER,
        );
      }
      // The horizon cull flips one marker: only that instance is rewritten.
      small.show = false;
      await settle();
      assert.deepEqual(
        h.sprites('firms:firms-fixture').instances.map((i) => i.show),
        [false, true],
      );
      r.setVisible(false);
      await settle();
      assert.equal(
        h.sprites('firms:firms-fixture').count,
        0,
        'hidden: none drawn',
      );
      r.setVisible(true);
      await settle();
      assert.deepEqual(
        h.sprites('firms:firms-fixture').instances.map((i) => i.show),
        [false, true],
      );
      collection.removeAll();
      await settle();
      assert.equal(h.sprites('firms:firms-fixture').count, 0);
      r.removeSprites();
      assert.equal(h.sprites('firms:firms-fixture'), null);
      assert.equal(r.addSprite({ id: 'late', image: 'glow-16' }), null);
      r.destroy();
    } finally {
      h.destroy();
    }
  });

  test(`${name}: the hand-off fades every marker and hides them all once the heatmap is whole`, async () => {
    const h = make();
    try {
      const r = display(h);
      r.setVisible(true);
      r.ensureSprites();
      r.addSprite({
        id: 'firms-0',
        position: at(FIRE.lon, FIRE.lat),
        image: 'glow-56',
      });
      r.addSprite({
        id: 'firms-1',
        position: at(FIRE.lon, FIRE.lat + 1),
        image: 'glow-56',
      });
      await settle();
      r.fadeSprites(0.25, true);
      await settle();
      assert.deepEqual(
        h.sprites('firms:firms-fixture').instances.map((i) => i.alpha),
        [0.25, 0.25],
      );
      r.fadeSprites(0, false);
      await settle();
      assert.equal(
        h.sprites('firms:firms-fixture').count,
        0,
        'the heatmap alone: no marker',
      );
      r.fadeSprites(1, true);
      await settle();
      assert.deepEqual(
        h.sprites('firms:firms-fixture').instances.map((i) => i.alpha),
        [1, 1],
      );
      r.destroy();
    } finally {
      h.destroy();
    }
  });

  test(`${name}: clicks reach the layer with the pick under them while it shows, and release on destroy`, async () => {
    const h = make();
    try {
      const r = display(h);
      r.ensureSprites();
      r.addSprite({
        id: 'firms-7',
        position: at(FIRE.lon, FIRE.lat),
        image: 'glow-56',
      });
      r.setVisible(true);
      await settle();
      const clicks = [];
      const remove = r.onClick((event) => clicks.push(event));
      h.click(h.pickOf('firms:firms-fixture', 0, 'firms-7'));
      assert.equal(clicks.length, 1);
      assert.equal(clicks[0].picked.id, 'firms-7');
      assert.deepEqual(
        { x: clicks[0].position.x, y: clicks[0].position.y },
        { x: 10, y: 20 },
      );
      h.click(undefined);
      assert.equal(clicks.length, 2, 'a click on nothing is the layer’s too');
      assert.equal(clicks[1].picked, undefined);
      r.setVisible(false);
      h.click(undefined);
      assert.equal(clicks.length, 2, 'a hidden layer takes no click');
      r.setVisible(true);
      remove();
      remove();
      h.click(undefined);
      assert.equal(clicks.length, 2, 'removed');
      r.onClick((event) => clicks.push(event));
      r.destroy();
      h.click(undefined);
      assert.equal(clicks.length, 2, 'destroy releases every subscription');
    } finally {
      h.destroy();
    }
  });

  test(`${name}: the camera, projection, view rectangle and horizon are the engine's`, () => {
    const h = make();
    try {
      const r = display(h);
      const pose = h.engine.camera.pose();
      assert.ok(
        Math.abs(
          r.view.camera.positionCartographic.height - pose.cartographic.height,
        ) < 1e-6,
      );
      assert.ok(
        geo.cartesian3.equalsEpsilon(
          r.view.camera.positionWC,
          pose.position,
          0,
          1e-6,
        ),
      );
      assert.equal(r.engine.camera.moveEnd, h.engine.camera.moveEnd);
      assert.equal(r.engine.frames.preRender, h.engine.frames.preRender);
      const near = at(FIRE.lon, FIRE.lat);
      assert.deepEqual(
        r.view.worldToWindow(near, {}),
        h.engine.projector.worldToWindow(near, {}),
      );
      assert.deepEqual(r.viewRectangle({}), {
        ...h.engine.camera.viewRectangle(),
      });
      const far = at(FIRE.lon + 180, -FIRE.lat);
      assert.equal(r.view.horizon().isPointVisible(near), true);
      assert.equal(r.view.horizon().isPointVisible(far), false);
      r.destroy();
    } finally {
      h.destroy();
    }
  });

  test(`${name}: an image that decodes after hide or destroy draws nothing`, async () => {
    const h = make();
    try {
      let finish;
      const r = display(h, {
        loadImage: () => new Promise((resolve) => (finish = resolve)),
      });
      r.ensureSprites();
      r.addSprite({
        id: 'firms-0',
        position: at(FIRE.lon, FIRE.lat),
        image: 'glow-16',
      });
      r.setVisible(true);
      await settle();
      r.setVisible(false);
      finish({ width: 16, height: 16 });
      await settle();
      assert.equal(h.sprites('firms:firms-fixture'), null);
      r.setVisible(true);
      await settle();
      assert.equal(
        h.sprites('firms:firms-fixture').count,
        1,
        'the decoded image draws once shown',
      );
      r.destroy();
      r.destroy();
      assert.equal(h.sprites('firms:firms-fixture'), null);
      assert.equal(h.engine.movers.list().length, 0);
      assert.equal(h.engine.ground.list().length, 0);
      assert.equal(r.ensureSprites(), null);
      assert.equal(r.createHeatImagery(), null);
    } finally {
      h.destroy();
    }
  });
}

test('the fake engine: clearing rows during a decode commits only the replacement', async () => {
  const h = fakeHarness();
  try {
    const complete = new Map();
    const r = display(h, {
      loadImage: (url) => new Promise((resolve) => complete.set(url, resolve)),
    });
    r.setVisible(true);
    const sprites = r.ensureSprites();
    r.addSprite({ id: 'old', position: at(0, 0), image: 'glow-16' });
    await settle();
    sprites.removeAll();
    r.addSprite({ id: 'new', position: at(0, 1), image: 'glow-56' });
    await settle();
    complete.get('glow-16')({ width: 16, height: 16 });
    await settle();
    assert.equal(h.sprites('firms:firms-fixture'), null);
    complete.get('glow-56')({ width: 56, height: 56 });
    await settle();
    const drawn = h.engine.fake.moverSet('firms:firms-fixture');
    assert.equal(drawn.store.count, 1);
    assert.equal(drawn.store.pickIds[0], 'new');
    assert.equal(drawn.commits, 1);
    r.destroy();
  } finally {
    h.destroy();
  }
});

// A 2D canvas for the Cesium engine's image upload (RGBA bytes go on one).
function stubDocument() {
  const prior = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (w, hh) => ({
          data: new Uint8ClampedArray(w * hh * 4),
        }),
        putImageData() {},
      }),
    }),
  };
  return () => {
    if (prior === undefined) delete globalThis.document;
    else globalThis.document = prior;
  };
}

for (const make of HARNESSES) {
  const name = make().name;
  test(`${name}: the heatmap is one imagery layer over the globe, faded by its alpha`, () => {
    const restore = stubDocument();
    const h = make();
    if (h.viewer) {
      h.viewer.imageryLayers = stack;
      h.viewer.scene.globe.show = true;
    }
    try {
      const r = display(h);
      const heat = r.createHeatImagery();
      const listed = () => h.engine.imagery.list();
      assert.equal(heat.hasRaster(), false);
      assert.deepEqual(listed(), [], 'no layer before the first raster');
      heat.setOpacity(0);
      const raster = { width: 4, height: 2, rgba: new Uint8ClampedArray(32) };
      heat.setRaster(raster);
      assert.equal(heat.hasRaster(), true);
      assert.deepEqual(listed(), [
        {
          id: 'firms-fixture:heat',
          kind: 'image',
          shown: true,
          alpha: 0,
          split: 'none',
          order: 1,
        },
      ]);
      if (h.viewer) {
        assert.equal(stack.length, 1, 'one imagery layer on the globe');
        assert.equal(stack.get(0).alpha, 0);
        assert.equal(stack.get(0).show, true, 'a faded layer stays mapped');
      } else {
        const drawn = h.engine.fake.imageryLayer('firms-fixture:heat');
        assert.equal(drawn.source.image.data, raster.rgba);
        assert.deepEqual(drawn.source.rectangle, {
          west: -180,
          south: -90,
          east: 180,
          north: 90,
        });
      }
      heat.setOpacity(7);
      heat.setShow(false);
      assert.deepEqual(
        [listed()[0].alpha, listed()[0].shown],
        [1, false],
        'the opacity clamps; show hides',
      );
      heat.setRaster({ ...raster, rgba: new Uint8ClampedArray(32) });
      assert.equal(listed().length, 1, 'a new raster replaces the image');
      assert.deepEqual([listed()[0].alpha, listed()[0].shown], [1, false]);
      if (h.viewer) {
        assert.equal(stack.length, 1);
        assert.equal(stack.get(0).show, false);
      }
      heat.destroy();
      heat.destroy();
      assert.deepEqual(listed(), []);
      if (h.viewer) assert.equal(stack.length, 0);
      // The display takes its heatmap with it.
      r.createHeatImagery().setRaster(raster);
      assert.equal(listed().length, 1);
      r.destroy();
      assert.deepEqual(listed(), []);
      assert.equal(r.createHeatImagery(), null);
    } finally {
      h.destroy();
      restore();
    }
  });
}
