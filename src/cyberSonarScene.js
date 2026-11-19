/**
 * The Cyber contact sweep on the map's markers, through the renderer's
 * `effects.screenModulation` (`src/render/contract/effects.d.ts`). This
 * keeps the sweep's clock and settings; the renderer shades the markers.
 *
 * Each tick, before the renderer decides whether to draw: a change of the
 * theme, the sweep, its settings or the map's size sets the sector at once;
 * while sweeping, the sector moves to the current angle on every tick that
 * draws anyway, and at least every `CYBER_SONAR_RENDER_INTERVAL_MS` (which
 * then asks for a frame). Out of the theme the sector is cleared.
 *
 * A renderer without the capability, or one that does not list the pass
 * once a sector is set, leaves markers as they are: the document's
 * `cyberSonarGpu` says `unsupported`, so the HUD overlays skip their own
 * sweep too, and the sonar status says so.
 *
 * The frame and effects ports are looked up once, when the scene is made:
 * bind the renderer to the viewer before creating it.
 */
import {
  CYBER_SONAR_RENDER_INTERVAL_MS,
  cyberSonarSector,
  isCyberMapThemeActive,
  isCyberSonarActive,
  readCyberSonarSettings,
  syncCyberSonarAnimation,
} from './cyberSonar.js';
import { canvasOf, findEffects, findFrame } from './render/rendererOf.js';

const UNSUPPORTED_MESSAGE =
  'Contact GPU unavailable. Native contacts remain visible.';

/**
 * @param {object} viewer The scene object the renderer is bound to.
 * @param {{subscribe?: Function}} [manager] Layer visibility changes ask
 *   for a frame, so markers shown or hidden draw with the sweep.
 * @returns {() => void} Clears the sector and lets go.
 */
export function createCyberSonarScene(viewer, manager) {
  const frame = findFrame(viewer);
  if (!frame) return () => {};
  const effects = findEffects(viewer);
  const doc = globalThis.document;
  const root = doc?.documentElement;
  let failed = typeof effects?.screenModulation !== 'function';
  let current = null;
  let key = null;
  let lastSetAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const publish = () => {
    const support = failed ? 'unsupported' : 'supported';
    if (root?.dataset && root.dataset.cyberSonarGpu !== support)
      root.dataset.cyberSonarGpu = support;
    const status = doc?.getElementById?.('cyber-sonar-status');
    const message = failed ? UNSUPPORTED_MESSAGE : '';
    if (status && status.textContent !== message) status.textContent = message;
  };

  /** The renderer cannot draw the pass: markers stay as they are. */
  const fail = () => {
    if (failed) return;
    failed = true;
    const had = current;
    current = null;
    key = null;
    if (had) effects.screenModulation(null);
    publish();
  };

  const set = (sector, at) => {
    const had = current;
    // Before the call: its change listeners read `current`.
    current = sector;
    lastSetAt = at;
    effects.screenModulation(sector);
    // A first sector set but not listed is unsupported; a pass that stops
    // later is caught by the change listener.
    if (
      sector &&
      !had &&
      !effects.diagnostics().passes.includes('screenModulation')
    )
      fail();
  };

  const offTick = frame.on('preUpdate', (t) => {
    if (disposed) return;
    // The HUD's own sweep keeps its clock whether or not markers are shaded.
    const active = isCyberSonarActive();
    if (active) syncCyberSonarAnimation();
    if (failed) return;
    const theme = isCyberMapThemeActive();
    const sweeping = theme && active;
    if (!theme) {
      if (current) set(null, lastSetAt);
      key = null;
      return;
    }
    const canvas = canvasOf(viewer);
    // The sector is in CSS pixels.
    const width = canvas?.clientWidth ?? 0;
    const height = canvas?.clientHeight ?? 0;
    const settings = readCyberSonarSettings(root);
    const next = `${sweeping}|${settings.range}|${settings.opacity}|${settings.sector}|${width}|${height}`;
    const now = performance.now();
    if (
      next === key &&
      !(
        sweeping &&
        (now - lastSetAt >= CYBER_SONAR_RENDER_INTERVAL_MS || t.rendering)
      )
    )
      return;
    key = next;
    set(cyberSonarSector(width, height, now, { sweeping, root }), now);
  });

  const offChange = failed
    ? null
    : effects.on('change', (diagnostics) => {
        if (current && !diagnostics.passes.includes('screenModulation')) fail();
      });

  const unsubscribe = manager?.subscribe?.((change) => {
    if (change.type === 'visibility') frame.requestRender('cyber-sonar');
  });

  publish();
  return () => {
    if (disposed) return;
    disposed = true;
    offTick();
    offChange?.();
    unsubscribe?.();
    const had = current;
    current = null;
    if (had) effects.screenModulation(null);
    if (root?.dataset) delete root.dataset.cyberSonarGpu;
  };
}
