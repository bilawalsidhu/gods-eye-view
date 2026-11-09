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
      uGevSonar: { value: [0, 1, 0.84, 1] },
      uGevSonarSector: { value: 24 },
      uGevSonarEnabled: { value: 1 },
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
test('static sprite glyphs are drawn again when the Cyber sonar moves', () => {
  const h = harness(),
    input = { width: 1280, height: 800, texture: {} },
    output = {},
    mesh = new InstancedMesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: new Texture() }),
      1,
    );
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
