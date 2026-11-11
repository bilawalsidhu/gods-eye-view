// The earthquake discs on the globe contract (engine.ground), the same on
// every engine: one ground disc per event, of its radius in metres, filled
// in its depth colour at its alpha, picked as `earthquake:${stableId}`. No
// outline: Cesium draws none on a ground-clamped ellipse, so none showed
// on either engine.

const SET_ID = 'earthquakes';

/** What a pick of an earthquake disc returns. */
export const earthquakePickId = (disc) => `earthquake:${disc.stableId}`;

/**
 * The earthquake discs: `{ setVisible, replace(discs), destroy }`. A disc is
 * `{ stableId, lon, lat, baseRadius, color (Rgba), fillAlpha }`; later discs
 * draw on top.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 */
export function createEarthquakesDisplay(engine) {
  const set = engine.ground.createSet({
    id: SET_ID,
    kind: 'disc',
    pickable: true,
  });
  set.show(false);
  let destroyed = false;
  return {
    setVisible(show) {
      if (!destroyed) set.show(show !== false);
    },
    replace(discs) {
      if (destroyed) return;
      set.replace(
        discs.map((disc) => ({
          center: [disc.lon, disc.lat],
          radiusM: disc.baseRadius,
          fill: disc.color.withAlpha(disc.fillAlpha).rgba(),
          pickId: earthquakePickId(disc),
        })),
      );
      set.commit();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      set.destroy();
    },
  };
}
