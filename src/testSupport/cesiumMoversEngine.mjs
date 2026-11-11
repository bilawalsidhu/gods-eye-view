import { installDomClasses } from './domClasses.mjs';
// The Cesium engine over a real Cesium camera on a stub scene
// (globe/cesium/testing/cameraViewer.mjs), set up for layers that draw
// through engine.movers, engine.lines and the follow: Cesium's own
// collections, billboards and polylines hold what the engine writes (they
// draw nothing); the atlas crop and the glTF load are faked (`loads` holds
// each fake Model, `ready` false until a test sets it); the viewer has the
// entities the follow's proxy goes in.

import * as Cesium from 'cesium';
import { createCameraViewer } from '../globe/cesium/testing/cameraViewer.mjs';

// Cesium's Material sorts uniform values with instanceof checks against these
// DOM classes; Node has none of them.
installDomClasses();

const items = (collection) =>
  Array.from({ length: collection.length }, (_, index) =>
    collection.get(index),
  );

// What the Cesium engine reads and writes of a Model: its own model matrix
// (kept as given), a colour it copies.
function fakeModel(options) {
  let color;
  return {
    options,
    ready: false,
    show: true,
    modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
    get color() {
      return color;
    },
    set color(value) {
      color = Cesium.Color.clone(value);
    },
    isDestroyed: () => false,
    destroy() {
      this.destroyed = true;
    },
  };
}

/**
 * @param {{ engineOptions?: object }} [options] More createCesiumEngine
 *   options (an input handler seam, say).
 * @returns {{ viewer: object, engine: object, frame: () => void,
 *   loads: object[], primitive: (id: string) => (object | undefined) }}
 *   `primitive(id)`: the Cesium primitive drawing a mover set or line.
 */
export function createCesiumMoversEngine({ engineOptions = {} } = {}) {
  const loads = [];
  const { viewer, engine, frame } = createCameraViewer({
    engineOptions: {
      ...engineOptions,
      moverFactories: {
        cropCells: async (atlas, keys) =>
          new Map(keys.map((key) => [key, { width: 8, height: 8, key }])),
        loadModel: async (options) => {
          const model = fakeModel(options);
          loads.push(model);
          return model;
        },
      },
    },
  });
  viewer.entities = new Cesium.EntityCollection();
  const primitive = (id) => {
    for (const root of items(viewer.scene.primitives))
      for (const child of items(root)) {
        if (child.gevMoverSet === id || child.gevMesh === id) return child;
        if (child instanceof Cesium.PrimitiveCollection)
          for (const inner of items(child))
            if (inner.gevLine === id) return inner;
      }
    return undefined;
  };
  return { viewer, engine, frame, loads, primitive };
}
