import { createWorldAnnotationRenderer } from './worldAnnotationRenderer.js';
import { createScreenAnnotationRenderer } from './screenAnnotationRenderer.js';

/**
 * Hybrid annotation renderer (Direction C — the recommended production blend).
 *
 * Routes each mark to the renderer that does it best:
 *   - `area` footprints  → WORLD-space, so the outline/fill drapes onto and
 *     conforms to the real 3D building/ground geometry (screen-space can only
 *     draw a flat polygon that ignores relief and building tops).
 *   - everything else (highlight / pin / arrow / label) → SCREEN-space SVG, for
 *     the hand-drawn "whiteboard" aesthetic: pulsing reticles, bowed arrows,
 *     and glassy callout cards with leader lines.
 *
 * The area's text label is also drawn as a SCREEN callout (the world drape is
 * label-less) so every caption shares one consistent style.
 *
 * The hybrid surface honors add/update/remove/sync/destroy; update coordinates the
 * one route change that spans both sub-renderers.
 *
 * @param {import('cesium').Viewer} viewer - Live viewer; the world route adds its
 *   entity data source to it and the screen route mounts its SVG host over it.
 * @returns {{add: Function, update: Function, remove: Function, sync: Function, destroy: Function}}
 *   Renderer handle satisfying the shared renderer contract consumed by the
 *   annotation engine (annotationEngine.js).
 */
export function createHybridAnnotationRenderer(viewer) {
  const world = createWorldAnnotationRenderer(viewer);
  const screen = createScreenAnnotationRenderer(viewer);
  // anno.id -> { worldProxy?, screenProxy? } — proxies own the sub-renderer state.
  const routed = new Map();

  /**
   * Route a new mark: areas and routes drape in world space (plus a screen
   * callout when labelled), everything else goes to screen only. The routing
   * entry is registered before any sub-renderer runs so a throw still leaves
   * the mark removable.
   *
   * @param {object} anno - Runtime annotation from the engine; needs `id` and
   *   `type`, plus the geometry fields that type implies (`ring`/`path`/`anchor`).
   */
  function add(anno) {
    const entry = {};
    // Route the entry FIRST, then fill it in. A sub-renderer throw (WebGL loss
    // mid-add) otherwise stranded whatever the earlier sub-renderer had already
    // created: `routed` never learned the id, so remove() was a no-op and the
    // engine's rollback could not reach the orphan — a re-annotate of the same
    // geometry then stacked a second mark over it. Registered up front, the
    // partial entry is addressable and remove() cleans exactly what exists.
    routed.set(anno.id, entry);
    if (anno.type === 'area' && anno.ring && anno.ring.length >= 3) {
      // Drape the footprint in world space, but without its own label...
      entry.worldProxy = liveProxy(anno, { label: null });
      world.add(entry.worldProxy);
      // ...and place the caption as a screen-space callout at the centroid.
      if (anno.label) {
        entry.screenProxy = liveProxy(anno, { type: 'label', ring: null });
        screen.add(entry.screenProxy);
      }
    } else if (anno.type === 'route' && Array.isArray(anno.path) && anno.path.length >= 2) {
      // Drape the path on the tiles (world), caption it with a screen callout
      // at the path midpoint.
      entry.worldProxy = liveProxy(anno, { label: null });
      world.add(entry.worldProxy);
      if (anno.label) {
        const mid = anno.path[Math.floor(anno.path.length / 2)];
        entry.screenProxy = liveProxy(anno, {
          type: 'label',
          path: null,
          anchor: { lon: mid.lon, lat: mid.lat, height: mid.height },
        });
        screen.add(entry.screenProxy);
      }
    } else {
      entry.screenProxy = anno;
      screen.add(anno);
    }
  }

  /**
   * Upgrade a pending area without replacing its existing screen-space group.
   * World geometry is new, but the reticle's SVG group is converted in place to
   * the centroid callout so there is no overlapping fade-out/fade-in pair.
   *
   * @param {object} anno - Runtime annotation being upgraded; an untracked `id`
   *   falls through to add(), and a non-area (or ring-less) mark is left alone.
   */
  function update(anno) {
    const entry = routed.get(anno.id);
    if (!entry) {
      add(anno);
      return;
    }
    if (anno.type !== 'area' || !anno.ring || anno.ring.length < 3) return;

    if (!entry.worldProxy) {
      entry.worldProxy = liveProxy(anno, { label: null });
      world.add(entry.worldProxy);
    }

    const screenProxy = liveProxy(anno, { type: 'label', ring: null });
    if (entry.screenProxy) {
      screen.update(screenProxy, { empty: !anno.label });
    } else if (anno.label) {
      screen.add(screenProxy);
    }
    entry.screenProxy = entry.screenProxy ? screenProxy : (anno.label ? screenProxy : null);
  }

  /**
   * Release both routes. Tolerates PARTIAL state (only one sub-renderer got
   * its content) and an absent id, so it doubles as the rollback path for a
   * failed add.
   *
   * Both releases are ALWAYS attempted, each clears its own proxy as it
   * succeeds, and the routing entry is dropped only once nothing is left to
   * release. A release that throws therefore leaves the id still addressable,
   * so a retry (or a later clear) can finish the job instead of the orphan
   * becoming permanently unreachable. The failure is rethrown after both
   * routes have had their turn.
   *
   * @param {object} anno - Runtime annotation to release; its `id` addresses the
   *   routing entry, and an id with no entry is a no-op.
   */
  function remove(anno) {
    const entry = routed.get(anno.id);
    if (!entry) return;
    let failure = null;
    if (entry.worldProxy) {
      try {
        world.remove(entry.worldProxy);
        entry.worldProxy = null;
      } catch (error) {
        failure = error; // keep the proxy: it still owns live geometry
      }
    }
    if (entry.screenProxy) {
      try {
        screen.remove(entry.screenProxy);
        entry.screenProxy = null;
      } catch (error) {
        failure = failure || error;
      }
    }
    if (!entry.worldProxy && !entry.screenProxy) routed.delete(anno.id);
    if (failure) throw failure;
  }

  /**
   * Hand the live annotation set to both sub-renderers for batch reconciliation.
   * Both current routes are no-ops (CallbackProperty and the postRender loop own
   * per-frame animation), so this exists purely as the contract's reconcile hook.
   *
   * @param {Map<string, object>} annotations - The engine's full annotation map,
   *   keyed by annotation id.
   */
  function sync(annotations) {
    world.sync(annotations);
    screen.sync(annotations);
  }

  /**
   * Tear down both sub-renderers (world data source and screen overlay layer)
   * and drop the routing table.
   */
  function destroy() {
    world.destroy();
    screen.destroy();
    routed.clear();
  }

  return { add, update, remove, sync, destroy };
}

/**
 * A proxy that inherits from `anno` via the prototype chain (so live fields the
 * engine mutates each tick — `alpha`, `bornAt`, `expiring` — are read through),
 * with a few own properties overridden. Sub-renderers store their own state
 * (`_entities`, SVG refs) as own properties on the proxy, isolated per route.
 *
 * @param {object} anno - Runtime annotation to inherit from.
 * @param {object} overrides - Own properties shadowing inherited fields (`label`,
 *   `type`, `ring`, `path`, `anchor` are the ones the routes use).
 * @returns {object} A fresh proxy whose prototype is `anno`, with `overrides` as
 *   its own enumerable properties.
 */
function liveProxy(anno, overrides) {
  return Object.assign(Object.create(anno), overrides);
}
