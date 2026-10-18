import * as Cesium from 'cesium';
import { createCyberSonarGpu } from './cyberSonarGpu.js';
import {
  applyCyberSonarPrimitive,
  createCyberSonarSampler,
  isCyberContactThemeActive,
  isCyberContactSonarActive,
  isCyberSonarActive,
  readCyberSonarSettings,
  cyberSonarAngleDeg,
  syncCyberSonarAnimation,
  CYBER_SONAR_RENDER_INTERVAL_MS,
} from './cyberSonar.js';

const alive = (value) => value && !value.isDestroyed?.();
const diagnostics = new WeakMap();
export const getCyberSonarSceneDiagnostics = (viewer) => ({
  ...diagnostics.get(viewer),
});

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

/** Native dots, icons and glyphs use GPU draw-command treatment. Models retain
 * their existing reversible CPU color treatment without walking native records.
 */
export function createCyberSonarScene(viewer, manager) {
  const scene = viewer?.scene;
  if (
    !scene?.postUpdate?.addEventListener ||
    !scene?.preRender?.addEventListener
  )
    return () => {};
  const tracked = new Map();
  const matrix = new Cesium.Matrix4();
  const position = new Cesium.Cartesian3();
  let epoch = 0,
    timer = null,
    disposed = false;
  let sampler, width, height, active, count;
  const stats = { contacts: 0, updateMs: 0, frames: 0 };
  const root = globalThis.document?.documentElement;
  const gpu = createCyberSonarGpu(scene, () => ({
    ...readCyberSonarSettings(),
    enabled: isCyberContactThemeActive(),
    active: isCyberContactSonarActive(),
    angle: cyberSonarAngleDeg(performance.now()),
  }));
  stats.gpu = gpu.stats;
  let gpuSupported = gpu.stats.supported;
  diagnostics.set(viewer, stats);
  const restore = (visual, state) => {
    if (!alive(state.owner)) return;
    for (const key of state.keys)
      applyCyberSonarPrimitive(visual, 1, false, undefined, key);
  };
  const visit = (visual, owner, kind, visible) => {
    let state = tracked.get(visual);
    if (!visible) {
      if (state) {
        restore(visual, state);
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
    const w = matrix[3] * p.x + matrix[7] * p.y + matrix[11] * p.z + matrix[15];
    const x =
      (matrix[0] * p.x + matrix[4] * p.y + matrix[8] * p.z + matrix[12]) / w;
    const y =
      (matrix[1] * p.x + matrix[5] * p.y + matrix[9] * p.z + matrix[13]) / w;
    if (w <= 0 || Math.abs(x) > 1.1 || Math.abs(y) > 1.1) return;
    if (!state) {
      state = {
        owner,
        keys:
          kind === 'label'
            ? ['fillColor', 'outlineColor', 'backgroundColor']
            : kind === 'marker' && visual.outlineColor
              ? ['color', 'outlineColor']
              : ['color'],
        epoch,
      };
      tracked.set(visual, state);
    }
    state.epoch = epoch;
    const factor = active
      ? sampler.at((x + 1) * width * 0.5, (1 - y) * height * 0.5)
      : sampler.neutral;
    for (const key of state.keys) {
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
    if (disposed) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!isCyberContactThemeActive()) {
      for (const [visual, state] of tracked) restore(visual, state);
      tracked.clear();
      stats.contacts = 0;
      stats.updateMs = 0;
      return;
    }
    const started = performance.now();
    width = scene.canvas.clientWidth;
    height = scene.canvas.clientHeight;
    sampler = createCyberSonarSampler(width, height, started);
    active = isCyberContactSonarActive();
    Cesium.Matrix4.multiply(
      scene.camera.frustum.projectionMatrix,
      scene.camera.viewMatrix,
      matrix,
    );
    epoch++;
    count = 0;
    visitCyberSonarModels(scene.primitives, visit);
    for (const [visual, state] of tracked)
      if (state.epoch !== epoch) {
        restore(visual, state);
        tracked.delete(visual);
      }
    stats.contacts = count;
    stats.updateMs = performance.now() - started;
    stats.frames++;
    // No contacts, no scanner-owned render demand. In continuous scenes the
    // next rendered frame cancels this timer; parked scenes refresh at fleet
    // cadence. Idle update-only ticks must not continually postpone the timer.
  };
  let removeRender;
  // Aircraft fleet writers run in preRender, while tracked models and entity
  // visualizers update earlier. Compose AFTER all those owners and BEFORE
  // Cesium uploads primitive attributes for this draw. Requeue at postUpdate
  // so writers installed later (enable/re-enable/track) cannot overwrite sonar.
  // This only reorders one callback; the contact walk runs once per actual draw.
  const removeUpdate = scene.postUpdate.addEventListener(() => {
    if (isCyberSonarActive()) syncCyberSonarAnimation();
    const supportChanged = gpuSupported !== gpu.stats.supported;
    gpuSupported = gpu.stats.supported;
    const support = gpu.stats.supported ? 'supported' : 'unsupported';
    if (root?.dataset && root.dataset.cyberSonarGpu !== support)
      root.dataset.cyberSonarGpu = support;
    // Shader setup runs after preRender's model tint. If it fails while the
    // scene is parked (including Sonar OFF/reduced motion), draw once more so
    // the now-unsupported contact path restores models before becoming idle.
    if (supportChanged) scene.requestRender();
    const status = globalThis.document?.getElementById?.('cyber-sonar-status');
    const message = gpu.stats.supported
      ? ''
      : 'Contact GPU unavailable. Native contacts remain visible.';
    if (status && status.textContent !== message) status.textContent = message;
    removeRender?.();
    removeRender = scene.preRender.addEventListener(update);
  });
  const removePostRender = scene.postRender?.addEventListener(() => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (isCyberContactSonarActive() && (count || gpu.stats.visibleCommands))
      timer = setTimeout(() => {
        timer = null;
        if (!disposed && isCyberContactSonarActive()) scene.requestRender();
      }, CYBER_SONAR_RENDER_INTERVAL_MS);
  });
  const unsubscribe = manager?.subscribe?.((change) => {
    if (change.type !== 'visibility') return;
    scene.requestRender();
  });
  return () => {
    if (disposed) return;
    disposed = true;
    removeUpdate();
    removeRender?.();
    removePostRender?.();
    gpu.destroy();
    if (root?.dataset) delete root.dataset.cyberSonarGpu;
    unsubscribe?.();
    if (timer !== null) clearTimeout(timer);
    for (const [visual, state] of tracked) restore(visual, state);
    tracked.clear();
    diagnostics.delete(viewer);
  };
}
