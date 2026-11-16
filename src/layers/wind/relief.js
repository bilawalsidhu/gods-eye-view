import { findGlobe } from '../../render/rendererOf.js';

/** The darkest the relief shading gets, as an opacity. */
export const WIND_RELIEF_STRENGTH = 0.28;

/**
 * View-directed display shading of the globe's relief while the wind layer
 * shows: the globe port's `hillshade` surface shading (capability
 * `surfaceShading`), over the terrain's own normals or, without them, the
 * ellipsoid's curvature. It stands for no sun, changes no geometry and asks
 * for no data. The renderer owns the material: it never takes one someone
 * else holds, and gives it back when cleared. No animation or source
 * acquisition.
 */
export function createWindRelief({ getViewer, globeOf = findGlobe } = {}) {
  // The globe port shading for this layer, and the viewer it belongs to.
  let globe = null;
  let viewer = null;
  let destroyed = false;
  let reason = 'Not attached';
  const alive = (value) => value && !value.isDestroyed?.();

  function clear() {
    if (globe && alive(viewer)) globe.setSurfaceShading(null);
    globe = null;
    viewer = null;
    reason = destroyed ? 'Destroyed' : 'Not attached';
  }

  return {
    attach() {
      if (destroyed) return false;
      const next = getViewer?.();
      const port = alive(next) ? globeOf(next) : null;
      if (globe && globe === port) return true;
      clear();
      if (typeof port?.setSurfaceShading !== 'function') {
        reason = 'Globe material unavailable';
        return false;
      }
      try {
        port.setSurfaceShading({
          kind: 'hillshade',
          strength: WIND_RELIEF_STRENGTH,
        });
      } catch {
        // The port may hold the request even though it could not draw it;
        // take it back so it never shows up later, after Wind is off.
        try {
          port.setSurfaceShading(null);
        } catch {
          // Nothing was kept.
        }
        reason = 'Relief material unavailable';
        return false;
      }
      globe = port;
      viewer = next;
      reason = null;
      return true;
    },
    clear,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clear();
    },
    getDiagnostics() {
      return {
        active: globe !== null,
        reason,
        lighting: 'View-directed display shading',
        mode: globe ? 'hillshade' : null,
        maxOpacity: WIND_RELIEF_STRENGTH,
      };
    },
  };
}
