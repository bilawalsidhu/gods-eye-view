// The Global Context range pulses behind one seam: a disc the size of the
// range whose shader draws up to four pulse lines, their halos and the band
// fading inward behind each, with fronts and opacities that change every
// frame. The globe contract has no primitive for an animated fill (a ground
// set rebuilds on every commit), so each engine draws it through its own
// backend: render/cesiumPulses.js (a material disc at the rim height) and
// render/navaraPulses.js (a surface pass in Navara's view), which the Navara
// mode loads and passes in, as Navara modules reach the app only through
// its import(). This is the only awareness module that reads
// engine.extensions.
//
// An engine with no backend (the fake engine) draws no pulses, and the
// layer keeps its range ring static there.

import { createAwarenessCesiumPulses } from './cesiumPulses.js';

/**
 * The pulse disc around `center` on `engine`, or null when the engine has no
 * backend: `draw({ radii, alphas, level })` each frame with the fronts as
 * fractions of `radiusM` and their opacities, `move(center)`, `destroy()`.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {object} disc The disc: `center`, `radiusM`, rgba `color` (the
 *   band), `lineColor`, `haloColor`, `depth`, `lineWidth`, `haloWidth`.
 * @param {{ navaraPulses?: (engine: object, navara: object, disc: object) => object }} [backends]
 *   `navaraPulses` is the Navara backend's factory (render/navaraPulses.js).
 */
export function createAwarenessPulseField(engine, disc, { navaraPulses } = {}) {
  const cesium = engine.extensions?.cesium;
  const navara = engine.extensions?.navara;
  if (cesium) return createAwarenessCesiumPulses(cesium, disc);
  if (navara?.view && navara.EffectDesc && navara.NavaraEffect && navaraPulses)
    return navaraPulses(engine, navara, disc);
  return null;
}
