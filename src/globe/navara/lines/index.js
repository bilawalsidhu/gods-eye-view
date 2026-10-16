// engine.lines on Navara: each line is one Navara mesh descriptor (public
// MeshDesc API, the transparent pass, unlit) holding its ribbon
// (lineMesh.js). Geodesic arcs are densified on the CPU (src/globe/lines.js)
// since the ribbon draws straight segments. Every change asks for one frame;
// nothing animates on its own, so an idle view stays idle. Lines are not
// pickable on Navara yet (trails never take a click; see phase 3 Task 4).

import { MeshDesc } from '@navaramap/three';
import { createLineRegistry, densifyGeodesic } from '../../lines.js';
import { createLineMesh } from './lineMesh.js';

const DESC_NAME = 'gevLine';
const registered = new WeakSet();

class GevLineDesc extends MeshDesc {
  constructor(view, ctx, config) {
    super(view, ctx, config);
    this.gev = config[DESC_NAME];
  }

  getPassKey() {
    return 'transparent';
  }

  createMesh() {
    return this.gev.line.group;
  }

  update() {
    const canvas = this.ctx.getRenderer().domElement;
    this.gev.line.update(canvas.clientWidth, canvas.clientHeight);
  }

  onDestroy() {
    this.gev.line.dispose();
    super.onDestroy();
  }
}

/**
 * @param {object} view an initialised Navara ThreeView
 * @returns {{ lines: import('../../contract.js').GlobeLines, destroy: () => void }}
 */
export function createNavaraLines(view) {
  if (!registered.has(view)) {
    view.registerMesh(DESC_NAME, GevLineDesc);
    registered.add(view);
  }
  const request = () => view.forceUpdate();
  // What CPU picks need of each line: its drawn positions and matrix.
  const drawn = new Map();
  const registry = createLineRegistry((options) => {
    const line = createLineMesh(options);
    const state = {
      options,
      flat: new Float64Array(0),
      modelMatrix: options.modelMatrix,
      shown: true,
    };
    drawn.set(options.id, state);
    const canvas = view.canvas;
    if (canvas) line.update(canvas.clientWidth || 1, canvas.clientHeight || 1);
    const handle = view.addMesh({ lit: false, [DESC_NAME]: { line } });
    return {
      setPositions(flat) {
        state.flat = options.arc === 'geodesic' ? densifyGeodesic(flat) : flat;
        line.setPositions(state.flat);
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
        handle.delete();
        request();
      },
    };
  });
  return {
    lines: registry.lines,
    /** Shown lines with a pickId: options, drawn positions, matrix. */
    pickables: () =>
      [...drawn.values()].filter(
        (state) => state.shown && state.options.pickId !== undefined,
      ),
    destroy: () => registry.destroyAll(),
  };
}
