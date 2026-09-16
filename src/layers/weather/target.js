const MAP_STACK_EVENT = 'gev:map-stack-changed';

/**
 * States in which the controller has finished applying a stack. `switching`
 * precedes activation, so the target it would report is the one being left.
 */
const SETTLED = new Set(['ready', 'error']);

/**
 * Where this layer draws, and when that changes.
 *
 * Imagery renders into whichever collection is live: the globe's under a globe
 * stack, a photoreal tileset's under one that hides the globe. The map
 * controller owns both halves of that switch and is therefore the only honest
 * answer — but it is attached after construction, because the layer catalogue
 * is built before the scene exists.
 *
 * So the target is resolved on every use rather than captured. That is also
 * what makes the boot activation correct: it is applied silently and emits no
 * change event, so anything caching from the event stream would start wrong.
 *
 * @returns {{attach: Function, subscribe: Function, resolve: Function}} Port.
 */
export function createMapStackTarget() {
  let controller = null;
  return {
    /**
     * Receive the map controller once the scene owns one.
     * @param {object|null} next The controller, or null to release it.
     */
    attach(next) {
      controller = next || null;
    },

    /**
     * Call back when the rendered collection may have changed.
     * @param {Function} handler Invoked with no arguments.
     * @returns {Function} Unsubscribe.
     */
    subscribe(handler) {
      if (typeof window === 'undefined') return () => {};
      const listener = (event) => {
        // Acting on `switching` would draw into a collection about to be
        // abandoned. A payload-less event is a settled one by construction.
        if (event?.detail && !SETTLED.has(event.detail.status)) return;
        handler();
      };
      window.addEventListener(MAP_STACK_EVENT, listener);
      return () => window.removeEventListener(MAP_STACK_EVENT, listener);
    },

    /**
     * The collection to draw into right now.
     *
     * With no controller there is no stack that can hide the globe — the case
     * for the packaged `layers/weather` entry in a host that composes its own
     * scene — so the globe is the answer, not a degraded one.
     *
     * @param {object} viewer Cesium viewer.
     * @returns {{regime: 'globe'|'tileset', imageryLayers: object|null}} Target.
     */
    resolve(viewer) {
      return (
        controller?.getImageryTarget?.() ?? {
          regime: 'globe',
          imageryLayers: viewer?.imageryLayers ?? null,
        }
      );
    },
  };
}
