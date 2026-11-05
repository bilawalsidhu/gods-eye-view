// The Cyber HUD sonar's contact treatment on a globe engine that draws it
// itself (render.setContactSonar, the `contactSonar` capability: Navara's
// sprite and point movers), the counterpart of src/cyberSonarScene.js on a
// Cesium viewer. Each drawn frame hands the engine the theme's state, the
// sweep's settings and its angle on the shared clock (the CSS sweep's), so
// the contacts and the rings turn together; while the sweep runs over
// visible contacts a parked scene draws at the fleet cadence, as on Cesium.

import { engineCapabilities } from './globe/contract.js';
import {
  CYBER_SONAR_RENDER_INTERVAL_MS,
  cyberSonarAngleDeg,
  isCyberContactSonarActive,
  isCyberContactThemeActive,
  isCyberSonarActive,
  readCyberSonarSettings,
  syncCyberSonarAnimation,
} from './cyberSonar.js';

/** The engine's sonar state for this moment (render.setContactSonar). */
export function cyberSonarEngineState(
  nowMs,
  root = globalThis.document?.documentElement,
) {
  const settings = readCyberSonarSettings(root);
  return {
    enabled: isCyberContactThemeActive({ root }),
    active: isCyberContactSonarActive({ root }),
    angleDeg: cyberSonarAngleDeg(nowMs),
    range: settings.range,
    opacity: settings.opacity,
    sector: settings.sector,
  };
}

/** Sprite and point instances the engine draws (models keep their colours). */
const contactCount = (engine) =>
  engine.movers
    .list()
    .filter((set) => set.kind !== 'model')
    .reduce((count, set) => count + set.count, 0);

/**
 * @param {import('./globe/contract.js').GlobeEngine} engine
 * @param {{ subscribe?: Function }} [manager] The layer manager: a
 *   visibility change draws a frame.
 * @returns {() => void} Removes the treatment.
 */
export function createCyberSonarEngineScene(
  engine,
  manager,
  {
    now = () => performance.now(),
    root = globalThis.document?.documentElement,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (id) => clearTimeout(id),
  } = {},
) {
  if (!engineCapabilities(engine).contactSonar) return () => {};
  let timer = null;
  let disposed = false;
  // The Cyber contact theme counts on the contact adapter (cyberSonar.js
  // isCyberContactThemeActive): this engine has one.
  if (root?.dataset) root.dataset.cyberSonarGpu = 'supported';
  const removeRender = engine.frames.preRender.addEventListener(() => {
    if (isCyberSonarActive({ root })) syncCyberSonarAnimation(root);
    engine.render.setContactSonar(cyberSonarEngineState(now(), root));
  });
  const removePostRender = engine.frames.postRender.addEventListener(() => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (isCyberContactSonarActive({ root }) && contactCount(engine))
      timer = setTimer(() => {
        timer = null;
        if (!disposed && isCyberContactSonarActive({ root }))
          engine.render.request('cyber-sonar');
      }, CYBER_SONAR_RENDER_INTERVAL_MS);
  });
  const unsubscribe = manager?.subscribe?.((change) => {
    if (change.type === 'visibility') engine.render.request('cyber-sonar');
  });
  return () => {
    if (disposed) return;
    disposed = true;
    removeRender();
    removePostRender();
    unsubscribe?.();
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (root?.dataset) delete root.dataset.cyberSonarGpu;
    if (!engine.isDestroyed?.())
      engine.render.setContactSonar({ enabled: false, active: false });
  };
}
