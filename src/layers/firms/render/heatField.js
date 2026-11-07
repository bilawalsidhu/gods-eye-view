// The Active Fires far-zoom heatmap behind one seam: one equirectangular
// RGBA raster over the whole globe (data/firmsHeatRaster.js), draped on the
// terrain and 3D tiles and blended between texels. The globe contract has no
// primitive for an image draped on the ground yet (engine.ground draws flat
// colours per item), so each engine draws it through its own backend:
// render/cesiumHeat.js (one imagery layer on the active imagery host) and
// render/navaraHeat.js (a surface pass in Navara's view), which the Navara
// mode loads and passes in, as Navara modules reach the app only through its
// import(). This is the only FIRMS module that reads engine.extensions.
//
// The field keeps what the layer asked for, so an engine with no backend
// (the fake engine) draws nothing and still answers.

import { createFirmsCesiumHeat } from './cesiumHeat.js';

/**
 * The heatmap with heatImagery.js's interface: setRaster, hasRaster,
 * setShow, setOpacity (the hand-off fade, 0..1), rehome (follow the active
 * imagery host) and destroy.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ imageryHost?: () => ({ collection: object, kind: string } | null),
 *   navaraHeat?: (engine: object, navara: object) => object }} [options]
 *   `imageryHost` is the shell's imagery host (Cesium); `navaraHeat` the
 *   Navara backend's factory (render/navaraHeat.js).
 */
export function createFirmsHeatField(engine, { imageryHost, navaraHeat } = {}) {
  const cesium = engine.extensions?.cesium;
  const navara = engine.extensions?.navara;
  const backend = cesium
    ? createFirmsCesiumHeat(cesium, imageryHost)
    : navara && navaraHeat
      ? navaraHeat(engine, navara)
      : null;
  let raster = null,
    show = true,
    opacity = 1,
    destroyed = false;
  return {
    setRaster(next) {
      if (destroyed) return;
      raster = next;
      backend?.setRaster(next);
    },
    /** True once a raster was handed over. */
    hasRaster: () => raster !== null,
    setShow(value) {
      if (destroyed) return;
      show = Boolean(value);
      backend?.setShow(show);
    },
    setOpacity(value) {
      if (destroyed) return;
      opacity = Math.min(1, Math.max(0, Number(value) || 0));
      backend?.setOpacity(opacity);
    },
    rehome() {
      if (!destroyed) backend?.rehome();
    },
    /** What the layer asked for: { raster, show, opacity, drawn }. */
    state: () => ({ raster, show, opacity, drawn: backend !== null }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      backend?.destroy();
      raster = null;
    },
  };
}
