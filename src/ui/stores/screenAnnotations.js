import { defineStore } from 'pinia';
import { presented } from './presented.js';

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
    const [board, publish] = presented();

    /**
     * The controls whose `attach(owner, key, kind, element)` and
     * `drawn(owner, key)` the view calls.
     */
    const [controls, connect] = presented();

    return { board, publish, controls, connect };
  },
);
