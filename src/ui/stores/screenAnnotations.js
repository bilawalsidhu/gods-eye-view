import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The screen-space annotation board as its view renders it. The screen
 * annotation renderer (src/annotations/screenAnnotationRenderer.js) presents
 * every mark's SVG parts after each rendered frame; the view hands back the
 * elements the renderer measures and reports when a draw-on stroke finishes.
 */
export const useScreenAnnotationsStore = defineStore(
  'gev-screen-annotations',
  () => {
    /**
     * `{owner, viewBox, markers, marks}`, or null while no renderer exists.
     * Each mark is `{key, className, opacity, display, drawn, children}`;
     * `owner` is passed back with each element and report.
     */
    const board = shallowRef(null);

    /** @param {?object} next A fresh presentation; every publish re-renders. */
    function publish(next) {
      board.value = next && markRaw(next);
    }

    /**
     * The controls whose `attach(owner, key, kind, element)` and
     * `drawn(owner, key)` the view calls.
     */
    const controls = shallowRef(null);

    /** @param {?object} next The controls, or null to disconnect. */
    function connect(next) {
      controls.value = next && markRaw(next);
    }

    return { board, publish, controls, connect };
  },
);
