// Fleet models for a layer test (fleetModelInstances.js): the project's model
// set loaded from public/, a DISPLAY 3D toggle that is on, and Cesium's glTF
// loader replaced by one that answers at once with a ready model, recorded.
import * as Cesium from 'cesium';
import { loadFleetModelSet } from '../data/fleetModels.js';
import { fetchPublicFile } from './fleetGlb.mjs';

/** A model policy whose eligibility is read again on every frame. */
export const FLEET_TEST_POLICY = Object.freeze({
  altitudeCeilingM: 800_000,
  minimumPixelSize: 16,
  cap: 4,
  capAll: 8,
  addM: 5_000,
  addAllM: 20_000,
  keepM: 6_000,
  keepAllM: 24_000,
  intervalMs: 0,
});

/**
 * Load the fleet set (once a process, as the app does) and fake the loader
 * for this test. Call it before the layer's harness, which replaces `fetch`.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{fleet: object, created: object[],
 *   drawn: (id: string) => object[]}>} `fleet` for the layer's services;
 *   `drawn(id)` the models drawn for the vehicle `id` now.
 */
export async function fleetModelFakes(t) {
  const info = console.info;
  console.info = () => {};
  try {
    await loadFleetModelSet({ fetchImpl: fetchPublicFile });
  } finally {
    console.info = info;
  }
  const created = [];
  t.mock.method(Cesium.Model, 'fromGltfAsync', async (options) => {
    const model = {
      ...options,
      ready: true,
      show: false,
      modelMatrix: new Cesium.Matrix4(),
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      isDestroyed() {
        return this.destroyed;
      },
      update() {},
    };
    created.push(model);
    return model;
  });
  return {
    fleet: {
      policy: FLEET_TEST_POLICY,
      display: () => ({ models3d: true, models3dMode: 'proximity' }),
      resolveAsset: (url) => url,
    },
    created,
    drawn: (id) =>
      created.filter(
        (model) => model.id === id && !model.destroyed && model.show,
      ),
  };
}
