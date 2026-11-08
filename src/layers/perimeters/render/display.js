// The fire perimeters on the globe contract (engine.ground, engine.input),
// the same on every engine: each row's polygons (holes kept) as a 0.25
// fill in its containment colour, under a 2 px ground outline at 0.9 along
// the outer ring only, every polygon and its outline picked as
// `fire-perimeter:${stableId}:${index}`. All fills come before all outlines
// in the set, so an outline is never covered by a later fill (on Cesium the
// outlines are one batch over the fills).

import { rgbaFromCss } from '../../shared/color.js';
import { containmentAccent } from '../cards.js';

const SET_ID = 'fire-perimeters';
const FILL_ALPHA = 0.25;
const OUTLINE_ALPHA = 0.9;
const OUTLINE_PX = 2;

/** What a pick of a perimeter's polygon returns. */
export const perimeterPickId = (row, index) =>
  `fire-perimeter:${row.stableId}:${index}`;

/**
 * The perimeters: `{ setVisible, replace(rows), onClick(listener) → remove,
 * destroy }`. A click listener receives the engine's pick.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 */
export function createPerimetersDisplay(engine) {
  const set = engine.ground.createSet({
    id: SET_ID,
    kind: 'polygon',
    pickable: true,
  });
  set.show(false);
  let destroyed = false;
  const removers = new Set();
  return {
    setVisible(show) {
      if (!destroyed) set.show(show);
    },
    replace(rows) {
      if (destroyed) return;
      const fills = [];
      const outlines = [];
      for (const row of rows) {
        const { red, green, blue } = rgbaFromCss(
          containmentAccent(row.containedPct),
        );
        for (const [index, rings] of row.polygons.entries()) {
          const pickId = perimeterPickId(row, index);
          fills.push({ rings, fill: [red, green, blue, FILL_ALPHA], pickId });
          outlines.push({
            rings: rings.slice(0, 1),
            outline: {
              color: [red, green, blue, OUTLINE_ALPHA],
              widthPx: OUTLINE_PX,
            },
            pickId,
          });
        }
      }
      set.replace([...fills, ...outlines]);
      set.commit();
    },
    onClick(listener) {
      if (destroyed) return () => {};
      const remove = engine.input.on('click', listener, { pick: true });
      const off = () => {
        if (removers.delete(off)) remove();
      };
      removers.add(off);
      return off;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of [...removers]) off();
      set.destroy();
    },
  };
}
