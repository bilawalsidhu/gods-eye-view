import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The full-globe celestial ring as its view renders it. The ring owner
 * (src/celestialRing.js) presents the overlay's state, the outline and where
 * the sun and moon layers and markers sit; the view hands its two canvases
 * back to the connected controls, which paint them.
 */
export const useCelestialRingStore = defineStore('gev-celestial-ring', () => {
  /**
   * `{owner, container, enabled, visible, globeVisible, ephemerisUpdates,
   * size, outline, sun, moon, sunMarker, moonMarker}`, or null while no ring
   * exists. `container` is the element it sits in; `owner` is passed back
   * with each canvas.
   */
  const ring = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    ring.value = next && markRaw(next);
  }

  /** The controls whose `attach(owner, kind, canvas)` each canvas calls. */
  const controls = shallowRef(null);

  /** @param {?object} next The controls, or null to disconnect. */
  function connect(next) {
    controls.value = next && markRaw(next);
  }

  return { ring, publish, controls, connect };
});
