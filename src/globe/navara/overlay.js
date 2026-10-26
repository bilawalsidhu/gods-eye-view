// gev's screen overlays on Navara: sprites, points and lines (engine.movers
// and engine.lines) drawn into the frame after Navara's tone mapping,
// anti-aliasing (SMAA/FXAA) and the gev sharpening, so their
// colours are the colours asked for (as Cesium draws billboards and
// polylines), not tone-mapped or graded with the look. A public Navara
// EffectDesc whose pass renders one three scene over the input buffer; the
// post-processing chain has no depth buffer, so each overlay material tests
// the scene depth from Navara's MRT pass itself (overlayDepth.js). The
// pass costs nothing while no geometry is visible. Models retain scene
// depth; their lit display colour is resolved here so HDR effects and MSAA
// cannot spread a tint into neighbouring pixels.

import { EffectDesc, Pass as NavaraPass } from '@navaramap/three';
import { GevOverlayPass } from './overlayPass.js';
import { RGBADepthPacking, Scene } from 'three';

export const OVERLAY_EFFECT_KEY = 'gevOverlay';

class GevOverlayEffectDesc extends EffectDesc {
  static key = OVERLAY_EFFECT_KEY;
  // Navara takes the first existing anchor, so the latest pass comes first.
  static insertAfter = ['fxaa', 'smaa', 'gevSharpen', 'toneMapping'];
  static insertBefore = ['final'];

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
  const lights = new Map();
  let ctx = null;
  const pendingPicks = new Map();
  const overlay = {
    scene,
    modelTints: new Set(),
    uniforms: {
      uGevModelExposure: { value: 1 },
      tGevSceneDepth: { value: null },
      uGevResolution: { value: [0, 0] },
    },
    attach(context) {
      ctx = context;
      for (const [key, wrapper] of pendingPicks)
        ctx.registerPickableMesh(key, wrapper);
      pendingPicks.clear();
    },
    hasDrawables() {
      for (const child of scene.children)
        if (
          !child.isLight &&
          child.visible &&
          (child.count === undefined || child.count > 0)
        )
          return true;
      return false;
    },
    beforeFrame(time) {
      overlay.uniforms.uGevModelExposure.value = view.toneMappingExposure ?? 1;
      // Public descriptor lights are copied, never reparented from Navara.
      if (overlay.modelTints.size && ctx) {
        for (const light of ctx.scenes.light.children) {
          if (!light.isLight) continue;
          let copy = lights.get(light);
          if (!copy) {
            copy = light.clone(false);
            copy.castShadow = false;
            copy.matrixAutoUpdate = false;
            lights.set(light, copy);
            scene.add(copy);
          }
          copy.color.copy(light.color);
          copy.intensity = light.intensity;
          copy.matrix.copy(light.matrixWorld);
          copy.sh?.copy(light.sh);
          copy.groundColor?.copy(light.groundColor);
          if (copy.target && light.target) {
            copy.target.matrixAutoUpdate = false;
            copy.target.matrix.copy(light.target.matrixWorld);
            copy.target.updateMatrixWorld(true);
          }
        }
      }
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
      if (object.userData.gevModelTint) overlay.modelTints.add(object);
      if (onFrame) frameHooks.set(object, onFrame);
    },
    remove(object) {
      scene.remove(object);
      overlay.modelTints.delete(object);
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
      overlay.modelTints.clear();
      for (const light of lights.values()) light.dispose?.();
      lights.clear();
      frameHooks.clear();
    },
  };
}
