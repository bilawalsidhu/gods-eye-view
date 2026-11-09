import '../testSupport/registerDom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useScreenAnnotationsStore } from '../ui/stores/screenAnnotations.js';
import ScreenAnnotations from '../ui/views/panels/ScreenAnnotations.vue';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { createSessionAnnotations } from './index.js';
import {
  createNavaraAnnotationRenderer,
  createNavaraWorldAnnotationRenderer,
  drapedParts,
} from './navaraAnnotationRenderer.js';
import { createSceneServices } from '../data/sceneServices.js';
import { screenSceneFromEngine } from './screenScene.js';

for (const type of [globalThis.SVGElement, globalThis.SVGGraphicsElement]) {
  if (type)
    type.prototype.getBBox = () => ({ x: 0, y: 0, width: 40, height: 16 });
}
const settle = async () => {
  for (let flush = 0; flush < 4; flush += 1) await nextTick();
};

/** A Navara view that records its meshes, and the colour class. */
function fakeViews() {
  const meshes = [];
  class NavaraColor {
    setHex(hex) {
      this.hex = hex;
      return this;
    }
    toArray() {
      return [1, 1, 1];
    }
    setRGBLinear() {
      return this;
    }
  }
  const view = {
    toneMappingExposure: 1,
    addMesh(config) {
      const mesh = { config, updates: [], deleted: false };
      meshes.push(mesh);
      return {
        update: (next) => mesh.updates.push(next),
        delete: () => {
          mesh.deleted = true;
        },
      };
    },
  };
  return { views: { view, NavaraColor }, meshes };
}

/** The page's board view, as in screenAnnotationRenderer.test.mjs. */
function board(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useScreenAnnotationsStore(pinia);
  const app = createApp(ScreenAnnotations).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0;
  t.after(() => {
    globalThis.requestAnimationFrame = original;
    app.unmount();
  });
  const groups = () => [
    ...(document.querySelectorAll('.gev-screen-whiteboard-svg g.gev-anno') ??
      []),
  ];
  return { store, groups };
}

test('areas drape a fill and an outline per ring, routes a line, other marks nothing', () => {
  const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
  ];
  const hole = [
    [0.2, 0.2],
    [0.4, 0.2],
    [0.4, 0.4],
  ];
  const area = drapedParts({
    type: 'area',
    ring,
    polygons: [[ring, hole]],
  });
  assert.deepEqual(
    area.map(({ kind, alpha, pulse }) => [kind, alpha, pulse]),
    [
      ['polygon', 0.2, true],
      ['polyline', 1, false],
      ['polyline', 1, false],
    ],
  );
  // Rings close for the polygon's GeoJSON, holes included.
  assert.equal(area[0].geojson.coordinates.length, 2);
  assert.deepEqual(area[0].geojson.coordinates[0].at(-1), [0, 0]);
  assert.equal(area[1].width, 6);
  const building = drapedParts({
    type: 'highlight',
    ring,
    footprintKind: 'building',
  });
  assert.equal(building[0].alpha, 0.45);
  assert.equal(building[1].width, 3);
  assert.equal(
    drapedParts({ type: 'area', ring, synthesized: true })[0].alpha,
    0.1,
  );
  const route = drapedParts({
    type: 'route',
    path: [
      { lon: 0, lat: 0 },
      { lon: 1, lat: 1 },
    ],
  });
  assert.deepEqual(
    route.map((p) => [p.kind, p.width]),
    [['polyline', 9]],
  );
  assert.deepEqual(
    drapedParts({ type: 'pin', anchor: { lon: 0, lat: 0 } }),
    [],
  );
});

test('the world half follows fade, pulse and hide, and lets go of every mesh', () => {
  const engine = createFakeEngine({ kind: 'navara' });
  const { views, meshes } = fakeViews();
  let now = 0;
  const world = createNavaraWorldAnnotationRenderer(engine, views, {
    now: () => now,
  });
  const anno = {
    id: 'a',
    type: 'area',
    color: 'amber',
    alpha: 0,
    ring: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
  };
  world.add(anno);
  assert.equal(meshes.length, 2);
  const [fill, outline] = meshes;
  assert.equal(fill.config.polygon.clampToGround, true);
  assert.equal(fill.config.polygon.color.hex, 0xffb547);
  assert.equal(fill.config.lit, false);
  assert.equal(fill.config.pickable, false);
  assert.equal(outline.config.polyline.width, 6);
  // Faded in: the engine's frame moves the opacity to the mark's alpha.
  anno.alpha = 1;
  engine.fake.frame();
  assert.equal(outline.updates.at(-1).polyline.opacity, 1);
  assert.ok(fill.updates.at(-1).polygon.opacity > 0.1);
  // Pulsing: a later frame changes the fill only.
  const outlineUpdates = outline.updates.length;
  now = 300;
  engine.fake.frame();
  assert.equal(outline.updates.length, outlineUpdates);
  assert.notEqual(
    fill.updates.at(-1).polygon.opacity,
    fill.updates.at(-2).polygon.opacity,
  );
  // Hidden from Draw's list: every mesh goes invisible.
  anno.hidden = true;
  world.sync();
  assert.equal(outline.updates.at(-1).visible, false);
  world.remove(anno);
  assert.ok(meshes.every((mesh) => mesh.deleted));
  assert.equal(world.diagnostics().meshes, 0);
  world.destroy();
  const before = fill.updates.length;
  engine.fake.frame();
  assert.equal(fill.updates.length, before, 'no frame listener after destroy');
});

test('the screen scene reads the engine camera, projector, horizon and follow', () => {
  const engine = createFakeEngine({ kind: 'navara', altitude: 1e6 });
  const scene = screenSceneFromEngine(engine);
  scene.beginFrame();
  const near = { x: 6378137, y: 0, z: 0 };
  const far = { x: -6378137, y: 0, z: 0 };
  assert.equal(scene.horizonVisible(near), true);
  assert.equal(scene.horizonVisible(far), false, 'behind the globe');
  const win = scene.worldToWindow(near, {});
  assert.ok(Math.abs(win.x - 512) < 1 && Math.abs(win.y - 384) < 1);
  assert.ok(Math.abs(scene.cameraHeight() - 1e6) < 1);
  assert.deepEqual(scene.size(), { width: 1024, height: 768 });
  assert.equal(scene.trackedSubject(), null);
});

test('marks on the Navara board are drawn, horizon-culled and survive an engine switch', async (t) => {
  const { store, groups } = board(t);
  const engine = createFakeEngine({ kind: 'navara', altitude: 2e6 });
  const { views, meshes } = fakeViews();
  const annotations = createSessionAnnotations({});
  t.after(() => annotations.destroy());
  const attach = () =>
    annotations.attachScene({
      engine,
      renderer: createNavaraAnnotationRenderer(engine, views, {
        screen: { store, activeTrackedReadoutId: () => null },
      }),
    });
  attach();
  assert.equal(annotations.attached, true);
  const result = await annotations.annotate(
    [
      { type: 'pin', manual: true, latitude: 0, longitude: 0, label: 'Near' },
      { type: 'pin', manual: true, latitude: 0, longitude: 180, label: 'Far' },
      {
        type: 'area',
        manual: true,
        label: 'Box',
        ring: [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ],
      },
    ],
    { persist: true, flyTo: false },
  );
  assert.equal(result.drawn, 3, JSON.stringify(result));
  engine.fake.frame();
  await settle();
  const shown = () =>
    groups()
      .filter((group) => group.style.display !== 'none')
      .map((group) => group.querySelector('.gev-anno-text')?.textContent)
      .filter(Boolean)
      .sort();
  // The far pin is behind the globe; the area's caption sits on the board.
  assert.deepEqual(shown(), ['Box', 'Near']);
  const live = () => meshes.filter((mesh) => !mesh.deleted);
  assert.deepEqual(
    live().map((mesh) => Object.keys(mesh.config)[0]),
    ['polygon', 'polyline'],
  );
  // Fly-to on Navara goes through the contract's flyToSphere.
  const [box] = annotations.list().filter((mark) => mark.label === 'Box');
  assert.equal(annotations.frame(box.id), true);
  assert.equal(engine.fake.callsOf('camera.flyToSphere').length, 1);
  // A switch takes the drawing off this engine and keeps the marks.
  annotations.detachScene();
  assert.equal(live().length, 0);
  assert.equal(annotations.count(), 3);
  attach();
  engine.fake.frame();
  await settle();
  assert.equal(live().length, 2);
  assert.deepEqual(shown(), ['Box', 'Near']);
  // Engine-side camera assist: frame() of a route uses the same flight.
  engine.fake.resetCalls();
  annotations.clear();
  engine.fake.frame();
  assert.equal(live().length, 0);
});

test('screen annotations read the attached engines tracked card footprint', async (t) => {
  const { store, groups } = board(t);
  const engine = createFakeEngine({
    longitude: 0,
    latitude: 0,
    altitude: 10000,
  });
  const services = createSceneServices(engine);
  const queries = [];
  services.overlay.getPaintRect = (...args) => {
    queries.push(args);
    return { x: 0, y: 0, w: 4000, h: 4000 };
  };
  const { views } = fakeViews();
  const renderer = createNavaraAnnotationRenderer(engine, views, {
    screen: { store, activeTrackedReadoutId: () => 'flight:test' },
  });
  t.after(() => {
    renderer.destroy();
    services.destroy();
    engine.destroy();
  });
  renderer.add({
    id: 'overlap',
    type: 'label',
    color: 'primary',
    label: 'Overlap',
    alpha: 1,
    anchor: { lon: 0, lat: 0, height: 0 },
  });
  engine.fake.frame();
  await settle();
  assert.deepEqual(queries.at(-1), ['tracked', 'flight:test']);
  assert.ok(Number(groups()[0].getAttribute('opacity')) < 1);
});
