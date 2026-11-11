/** A deterministic atlas without browser image decoding. */
export const testMarkerAtlas = (images) => ({
  canvas: { width: images.length, height: 1 },
  cells: Object.fromEntries(
    images.map((_, index) => [
      String(index),
      [index / images.length, 0, (index + 1) / images.length, 1],
    ]),
  ),
});

/** Read the contract instances, in their draw order. */
export function markerRows(engine, prefix) {
  return engine.movers
    .list()
    .filter(({ id }) => id.startsWith(prefix))
    .flatMap(({ id }) => {
      const { store, options } = engine.fake.moverSet(id);
      return Array.from({ length: store.count }, (_, index) => ({
        id: store.pickIds[index],
        show: store.shows[index] === 1,
        width:
          store.scales[index] *
          (options.sprite?.sizePx || options.point?.sizePx),
        position: {
          x: store.positions[index * 3],
          y: store.positions[index * 3 + 1],
          z: store.positions[index * 3 + 2],
        },
      }));
    });
}
