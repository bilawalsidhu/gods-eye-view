// A prototype fire-perimeter renderer on engine.ground, for every engine:
// each row's polygons (holes kept) as a 0.25 fill under a 2 px outline at
// 0.9 in its containment colour, as the zones draw on Cesium, picked as
// `fire-perimeter:${stableId}:${index}`. Not wired into the layer:
// scripts/qa-ground-prototypes.mjs draws it next to cesium.js to compare.
import { rgbaFromCss } from '../../shared/color.js';
import { containmentAccent } from '../cards.js';

export function createPerimetersGroundRenderer(engine) {
  const set = engine.ground.createSet({
    id: 'fire-perimeters',
    kind: 'polygon',
    pickable: true,
  });
  set.show(false);
  return {
    setVisible(show) {
      set.show(show);
    },
    replace(rows) {
      const items = [];
      for (const row of rows) {
        const { red, green, blue } = rgbaFromCss(
          containmentAccent(row.containedPct),
        );
        for (const [index, rings] of row.polygons.entries())
          items.push({
            rings,
            fill: [red, green, blue, 0.25],
            outline: { color: [red, green, blue, 0.9], widthPx: 2 },
            pickId: `fire-perimeter:${row.stableId}:${index}`,
          });
      }
      set.replace(items);
      set.commit();
    },
    pick(event) {
      return event.picked?.owner === 'fire-perimeters'
        ? { id: event.picked.id }
        : null;
    },
    destroy() {
      set.destroy();
    },
  };
}
