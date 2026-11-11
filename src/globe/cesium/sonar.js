// The Cyber HUD sonar's contact treatment on Cesium (render.setContactSonar,
// the `contactSonar` capability), drawn from the state the app hands the
// engine each frame (src/cyberSonarEngine.js). Native dots, icons and
// glyphs get derived draw commands whose shaders apply the sweep
// (sonarCommands.js); models keep their reversible CPU colour treatment
// (src/cyberSonar.js applyCyberSonarPrimitive), without walking native
// records. Nothing joins the scene before the treatment is first on; turning
// it off gives the models their colours back at once.

import * as Cesium from 'cesium';
import {
  applyCyberSonarPrimitive,
  cyberSonarSampler,
} from '../../cyberSonar.js';
import {
  CYBER_SONAR_CESIUM_VERSION,
  createCyberSonarGpu,
} from './sonarCommands.js';

const alive = (value) => value && !value.isDestroyed?.();

export function visitCyberSonarModels(primitive, visit, visible = true) {
  if (!alive(primitive)) return;
  visible = visible && primitive.show !== false;
  if (primitive instanceof Cesium.PrimitiveCollection) {
    for (let i = 0; i < primitive.length; i++)
      visitCyberSonarModels(primitive.get(i), visit, visible);
  } else if (primitive instanceof Cesium.Model) {
    visit(primitive, primitive, 'model', visible && primitive.ready);
  }
}

/**
 * The sonar on `viewer`'s scene. `set(state)` takes the merged
 * ContactSonar (src/globe/contract.js) for the next drawn frame;
 * `diagnostics()` is what the treatment holds, live: whether the command
 * adapter runs on this Cesium (`supported`), the models it tinted last
 * frame (`contacts`) and the native batches it drew (`gpu`: commands,
 * visibleCommands, programs, error).
 * @param {Cesium.Viewer} viewer
 * @param {{ createGpu?: typeof createCyberSonarGpu }} [options] A test seam.
 */
export function createCesiumSonar(
  viewer,
  { createGpu = createCyberSonarGpu } = {},
) {
  const scene = viewer?.scene;
  let state = null;
  let treatment = null;
  const stats = { contacts: 0, updateMs: 0, frames: 0, gpu: null };
  // Read every frame (src/cyberSonarEngine.js): one live view, no copies.
  const report = Object.freeze({
    get supported() {
      return (
        stats.gpu?.supported ?? Cesium.VERSION === CYBER_SONAR_CESIUM_VERSION
      );
    },
    get contacts() {
      return stats.contacts;
    },
    get updateMs() {
      return stats.updateMs;
    },
    get frames() {
      return stats.frames;
    },
    get gpu() {
      return stats.gpu;
    },
  });

  function attach() {
    const tracked = new Map();
    const matrix = new Cesium.Matrix4();
    const position = new Cesium.Cartesian3();
    let epoch = 0;
    let sampler, width, height, active, count;
    const gpu = createGpu(scene, () => state);
    stats.gpu = gpu.stats;
    const restore = (visual, entry) => {
      if (!alive(entry.owner)) return;
      for (const key of entry.keys)
        applyCyberSonarPrimitive(visual, 1, false, undefined, key);
    };
    const restoreAll = () => {
      for (const [visual, entry] of tracked) restore(visual, entry);
      tracked.clear();
      stats.contacts = 0;
      stats.updateMs = 0;
    };
    const visit = (visual, owner, kind, visible) => {
      let entry = tracked.get(visual);
      if (!visible) {
        if (entry) {
          restore(visual, entry);
          tracked.delete(visual);
        }
        return;
      }
      let p = visual.position;
      if (kind === 'model')
        p = Cesium.Matrix4.getTranslation(visual.modelMatrix, position);
      else if (
        p &&
        owner.modelMatrix &&
        !Cesium.Matrix4.equals(owner.modelMatrix, Cesium.Matrix4.IDENTITY)
      )
        p = Cesium.Matrix4.multiplyByPoint(owner.modelMatrix, p, position);
      if (!p) return;
      const w =
        matrix[3] * p.x + matrix[7] * p.y + matrix[11] * p.z + matrix[15];
      const x =
        (matrix[0] * p.x + matrix[4] * p.y + matrix[8] * p.z + matrix[12]) / w;
      const y =
        (matrix[1] * p.x + matrix[5] * p.y + matrix[9] * p.z + matrix[13]) / w;
      if (w <= 0 || Math.abs(x) > 1.1 || Math.abs(y) > 1.1) return;
      if (!entry) {
        entry = {
          owner,
          keys:
            kind === 'label'
              ? ['fillColor', 'outlineColor', 'backgroundColor']
              : kind === 'marker' && visual.outlineColor
                ? ['color', 'outlineColor']
                : ['color'],
          epoch,
        };
        tracked.set(visual, entry);
      }
      entry.epoch = epoch;
      const factor = active
        ? sampler.at((x + 1) * width * 0.5, (1 - y) * height * 0.5)
        : sampler.neutral;
      for (const key of entry.keys) {
        if (key === 'outlineColor' && visual.outlineWidth === 0) continue;
        if (key === 'backgroundColor' && !visual.showBackground) continue;
        applyCyberSonarPrimitive(
          visual,
          kind === 'label' ? sampler.label(factor) : factor,
          true,
          sampler,
          key,
          kind === 'model',
        );
      }
      count++;
    };
    const update = () => {
      if (!state?.enabled || !gpu.stats.supported) {
        restoreAll();
        return;
      }
      const started = performance.now();
      width = scene.canvas.clientWidth;
      height = scene.canvas.clientHeight;
      sampler = cyberSonarSampler(width, height, state);
      active = state.active;
      Cesium.Matrix4.multiply(
        scene.camera.frustum.projectionMatrix,
        scene.camera.viewMatrix,
        matrix,
      );
      epoch++;
      count = 0;
      visitCyberSonarModels(scene.primitives, visit);
      for (const [visual, entry] of tracked)
        if (entry.epoch !== epoch) {
          restore(visual, entry);
          tracked.delete(visual);
        }
      stats.contacts = count;
      stats.updateMs = performance.now() - started;
      stats.frames++;
    };
    let removeRender;
    // Aircraft fleet writers run in preRender, while tracked models and
    // entity visualizers update earlier. Compose AFTER all those owners and
    // BEFORE Cesium uploads primitive attributes for this draw. Requeue at
    // postUpdate so writers installed later (enable/re-enable/track) cannot
    // overwrite sonar. This only reorders one callback; the contact walk
    // runs once per actual draw.
    const removeUpdate = scene.postUpdate.addEventListener(() => {
      removeRender?.();
      removeRender = scene.preRender.addEventListener(update);
    });
    return {
      restoreAll,
      destroy() {
        removeUpdate();
        removeRender?.();
        gpu.destroy();
        restoreAll();
      },
    };
  }

  return {
    set(next) {
      state = next;
      if (next.enabled) treatment ??= attach();
      else treatment?.restoreAll();
    },
    diagnostics: () => report,
    destroy() {
      treatment?.destroy();
      treatment = null;
    },
  };
}
