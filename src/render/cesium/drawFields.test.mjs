import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createCesiumFields,
  createShellSurface,
  orderShells,
} from './drawFields.js';
import {
  createShellCesium,
  createShellScene,
  renderShells,
} from '../../layers/weather/shellFixture.mjs';

// The detail window uniform; NONE is the empty window.
const NONE = { x: 0, y: 0, z: -1, w: -1 };
const windowOf = (primitive) => {
  const { x, y, z, w } = primitive.appearance.material.uniforms.window;
  return { x, y, z, w };
};

test('surface builds a flat raised rectangle drawn in primitive order without depth writes', () => {
  const cesium = createShellCesium();
  const scene = createShellScene();
  const rectangle = Cesium.Rectangle.fromDegrees(-130, 20, -60, 55);
  const surface = createShellSurface({
    scene,
    cesium,
    rectangle,
    height: 6_200,
  });
  const template = cesium.templates.get('DrawRasterShell');
  assert.ok(!(template instanceof cesium.Material), 'plain template');
  assert.deepEqual(template.fabric.uniforms, {
    image: Cesium.Material.DefaultImageId,
    detail: Cesium.Material.DefaultImageId,
    alpha: 1,
    window: { type: 'vec4', x: 0, y: 0, z: -1, w: -1 },
  });
  const { source } = template.fabric;
  assert.match(
    source,
    /material\.alpha = c\.a \* alpha \* step\(1\.5, float\(imageDimensions\.x\)\);/,
    'nothing draws before the full-extent image',
  );
  assert.match(
    source,
    /float useDetail = inside \* step\(1\.5, float\(detailDimensions\.x\)\);/,
    'the detail image is sampled only once it has arrived',
  );
  assert.match(
    source,
    /all\(greaterThanEqual\(st, window\.xy\)\) && all\(lessThanEqual\(st, window\.zw\)\)/,
  );
  assert.match(
    source,
    /mix\(coarse, texture\(detail, clamp\(dst, 0\.0, 1\.0\)\), useDetail\)/,
  );
  assert.match(source, /material\.diffuse = czm_gammaCorrect\(c\.rgb\);/);
  const [primitive] = scene.primitives.items;
  const appearance = primitive.appearance;
  assert.equal(appearance.material.options.translucent, false);
  assert.deepEqual(
    { ...appearance.options, material: undefined },
    {
      aboveGround: true,
      flat: true,
      translucent: false,
      material: undefined,
    },
  );
  assert.deepEqual(appearance.getRenderState(), {
    depthTest: { enabled: true },
    depthMask: false,
    blending: Cesium.BlendingState.ALPHA_BLEND,
  });
  const geometry = primitive.options.geometryInstances.geometry.options;
  assert.equal(geometry.rectangle, rectangle);
  assert.equal(geometry.height, 6_200);
  assert.equal(geometry.granularity, Cesium.Math.toRadians(0.5));
  assert.equal(
    geometry.vertexFormat,
    Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
  );
  assert.equal(primitive.options.asynchronous, true);
  assert.equal(primitive.options.allowPicking, false);
  const lower = createShellSurface({
    scene,
    cesium,
    rectangle,
    height: 5_000,
  });
  assert.equal(cesium.templates.size, 1, 'the template registers once');
  assert.deepEqual(
    scene.primitives.items.map(
      (item) => item.options.geometryInstances.geometry.options.height,
    ),
    [5_000, 6_200],
  );
  lower.destroy();
  surface.destroy();
});

test('a surface applies a new detail window only once its image has drawn; the same window swaps only the image', () => {
  const cesium = createShellCesium();
  const scene = createShellScene();
  const surface = createShellSurface({
    scene,
    cesium,
    rectangle: Cesium.Rectangle.fromDegrees(-130, 20, -60, 55),
    height: 6_200,
  });
  const [primitive] = scene.primitives.items;
  const { uniforms } = primitive.appearance.material;
  const render = (count) => renderShells(cesium, scene, count);
  const image = () => ({ width: 4096, height: 2048 });
  surface.setImage(image());
  render();
  assert.deepEqual(surface.getDiagnostics().detail, {
    uploaded: false,
    window: null,
  });
  const a = { west: 0.25, south: 0.5, east: 0.5, north: 0.75 };
  const first = image();
  surface.setDetail(first, a);
  assert.equal(uniforms.detail, first);
  assert.deepEqual(windowOf(primitive), NONE, 'the full-extent image covers');
  assert.equal(scene.postRender.size, 1, 'renders until the detail has drawn');
  render(2);
  assert.deepEqual(windowOf(primitive), NONE);
  render(1);
  assert.deepEqual(windowOf(primitive), { x: 0.25, y: 0.5, z: 0.5, w: 0.75 });
  assert.ok(uniforms.window instanceof Cesium.Cartesian4);
  assert.deepEqual(surface.getDiagnostics().detail, {
    uploaded: true,
    window: a,
  });
  assert.equal(scene.postRender.size, 0);

  // A time change in the same window: Cesium keeps drawing the previous
  // texture until the new one is uploaded, so the window stays.
  const applied = uniforms.window;
  const second = image();
  surface.setDetail(second, { ...a });
  assert.equal(uniforms.detail, second);
  assert.equal(uniforms.window, applied, 'only the image is written');
  assert.equal(surface.getDiagnostics().detail.uploaded, false);
  render();
  assert.equal(surface.getDiagnostics().detail.uploaded, true);
  assert.equal(uniforms.window, applied);
  const renders = scene.renders;
  surface.setDetail(second, { ...a });
  assert.equal(scene.renders, renders, 'an unchanged detail costs nothing');
  assert.equal(scene.postRender.size, 0);

  // A different window empties at once and applies once its image has drawn.
  const b = { west: 0.5, south: 0.25, east: 0.75, north: 0.5 };
  surface.setDetail(image(), b);
  assert.deepEqual(windowOf(primitive), NONE);
  render(2);
  assert.deepEqual(windowOf(primitive), NONE);
  render(1);
  assert.deepEqual(windowOf(primitive), { x: 0.5, y: 0.25, z: 0.75, w: 0.5 });

  surface.setDetail(null);
  assert.equal(uniforms.detail, Cesium.Material.DefaultImageId);
  assert.deepEqual(windowOf(primitive), NONE);
  assert.deepEqual(surface.getDiagnostics().detail, {
    uploaded: false,
    window: null,
  });
  render();
  assert.deepEqual(
    { ...uniforms.detailDimensions },
    { type: 'ivec3', x: 1, y: 1 },
  );
  // Counted renders alone are not enough: the bound texture must be this image.
  surface.setDetail(image(), a);
  for (let i = 0; i < 4; i++) scene.postRender.emit();
  assert.deepEqual(windowOf(primitive), NONE, 'still the 1×1 default');
  render(1);
  assert.deepEqual(windowOf(primitive), { x: 0.25, y: 0.5, z: 0.5, w: 0.75 });
  surface.destroy();
  surface.setDetail(image(), b);
  assert.deepEqual(windowOf(primitive), { x: 0.25, y: 0.5, z: 0.5, w: 0.75 });
  assert.equal(scene.postRender.size, 0);
});

test('a surface draws a one pixel wide image as a copy two pixels wide', (t) => {
  // The material reads a width of 1 as the 1×1 default, nothing arrived.
  const drawn = [];
  class FakeCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return { drawImage: (...args) => drawn.push(args) };
    }
  }
  const had = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
  globalThis.OffscreenCanvas = FakeCanvas;
  t.after(() => {
    if (had) Object.defineProperty(globalThis, 'OffscreenCanvas', had);
    else delete globalThis.OffscreenCanvas;
  });
  const cesium = createShellCesium();
  const scene = createShellScene();
  const surface = createShellSurface({
    scene,
    cesium,
    rectangle: Cesium.Rectangle.fromDegrees(-100, 28, -95, 32),
    height: 10_000,
  });
  const [primitive] = scene.primitives.items;
  const { uniforms } = primitive.appearance.material;
  const pixel = { width: 1, height: 1 };
  surface.setImage(pixel);
  assert.ok(uniforms.image instanceof FakeCanvas);
  assert.deepEqual([uniforms.image.width, uniforms.image.height], [2, 1]);
  assert.deepEqual(drawn, [[pixel, 0, 0, 2, 1]]);
  const copy = uniforms.image;
  surface.setImage(pixel);
  assert.equal(uniforms.image, copy, 'the same image is not copied again');
  renderShells(cesium, scene, 3);
  assert.equal(surface.isDrawn(), true, 'drawn once the copy has uploaded');
  const wide = { width: 4, height: 1 };
  surface.setImage(wide);
  assert.equal(uniforms.image, wide, 'a wider image is drawn as it is');
  surface.setDetail(
    { width: 1, height: 8 },
    { west: 0, south: 0, east: 1, north: 1 },
  );
  assert.deepEqual([uniforms.detail.width, uniforms.detail.height], [2, 8]);
});

test("a surface rises by a uniform scale about the Earth's centre", () => {
  const scene = {
    primitives: new Cesium.PrimitiveCollection(),
    postRender: new Cesium.Event(),
    requestRender() {},
  };
  const surface = createShellSurface({
    scene,
    cesium: Cesium,
    rectangle: Cesium.Rectangle.fromDegrees(-130, 20, -60, 55),
    height: 5_800,
  });
  const primitive = scene.primitives.get(0);
  const identity = primitive.modelMatrix;
  surface.setLift(0);
  assert.equal(primitive.modelMatrix, identity, 'no lift, no new matrix');
  surface.setLift(32_000);
  const radius = Cesium.Ellipsoid.WGS84.maximumRadius;
  assert.ok(
    Math.abs(primitive.modelMatrix[0] * radius - (radius + 32_000)) < 1e-3,
  );
  const lifted = primitive.modelMatrix;
  surface.setLift(32_000);
  assert.equal(primitive.modelMatrix, lifted, 'the same lift keeps the matrix');
  surface.destroy();
});

test('real Cesium builds the two-texture material, the opaque-pass appearance and the rectangle primitive', () => {
  const scene = {
    primitives: new Cesium.PrimitiveCollection(),
    postRender: new Cesium.Event(),
    requestRender() {},
  };
  const surface = createShellSurface({
    scene,
    cesium: Cesium,
    rectangle: Cesium.Rectangle.fromDegrees(-130, 20, -60, 55),
    height: 6_600,
  });
  const cached = Cesium.Material._materialCache.getMaterial('DrawRasterShell');
  assert.ok(cached && !(cached instanceof Cesium.Material));
  const primitive = scene.primitives.get(0);
  const material = primitive.appearance.material;
  assert.ok(primitive instanceof Cesium.Primitive);
  assert.equal(material.type, 'DrawRasterShell');
  assert.equal(material.isTranslucent(), false);
  assert.equal(primitive.appearance.isTranslucent(), false, 'opaque pass');
  assert.equal(primitive.appearance.getRenderState().depthMask, false);
  assert.equal(
    Cesium.Appearance.prototype.getRenderState.call(primitive.appearance)
      .depthMask,
    true,
    'the default opaque render state would write depth',
  );
  assert.deepEqual(
    [material.uniforms.imageDimensions.x, material.uniforms.detailDimensions.x],
    [1, 1],
    'Cesium tracks both bound texture sizes',
  );
  const shader = material.shaderSource;
  for (const declaration of [
    /uniform sampler2D image_\d+;/,
    /uniform sampler2D detail_\d+;/,
    /uniform float alpha_\d+;/,
    /uniform vec4 window_\d+;/,
    /uniform ivec3 imageDimensions_\d+;/,
    /uniform ivec3 detailDimensions_\d+;/,
  ])
    assert.match(shader, declaration);
  assert.match(shader, /texture\(image_\d+, st\)/);
  assert.match(shader, /texture\(detail_\d+, clamp\(dst, 0\.0, 1\.0\)\)/);
  assert.match(shader, /lessThanEqual\(st, window_\d+\.zw\)/);
  assert.match(shader, /step\(1\.5, float\(detailDimensions_\d+\.x\)\)/);
  assert.match(
    shader,
    /material\.alpha = c\.a \* alpha_\d+ \* step\(1\.5, float\(imageDimensions_\d+\.x\)\);/,
    'the uniform is renamed, the material field is not',
  );
  assert.match(shader, /float useDetail = inside \* step/, 'locals keep names');
  const detail = { width: 4096, height: 2048 };
  surface.setDetail(detail, { west: 0.1, south: 0.2, east: 0.3, north: 0.4 });
  assert.equal(material.uniforms.detail, detail);
  assert.deepEqual(
    [material.uniforms.window.z, material.uniforms.window.w],
    [-1, -1],
    'no window before the image has drawn',
  );
  surface.setDetail(null);
  assert.equal(material.uniforms.detail, Cesium.Material.DefaultImageId);
  surface.setAlpha(0.4);
  assert.equal(material.uniforms.alpha, 0.4);
  surface.destroy();
  assert.equal(scene.primitives.length, 0);
  assert.equal(primitive.isDestroyed(), true);
  assert.equal(material.isDestroyed(), true);
  assert.equal(scene.postRender.numberOfListeners, 0);
});

test('shells draw first, in height order, regardless of add order', () => {
  const scene = createShellScene();
  const other = { name: 'other' };
  scene.primitives.add(other);
  const add = (name, height) => {
    const primitive = { name };
    scene.primitives.add(primitive);
    orderShells(scene.primitives, primitive, height);
    return primitive;
  };
  add('lightning', 6_600);
  add('radar', 6_200);
  add('wind', 5_000);
  const later = { name: 'later' };
  scene.primitives.add(later);
  add('regional', 5_800);
  assert.deepEqual(
    scene.primitives.items.map(({ name }) => name),
    ['wind', 'regional', 'radar', 'lightning', 'other', 'later'],
  );
  const primitives = new Cesium.PrimitiveCollection({
    destroyPrimitives: false,
  });
  const real = (name) => ({ name, update() {}, isDestroyed: () => false });
  const tileset = primitives.add(real('tileset'));
  const lightning = primitives.add(real('lightning'));
  orderShells(primitives, lightning, 6_600);
  const radar = primitives.add(real('radar'));
  orderShells(primitives, radar, 6_200);
  assert.deepEqual(
    [0, 1, 2].map((i) => primitives.get(i).name),
    ['radar', 'lightning', 'tileset'],
    'real Cesium collection order',
  );
  assert.equal(tileset.name, 'tileset');
});

test('hidden frames do not count towards a pending detail window', () => {
  const cesium = createShellCesium();
  const scene = createShellScene();
  const surface = createShellSurface({
    scene,
    cesium,
    rectangle: Cesium.Rectangle.fromDegrees(-130, 20, -60, 55),
    height: 6_200,
  });
  const [primitive] = scene.primitives.items;
  const render = (count) => renderShells(cesium, scene, count);
  const image = () => ({ width: 4096, height: 2048 });
  surface.setImage(image());
  const a = { west: 0.25, south: 0.5, east: 0.5, north: 0.75 };
  surface.setDetail(image(), a);
  render();
  assert.deepEqual(windowOf(primitive), { x: 0.25, y: 0.5, z: 0.5, w: 0.75 });
  // A different window with a same-sized image: the dimensions alone cannot
  // tell the textures apart, so only shown frames may count.
  const b = { west: 0.5, south: 0.25, east: 0.75, north: 0.5 };
  surface.setDetail(image(), b);
  assert.deepEqual(windowOf(primitive), NONE);
  for (let i = 0; i < 3; i++) {
    surface.setShow(false);
    scene.postRender.emit();
    surface.setShow(true);
  }
  assert.deepEqual(windowOf(primitive), NONE, 'hidden frames counted nothing');
  render(2);
  assert.deepEqual(windowOf(primitive), NONE);
  render(1);
  assert.deepEqual(windowOf(primitive), { x: 0.5, y: 0.25, z: 0.75, w: 0.5 });
});

function fieldHarness() {
  const cesium = createShellCesium();
  const scene = createShellScene();
  const fields = createCesiumFields({ scene, cesium });
  const image = () => ({ canvas: { width: 64, height: 32 }, key: 'k' });
  const render = (count = 4) => renderShells(cesium, scene, count);
  const live = () => scene.primitives.items.filter((p) => !p.destroyed);
  return { cesium, scene, fields, image, render, live };
}
const RECT = { west: -100, south: 20, east: -60, north: 40 };

test("a raster shell tells 'drawn' once its content is drawn, once per change", () => {
  const h = fieldHarness();
  const field = h.fields.field({
    kind: 'rasterShell',
    id: 'shell',
    image: h.image(),
    rectangle: RECT,
    heightM: 6_000,
    alpha: 0.5,
  });
  let drawn = 0;
  field.on('drawn', () => (drawn += 1));
  const [primitive] = h.live();
  const { uniforms } = primitive.appearance.material;
  assert.equal(uniforms.alpha, 0, 'invisible until drawable');
  h.render();
  assert.equal(drawn, 1);
  assert.equal(uniforms.alpha, 0.5);
  assert.equal(h.scene.postRender.size, 0, 'no frames once drawn');
  field.update({ alpha: 0.3, liftM: 1_000 });
  assert.equal(uniforms.alpha, 0.3);
  assert.notEqual(primitive.modelMatrix, undefined, 'lifted');
  assert.deepEqual(h.live(), [primitive], 'alpha and lift never rebuild');
  h.render();
  assert.equal(drawn, 2);
  field.show = false;
  field.update({ alpha: 0.4 });
  h.render();
  assert.equal(drawn, 2, 'never while hidden');
  field.show = true;
  h.render();
  assert.equal(drawn, 3, 'told once shown');
  h.render();
  assert.equal(drawn, 3);
  field.dispose();
  assert.equal(h.live().length, 0);
  assert.equal(h.scene.postRender.size, 0);
});

test('a raster shell keeps drawing its rectangle until a new one is drawn whole', () => {
  const h = fieldHarness();
  const first = h.image();
  const field = h.fields.field({
    kind: 'rasterShell',
    id: 'shell',
    image: first,
    rectangle: RECT,
    heightM: 6_000,
  });
  let drawn = 0;
  field.on('drawn', () => (drawn += 1));
  h.render();
  const [old] = h.live();
  const second = h.image();
  field.update({
    image: second,
    rectangle: { west: -120, south: 10, east: -50, north: 50 },
  });
  const [, staged] = h.live();
  assert.equal(old.appearance.material.uniforms.alpha, 1, 'the old one draws');
  assert.equal(staged.appearance.material.uniforms.alpha, 0);
  assert.equal(staged.appearance.material.uniforms.image, second.canvas);
  h.render();
  assert.equal(old.destroyed, true, 'swapped in one frame');
  assert.deepEqual(h.live(), [staged]);
  assert.equal(staged.appearance.material.uniforms.alpha, 1);
  assert.equal(drawn, 2);
  // Back to the drawn rectangle before a staged one is drawn: it goes.
  field.update({ rectangle: RECT });
  assert.equal(h.live().length, 2);
  field.update({ rectangle: { west: -120, south: 10, east: -50, north: 50 } });
  assert.deepEqual(h.live(), [staged]);
  field.dispose();
});

test('a raster shell draws its detail in its own rectangle, in texture coordinates', () => {
  const h = fieldHarness();
  const field = h.fields.field({
    kind: 'rasterShell',
    id: 'shell',
    image: h.image(),
    rectangle: RECT,
    heightM: 6_000,
  });
  h.render();
  const [primitive] = h.live();
  const detail = h.image();
  field.update({
    detail: {
      image: detail,
      rectangle: { west: -90, south: 25, east: -80, north: 30 },
    },
  });
  assert.deepEqual(windowOf(primitive), NONE, 'the full image covers it');
  h.render();
  assert.equal(primitive.appearance.material.uniforms.detail, detail.canvas);
  assert.deepEqual(windowOf(primitive), {
    x: 0.25,
    y: 0.25,
    z: 0.5,
    w: 0.5,
  });
  field.update({ detail: null });
  assert.deepEqual(windowOf(primitive), NONE);
  field.dispose();
});

test('a raster shell hidden while a new rectangle stages still swaps it in', () => {
  const h = fieldHarness();
  const field = h.fields.field({
    kind: 'rasterShell',
    id: 'shell',
    image: h.image(),
    rectangle: RECT,
    heightM: 6_000,
  });
  let drawn = 0;
  field.on('drawn', () => (drawn += 1));
  h.render();
  const [old] = h.live();
  field.show = false;
  field.update({
    image: h.image(),
    rectangle: { west: -120, south: 10, east: -50, north: 50 },
  });
  h.render();
  const [staged] = h.live();
  assert.equal(old.destroyed, true, 'drawn invisibly and swapped in');
  assert.notEqual(staged, old);
  assert.equal(staged.show, false, 'and kept hidden');
  assert.equal(drawn, 1, 'never told while hidden');
  field.show = true;
  h.render();
  assert.equal(staged.show, true);
  assert.equal(drawn, 2);
  field.dispose();
});

test("a raster shell tells 'drawn' for a detail only once its window is placed", () => {
  const h = fieldHarness();
  const field = h.fields.field({
    kind: 'rasterShell',
    id: 'shell',
    image: h.image(),
    rectangle: RECT,
    heightM: 6_000,
  });
  h.render();
  const [primitive] = h.live();
  const windows = [];
  field.on('drawn', () => windows.push(windowOf(primitive)));
  field.update({
    detail: {
      image: h.image(),
      rectangle: { west: -90, south: 25, east: -80, north: 30 },
    },
  });
  h.render();
  assert.deepEqual(windows, [{ x: 0.25, y: 0.25, z: 0.5, w: 0.5 }]);
  field.dispose();
});

test("a raster shell tells 'drawn' in the frame its new rectangle replaces the old", () => {
  const h = fieldHarness();
  const field = h.fields.field({
    kind: 'rasterShell',
    id: 'shell',
    image: h.image(),
    rectangle: RECT,
    heightM: 6_000,
  });
  h.render();
  const [old] = h.live();
  let drawnAt = null;
  let render = 0;
  field.on('drawn', () => (drawnAt = render));
  field.update({ rectangle: { west: -120, south: 10, east: -50, north: 50 } });
  let swappedAt = null;
  for (render = 1; render <= 6; render++) {
    h.render(1);
    if (old.destroyed && swappedAt === null) swappedAt = render;
  }
  assert.ok(swappedAt > 1, 'staged while uploading');
  assert.equal(drawnAt, swappedAt, 'nothing comes between the swap and drawn');
  field.dispose();
});

test('a raster shell hidden after a new rectangle stages still builds and swaps it', () => {
  const h = fieldHarness();
  const field = h.fields.field({
    kind: 'rasterShell',
    id: 'shell',
    image: h.image(),
    rectangle: RECT,
    heightM: 6_000,
  });
  let drawn = 0;
  field.on('drawn', () => (drawn += 1));
  h.render();
  const [old] = h.live();
  field.update({ rectangle: { west: -120, south: 10, east: -50, north: 50 } });
  field.show = false;
  h.render();
  const [staged] = h.live();
  assert.equal(old.destroyed, true);
  assert.notEqual(staged, old);
  assert.equal(staged.show, false);
  assert.equal(h.scene.postRender.size, 0, 'no frames once built');
  assert.equal(drawn, 1);
  field.show = true;
  h.render();
  assert.equal(drawn, 2);
  field.dispose();
});

test('a raster shell never swaps in a stage superseded by content still decoding', async (t) => {
  const pending = [];
  const Image = globalThis.Image;
  globalThis.Image = class {
    decode() {
      return new Promise((resolve, reject) =>
        pending.push({ resolve, reject }),
      );
    }
  };
  t.after(() => (globalThis.Image = Image));
  const reported = [];
  const cesium = createShellCesium();
  const scene = createShellScene();
  const fields = createCesiumFields({
    scene,
    cesium,
    report: (error) => reported.push(error),
  });
  const live = () => scene.primitives.items.filter((p) => !p.destroyed);
  const field = fields.field({
    kind: 'rasterShell',
    id: 'shell',
    image: { canvas: { width: 64, height: 32 } },
    rectangle: RECT,
    heightM: 6_000,
  });
  renderShells(cesium, scene);
  const [old] = live();
  field.update({
    image: { canvas: { width: 64, height: 32 } },
    rectangle: { west: -120, south: 10, east: -50, north: 50 },
  });
  assert.equal(live().length, 2);
  field.update({ image: 'https://example.test/next.png' });
  assert.deepEqual(live(), [old], 'the superseded stage goes');
  pending[0].reject(new Error('no image'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  renderShells(cesium, scene);
  assert.deepEqual(live(), [old], 'what it drew stays');
  assert.equal(reported.length, 1);
  field.dispose();
});

test('the Cesium fields refuse kinds they cannot draw and live ids', () => {
  const h = fieldHarness();
  assert.throws(
    () => h.fields.field(/** @type {any} */ ({ kind: 'contours', id: 'x' })),
    /no contours fields/,
  );
  const spec = {
    kind: 'rasterShell',
    id: 'shell',
    image: h.image(),
    rectangle: RECT,
    heightM: 1,
  };
  const field = h.fields.field(spec);
  assert.throws(() => h.fields.field(spec), /is live/);
  field.dispose();
  h.fields.field(spec).dispose();
});

test('once the fields are disposed, a field asked for draws nothing and does nothing', () => {
  const h = fieldHarness();
  const field = h.fields.field({
    kind: 'rasterShell',
    id: 'shell',
    image: h.image(),
    rectangle: RECT,
    heightM: 1,
  });
  h.fields.dispose();
  assert.equal(h.live().length, 0, 'the live field went');
  field.update({ alpha: 0.5 });
  field.show = true;
  const late = h.fields.field({
    kind: 'rasterShell',
    id: 'late',
    image: h.image(),
    rectangle: RECT,
    heightM: 1,
  });
  late.update({ heightM: 2 });
  late.show = true;
  assert.equal(typeof late.on('drawn', () => {}), 'function');
  h.render();
  assert.equal(h.live().length, 0, 'nothing drawn after');
  assert.equal(h.fields.has('late'), false);
  late.dispose();
});
