// gev's screen overlays on Navara: sprites, points and lines (engine.movers
// and engine.lines) drawn into the frame after Navara's tone mapping and
// before its anti-aliasing (SMAA/FXAA) and the gev sharpening, so their
// colours are the colours asked for (as Cesium draws billboards and
// polylines), not tone-mapped or graded with the look. A public Navara
// EffectDesc whose pass renders one three scene over the input buffer; the
// post-processing chain has no depth buffer, so each overlay material tests
// the scene depth from Navara's MRT pass itself (overlayDepth.js). The
// pass costs nothing while the scene is empty. Models stay in Navara's
// scene, lit and graded like the 3D tiles.

import { EffectDesc, Pass as NavaraPass } from '@navaramap/three';
import { Pass } from 'postprocessing';
import { RGBADepthPacking, Scene } from 'three';

export const OVERLAY_EFFECT_KEY = 'gevOverlay';

class GevOverlayPass extends Pass {
  constructor(scene, camera, overlay) {
    super('GevOverlayPass', scene, camera);
    this.needsSwap = false;
    this.overlay = overlay;
  }

  render(renderer, inputBuffer) {
    if (!this.scene.children.length) return;
    const resolution = this.overlay.uniforms.uGevResolution.value;
    resolution[0] = inputBuffer?.width ?? 0;
    resolution[1] = inputBuffer?.height ?? 0;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
  }
}

class GevOverlayEffectDesc extends EffectDesc {
  static key = OVERLAY_EFFECT_KEY;
  static insertAfter = ['toneMapping'];
  static insertBefore = ['gevSharpen', 'smaa', 'fxaa', 'final'];

  constructor(view, ctx, config) {
    super(view, ctx, config);
    this.overlay = config[OVERLAY_EFFECT_KEY].overlay;
    this.overlay.attach(ctx);
  }

  createPass() {
    const camera = this.view.camera.raw;
    if (!camera) throw new Error('Camera not available for the overlay');
    // In Navara's own Pass wrapper: Navara inserts a bare pass only when
    // it is an instance of its own postprocessing copy.
    return new NavaraPass(
      new GevOverlayPass(this.overlay.scene, camera, this.overlay),
      null,
    );
  }

  // Each drawn frame: the scene depth the overlays test against, then each
  // overlay's own per-frame work (pixel footprint, origin, viewport).
  update(time) {
    const mrt = this.find('mrt');
    this.overlay.uniforms.tGevSceneDepth.value =
      mrt?.depthBufferPacking === RGBADepthPacking ? mrt.depthBuffer : null;
    this.overlay.beforeFrame(time);
  }
}

/**
 * The overlay of one view: add(object, onFrame) puts a three object in the
 * overlay scene (onFrame runs each drawn frame before it draws);
 * registerPickable/unregisterPickable reach Navara's pick pass.
 * @param {object} view an initialised ThreeView
 */
export function createNavaraOverlay(view) {
  view.registerEffect(OVERLAY_EFFECT_KEY, GevOverlayEffectDesc);
  const scene = new Scene();
  const frameHooks = new Map();
  let ctx = null;
  const pendingPicks = new Map();
  const overlay = {
    scene,
    uniforms: {
      tGevSceneDepth: { value: null },
      uGevResolution: { value: [0, 0] },
    },
    attach(context) {
      ctx = context;
      for (const [key, wrapper] of pendingPicks)
        ctx.registerPickableMesh(key, wrapper);
      pendingPicks.clear();
    },
    beforeFrame(time) {
      for (const hook of frameHooks.values()) hook(time);
    },
    get ctx() {
      return ctx;
    },
  };
  const handle = view.addEffect({
    [OVERLAY_EFFECT_KEY]: { overlay },
    visible: true,
  });
  return {
    scene,
    uniforms: overlay.uniforms,
    add(object, onFrame) {
      scene.add(object);
      if (onFrame) frameHooks.set(object, onFrame);
    },
    remove(object) {
      scene.remove(object);
      frameHooks.delete(object);
    },
    registerPickable(key, wrapper) {
      if (ctx) ctx.registerPickableMesh(key, wrapper);
      else pendingPicks.set(key, wrapper);
    },
    unregisterPickable(key) {
      pendingPicks.delete(key);
      ctx?.unregisterPickableMesh(key);
    },
    get ctx() {
      return ctx;
    },
    destroy() {
      handle.delete();
      scene.clear();
      frameHooks.clear();
    },
  };
}
