// Fleet models for a layer test (fleetModelInstances.js): the project's model
// set loaded from public/, a DISPLAY 3D toggle that is on, and the layer's
// draw port (testSupport/fakeDrawPort.mjs) answering each model's load.
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
 * Load the fleet set (once a process, as the app does). Call it before the
 * layer's harness, which replaces `fetch`; then `watch` the harness's draw
 * port.
 * @returns {Promise<{fleet: object, watch: (draw: object) => void,
 *   load: () => void, drawn: (id: string) => object[]}>} `fleet` for the
 *   layer's services; `load()` finishes the load of every model the layer
 *   has asked for, as the renderer does off the frame; `drawn(id)` the
 *   models drawn for the vehicle `id` now.
 */
export async function fleetModelFakes() {
  const info = console.info;
  console.info = () => {};
  try {
    await loadFleetModelSet({ fetchImpl: fetchPublicFile });
  } finally {
    console.info = info;
  }
  let draw = null;
  const sets = () =>
    draw
      ? [...draw.sets.values()].filter(
          (set) =>
            !set.disposed &&
            set.kind === 'models' &&
            set.spec.id.startsWith('fleet-models:'),
        )
      : [];
  return {
    fleet: {
      policy: FLEET_TEST_POLICY,
      display: () => ({ models3d: true, models3dMode: 'proximity' }),
      resolveAsset: (url) => url,
    },
    watch(port) {
      draw = port;
    },
    load() {
      for (const set of sets())
        for (const id of [...set.items.keys()]) draw.ready(set.spec.id, id);
    },
    drawn: (id) =>
      sets().flatMap((set) => {
        const item = set.items.get(id);
        return item && item.show !== false && set.show ? [item] : [];
      }),
  };
}
