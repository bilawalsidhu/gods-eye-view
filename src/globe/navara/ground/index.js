// engine.ground on Navara: every shown set in one screen pass (pass.js),
// classified on the scene depth, so fills drape on terrain and 3D tiles
// alike. A commit packs the set's items once (pack.js), with the terrain
// heights under them that bound each item's screen box; a set packed before
// its terrain loaded is packed again a few times, further apart each time,
// until it has them (only the heights are sampled again). A show, hide or
// commit composes the shown sets in draw order (set order, then creation)
// and asks for one frame; while a shown set has a pulse or a dash, every
// frame asks for the next, the continuous render Cesium drew them with (the
// pass reads the time each frame). Picks are CPU picks at the globe under
// the pointer (src/globe/ground.js), wired by the engine.

import { createGroundRegistry } from '../../ground.js';
import { composeGround, packHeights, packSet } from './pack.js';
import { REVEAL_OFFSET, ITEM_TEXELS } from './corridors.js';

// Frames before the first new try at a set's missing terrain heights; each
// later try waits twice as long, up to RETRIES tries.
const RETRY_FRAMES = 30;
const RETRIES = 6;

/**
 * @param {object} view an initialised Navara ThreeView
 * @param {{ createPass: (view: object) => ReturnType<typeof import('./pass.js').createGroundPass>,
 *   nextFrame?: (run: () => void) => void }} options
 *   `createPass` makes the pass (pass.js createGroundPass; the view's three
 *   runtime, which Node tests replace); `nextFrame` runs a callback before
 *   the next display frame (requestAnimationFrame).
 * Navara clears its update request once a frame is drawn, so one made
 * while the frame is drawn (in postRender) is asked again from the next
 * display frame.
 * @returns {{ ground: import('../../contract.js').GlobeGround,
 *   pickables: () => object[], diagnostics: () => object, destroy: () => void }}
 */
export function createNavaraGround(
  view,
  {
    createPass,
    pulseField,
    nextFrame = (run) =>
      globalThis.requestAnimationFrame
        ? globalThis.requestAnimationFrame(run)
        : setTimeout(run, 16),
  },
) {
  const pass = createPass(view);
  let destroyed = false;
  let asked = false;
  const askNextFrame = () => {
    if (asked) return;
    asked = true;
    nextFrame(() => {
      asked = false;
      if (!destroyed) view.forceUpdate();
    });
  };
  const entries = new Set();
  const terrainHeight = (lon, lat) => {
    const height = view.sampleTerrainHeight?.({ lat, lng: lon });
    return Number.isFinite(height) ? height : undefined;
  };
  const pack = (entry) => {
    entry.pack = packSet(entry.options.kind, entry.items, { terrainHeight });
    entry.pack.drape = entry.options.drape;
    for (
      let at = REVEAL_OFFSET;
      at < entry.pack.items.length;
      at += ITEM_TEXELS * 4
    )
      entry.pack.items[at] = entry.fraction;
    entry.wait = entry.pack.heights.some(Number.isNaN) ? RETRY_FRAMES : 0;
  };
  const sampleAgain = (entry) => {
    entry.pack.heights = packHeights(entry.pack, { terrainHeight });
    entry.wait = entry.pack.heights.some(Number.isNaN) ? RETRY_FRAMES : 0;
  };
  const compose = () => {
    const drawn = [...entries]
      .filter((entry) => entry.shown && entry.pack?.count)
      .sort((a, b) => a.options.order - b.options.order);
    for (const entry of entries) entry.offset = null;
    let offset = 0;
    for (const entry of drawn) {
      entry.offset = offset;
      offset += entry.pack.items.length;
    }
    pass.set(
      drawn.length ? composeGround(drawn.map(({ pack }) => pack)) : null,
    );
    view.forceUpdate();
  };
  const retry = () => {
    let changed = false;
    for (const entry of entries) {
      if (!entry.wait || !entry.shown || --entry.wait > 0) continue;
      const tries = entry.tries + 1;
      sampleAgain(entry);
      entry.tries = tries;
      if (entry.wait)
        entry.wait = tries < RETRIES ? RETRY_FRAMES * 2 ** tries : 0;
      changed = true;
    }
    if (changed) compose();
    if (changed || registry.animating()) askNextFrame();
  };
  view.on('postRender', retry);
  const build = (options) => {
    const entry = {
      options,
      shown: true,
      fraction: 1,
      offset: null,
      items: [],
      pack: null,
      tries: 0,
      wait: 0,
    };
    entries.add(entry);
    return {
      commit(items) {
        entry.items = items;
        entry.tries = 0;
        pack(entry);
        compose();
      },
      reveal(fraction) {
        if (entry.fraction === fraction) return;
        entry.fraction = fraction;
        if (entry.pack) {
          for (
            let at = REVEAL_OFFSET;
            at < entry.pack.items.length;
            at += ITEM_TEXELS * 4
          )
            entry.pack.items[at] = fraction;
          if (entry.offset !== null)
            pass.reveal(
              entry.offset,
              entry.pack.items.length / (ITEM_TEXELS * 4),
              fraction,
            );
        }
        view.forceUpdate();
      },
      show(visible) {
        if (entry.shown === visible) return;
        entry.shown = visible;
        compose();
      },
      destroy() {
        entries.delete(entry);
        // A set object still held keeps no packed data.
        entry.items = [];
        entry.pack = null;
        compose();
      },
    };
  };
  const registry = createGroundRegistry(build, { pulseField });
  return {
    ground: registry.ground,
    /** Every live set's state ({ options, items, shown }) for CPU picks. */
    pickables: () => [...registry.live.values()],
    /** Not contract: what the pass holds (QA measures it). */
    diagnostics: () => ({
      items: pass.owner.state?.count ?? 0,
      textureBytes: pass.textureBytes(),
    }),
    destroy() {
      destroyed = true;
      view.off('postRender', retry);
      registry.destroyAll();
      pass.destroy();
    },
  };
}
