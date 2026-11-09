// The Cyber HUD sonar's contact treatment on the globe engine, which draws
// it (render.setContactSonar, the `contactSonar` capability: Navara's
// movers, Cesium's native draw commands and models). Each
// drawn frame hands the engine the theme's state, the sweep's settings and
// its angle on the shared clock (the CSS sweep's), so the contacts and the
// rings turn together; while the sweep runs over visible contacts a parked
// scene draws at the fleet cadence. An engine that can lose its treatment
// (Cesium's command adapter is tested against one Cesium version) says so
// through contactSonarDiagnostics, and the theme then leaves native
// contacts as they are.

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

/** Every mover instance the engine holds, on screen or not. */
const contactCount = (engine) =>
  engine.movers.list().reduce((count, set) => count + set.count, 0);

const UNSUPPORTED_MESSAGE =
  'Contact GPU unavailable. Native contacts remain visible.';

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
    documentRef = globalThis.document,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (id) => clearTimeout(id),
  } = {},
) {
  if (!engineCapabilities(engine).contactSonar) return () => {};
  let timer = null;
  let disposed = false;
  // Not contract: what the engine's treatment holds (Cesium's), or null.
  const diagnostics = () => engine.contactSonarDiagnostics?.() ?? null;
  // The Cyber contact theme counts on the contact adapter (cyberSonar.js
  // isCyberContactThemeActive). Returns whether its support changed.
  const syncSupport = () => {
    const supported = diagnostics()?.supported !== false;
    const support = supported ? 'supported' : 'unsupported';
    const status = documentRef?.getElementById?.('cyber-sonar-status');
    const message = supported ? '' : UNSUPPORTED_MESSAGE;
    if (status && status.textContent !== message) status.textContent = message;
    if (!root?.dataset || root.dataset.cyberSonarGpu === support) return false;
    root.dataset.cyberSonarGpu = support;
    return true;
  };
  syncSupport();
  const removeRender = engine.frames.preRender.addEventListener(() => {
    if (isCyberSonarActive({ root })) syncCyberSonarAnimation(root);
    engine.render.setContactSonar(cyberSonarEngineState(now(), root));
  });
  // Contacts the sweep passes over on screen, as the engine's treatment
  // reports them (Navara's movers in view; Cesium's tinted models and
  // visible native batches); an engine without a report, all its movers.
  const contactsShown = () => {
    const drawn = diagnostics();
    if (!drawn) return contactCount(engine) > 0;
    return Boolean(drawn.contacts || drawn.gpu?.visibleCommands);
  };
  const removePostRender = engine.frames.postRender.addEventListener(() => {
    // A treatment lost while the scene is parked (Sonar OFF, reduced
    // motion) draws once more, so the native contacts come back.
    if (syncSupport()) engine.render.request('cyber-sonar');
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (isCyberContactSonarActive({ root }) && contactsShown())
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
