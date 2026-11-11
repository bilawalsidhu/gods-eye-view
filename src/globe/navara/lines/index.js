// engine.lines on Navara: each line is a ribbon (lineMesh.js) in gev's
// overlay (overlay.js: drawn after tone mapping, so its colour is exact). Geodesic arcs are densified on the CPU (src/globe/lines.js)
// since the ribbon draws straight segments. Every change asks for one frame;
// nothing animates on its own, so an idle view stays idle. Shown lines with
// a pickId participate in the engine's CPU picks; trails omit a pickId.

import { createLineRegistry, densifyGeodesic } from '../../lines.js';
import { createLineMesh } from './lineMesh.js';

/**
 * @param {object} view an initialised Navara ThreeView
 * @param {{ overlay: ReturnType<import('../overlay.js').createNavaraOverlay> }} ports
 * @returns {{ lines: import('../../contract.js').GlobeLines, destroy: () => void }}
 */
export function createNavaraLines(view, { overlay }) {
  const request = () => view.forceUpdate();
  // What CPU picks need of each line: its drawn positions and matrix.
  const drawn = new Map();
  const registry = createLineRegistry((options) => {
    const line = createLineMesh(options, {
      overlayUniforms: overlay.uniforms,
    });
    const state = {
      options,
      flat: new Float64Array(0),
      modelMatrix: options.modelMatrix,
      shown: true,
    };
    drawn.set(options.id, state);
    const canvas = view.canvas;
    const viewport = () =>
      line.update(
        canvas?.clientWidth || 1,
        canvas?.clientHeight || 1,
        overlay.ctx?.getRenderer().getPixelRatio() ?? 1,
      );
    viewport();
    overlay.add(line.group, viewport);
    return {
      setPositions(flat) {
        state.flat = options.arc === 'geodesic' ? densifyGeodesic(flat) : flat;
        line.setPositions(state.flat);
        request();
      },
      setSegments(items) {
        state.items = items;
        const flat = new Float64Array(items.length * 6);
        items.forEach((item, index) => flat.set(item.positions, index * 6));
        line.setPositions(flat, items);
        request();
      },
      setColor(rgba) {
        line.setColor(rgba);
        request();
      },
      setModelMatrix(matrix) {
        state.modelMatrix = matrix;
        line.setModelMatrix(matrix);
        request();
      },
      show(visible) {
        state.shown = visible;
        line.show(visible);
        request();
      },
      destroy() {
        drawn.delete(options.id);
        overlay.remove(line.group);
        line.dispose();
        request();
      },
    };
  });
  return {
    lines: registry.lines,
    /** Shown lines with a pickId: options, drawn positions, matrix. */
    pickables: () =>
      [...drawn.values()]
        .filter((state) => state.shown)
        .flatMap((state) =>
          state.options.segments
            ? (state.items ?? [])
                .filter((item) => item.pickId !== undefined)
                .map((item) => ({
                  options: {
                    ...state.options,
                    widthPx: item.widthPx,
                    pickId: item.pickId,
                  },
                  flat: item.positions,
                  modelMatrix: null,
                }))
            : state.options.pickId !== undefined
              ? [state]
              : [],
        ),
    destroy: () => registry.destroyAll(),
  };
}
