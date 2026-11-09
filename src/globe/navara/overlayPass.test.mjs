import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Scene,
  PerspectiveCamera,
  HalfFloatType,
  NoColorSpace,
  SRGBColorSpace,
  InstancedMesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Texture,
} from 'three';
import { GevOverlayPass } from './overlayPass.js';

function harness() {
  let active = false,
    target = null,
    clearColor = 0x123456,
    clearAlpha = 1;
  const overlay = {
    displayBlend: true,
    hasDrawables: () => active,
    uniforms: {
      uGevResolution: { value: [0, 0] },
      uGevDisplayBlend: { value: 0 },
    },
  };
  const scene = new Scene(),
    pass = new GevOverlayPass(scene, new PerspectiveCamera(), overlay),
    draws = [];
  const renderer = {
    domElement: new EventTarget(),
    autoClear: true,
    outputColorSpace: SRGBColorSpace,
    getPixelRatio: () => 1,
    getClearColor(color) {
      return color.set(clearColor);
    },
    getClearAlpha() {
      return clearAlpha;
    },
    setClearColor(color, alpha) {
      clearColor = color.isColor ? color.getHex() : color;
      clearAlpha = alpha;
    },
    clear() {},
    get clearAlpha() {
      return clearAlpha;
    },
    setRenderTarget(value) {
      target = value;
    },
    render(object) {
      draws.push({
        object,
        target,
        displayBlend: overlay.uniforms.uGevDisplayBlend.value,
      });
    },
  };
  return {
    overlay,
    scene,
    pass,
    draws,
    renderer,
    setActive(value) {
      active = value;
    },
    get target() {
      return target;
    },
  };
}
test('empty overlays allocate no display target or draw calls', () => {
  const h = harness();
  h.pass.render(h.renderer, { width: 1280, height: 800, texture: {} }, {});
  assert.equal(h.pass.display, null);
  assert.deepEqual(h.draws, []);
  assert.equal(h.renderer.autoClear, true);
  h.pass.dispose();
});
test('display overlay composites encoded glyphs once into the next frame', () => {
  const h = harness(),
    input = {
      width: 1280,
      height: 800,
      samples: 4,
      texture: { name: 'linear frame' },
    },
    output = { texture: { name: 'next frame' } };
  h.setActive(true);
  h.pass.render(h.renderer, input, output);
  const display = h.pass.display;
  assert.equal(h.draws.length, 2);
  assert.equal(h.draws[0].object, h.scene);
  assert.equal(h.draws[0].target, display.target);
  assert.equal(h.draws[1].object, display.quad._mesh);
  assert.equal(h.draws[1].target, output);
  assert.deepEqual(
    h.draws.map((draw) => draw.displayBlend),
    [1, 0],
  );
  assert.equal(h.overlay.uniforms.uGevDisplayBlend.value, 0);
  assert.equal(
    display.target.samples,
    0,
    'native-stage alpha-masked glyphs need no second multisample raster',
  );
  assert.equal(display.target.texture.type, HalfFloatType);
  assert.equal(display.target.texture.colorSpace, NoColorSpace);
  assert.equal(display.target.depthBuffer, false);
  assert.deepEqual(h.overlay.uniforms.uGevResolution.value, [1280, 800]);
  assert.equal(h.pass.needsSwap, true);
  assert.equal(h.renderer.autoClear, true);
  assert.equal(display.composite.uniforms.image.value, input.texture);
  assert.equal(display.composite.uniforms.glyphs.value, display.target.texture);
  h.pass.render(h.renderer, input, output);
  assert.equal(h.pass.display, display);
  input.width = 640;
  h.pass.render(h.renderer, input, output);
  assert.equal(h.pass.display, display);
  assert.equal(display.target.width, 640);
  h.pass.renderToScreen = true;
  h.pass.render(h.renderer, input, output);
  assert.equal(h.target, null);
  assert.equal(display.composite.uniforms.encodeOutput.value, true);
  let sampleResets = 0;
  display.target.addEventListener('dispose', () => sampleResets++);
  input.samples = 0;
  h.pass.render(h.renderer, input, output);
  assert.equal(display.target.samples, 0);
  assert.equal(
    sampleResets,
    0,
    'changing scene raster samples leaves the glyph target unchanged',
  );
  let targetDisposals = 0,
    materialDisposals = 0;
  display.target.addEventListener('dispose', () => targetDisposals++);
  display.composite.addEventListener('dispose', () => materialDisposals++);
  h.pass.dispose();
  h.pass.dispose();
  assert.equal(targetDisposals, 1);
  assert.equal(materialDisposals, 1);
  assert.equal(h.pass.display, null);
});
test('overlay restores blend flag, destination and autoClear after a draw failure', () => {
  const h = harness(),
    input = { width: 1280, height: 800, texture: {} },
    output = {};
  h.setActive(true);
  const render = h.renderer.render;
  h.renderer.render = (object) => {
    if (object === h.scene) throw new Error('render failed');
    render(object);
  };
  assert.throws(
    () => h.pass.render(h.renderer, input, output),
    /render failed/,
  );
  assert.equal(h.renderer.autoClear, true);
  assert.equal(h.overlay.uniforms.uGevDisplayBlend.value, 0);
  assert.equal(h.target, output);
  assert.equal(h.renderer.clearAlpha, 1);
  h.pass.dispose();
});
test('static sprite glyphs reuse their target until instance data changes', () => {
  const h = harness(),
    input = { width: 1280, height: 800, texture: {} },
    output = {},
    texture = new Texture(),
    mesh = new InstancedMesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: texture }),
      1,
    );
  mesh.userData.gevStaticSprite = true;
  mesh.count = 1;
  mesh.instanceMatrix.needsUpdate = true;
  h.scene.add(mesh);
  h.setActive(true);
  h.pass.render(h.renderer, input, output);
  h.pass.render(h.renderer, input, output);
  assert.equal(h.draws.filter((draw) => draw.object === h.scene).length, 1);
  mesh.instanceMatrix.needsUpdate = true;
  h.pass.render(h.renderer, input, output);
  assert.equal(h.draws.filter((draw) => draw.object === h.scene).length, 2);
  h.pass.camera.position.x = 1;
  h.pass.camera.updateMatrixWorld();
  h.pass.render(h.renderer, input, output);
  assert.equal(h.draws.filter((draw) => draw.object === h.scene).length, 3);
  for (const type of ['webglcontextlost', 'webglcontextrestored']) {
    h.renderer.domElement.dispatchEvent(new Event(type));
    const before = h.draws.filter((draw) => draw.object === h.scene).length;
    h.pass.render(h.renderer, input, output);
    assert.equal(
      h.draws.filter((draw) => draw.object === h.scene).length,
      before + 1,
      `${type} invalidates the cached GPU pixels`,
    );
    h.pass.render(h.renderer, input, output);
    assert.equal(
      h.draws.filter((draw) => draw.object === h.scene).length,
      before + 1,
    );
  }
  h.pass.dispose();
  texture.dispose();
  mesh.geometry.dispose();
  mesh.material.dispose();
});

test('empty display overlay does not swap an unwritten frame buffer', () => {
  const h = harness();
  h.pass.render(h.renderer, { width: 1280, height: 800, texture: {} }, {});
  assert.equal(h.pass.needsSwap, false);
  assert.deepEqual(h.draws, []);
  h.pass.dispose();
});

test('ordinary overlays keep the direct pass without a display copy or target', () => {
  const h = harness(),
    input = { width: 1280, height: 800, samples: 4, texture: {} };
  h.overlay.displayBlend = false;
  h.setActive(true);
  h.pass.render(h.renderer, input);
  assert.equal(h.pass.display, null);
  assert.equal(h.draws.length, 1);
  assert.equal(h.draws[0].object, h.scene);
  assert.equal(h.target, input);
  assert.equal(h.renderer.autoClear, true);
  h.renderer.render = () => {
    throw new Error('ordinary draw failed');
  };
  assert.throws(() => h.pass.render(h.renderer, input), /ordinary draw failed/);
  assert.equal(h.renderer.autoClear, true);
  h.pass.dispose();
});

test('static sprite glyphs are drawn again when the Cyber sonar moves', () => {
  const h = harness(),
    input = { width: 1280, height: 800, texture: {} },
    output = {},
    mesh = new InstancedMesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: new Texture() }),
      1,
    );
  Object.assign(h.overlay.uniforms, {
    uGevSonar: { value: [0, 1, 0.84, 1] },
    uGevSonarSector: { value: 24 },
    uGevSonarEnabled: { value: 1 },
  });
  mesh.userData.gevStaticSprite = true;
  mesh.count = 1;
  h.scene.add(mesh);
  h.setActive(true);
  h.pass.render(h.renderer, input, output);
  const drawn = () => h.draws.filter((draw) => draw.object === h.scene).length;
  assert.equal(drawn(), 1);
  // The sweep turns (sonar.js writes the shared uniform each frame).
  h.overlay.uniforms.uGevSonar.value[0] = 90;
  h.pass.render(h.renderer, input, output);
  assert.equal(drawn(), 2, 'a new sonar angle draws the glyphs again');
  h.overlay.uniforms.uGevSonarSector.value = 60;
  h.pass.render(h.renderer, input, output);
  assert.equal(drawn(), 3, 'a new sector draws the glyphs again');
  // The Cyber treatment is turned off.
  h.overlay.uniforms.uGevSonarEnabled.value = 0;
  h.pass.render(h.renderer, input, output);
  assert.equal(drawn(), 4, 'sonar off draws the glyphs again');
  // Off, the angle still moves every frame; the glyphs stay cached.
  h.overlay.uniforms.uGevSonar.value[0] = 180;
  h.pass.render(h.renderer, input, output);
  assert.equal(drawn(), 4, 'the angle of an unused sonar draws nothing');
});
