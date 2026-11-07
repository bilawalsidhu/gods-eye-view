// The Bhote Koshi flood event and its locator on the globe contract, the
// same on every engine. The event's before and after imagery are two
// engine.imagery layers of the event's image URLs over one rectangle, at
// alpha 0.96, the before image left of the engine's split position and the
// after image right of it. The story graphics (the flood corridor, the
// surge front, the locator's border, path and rings) are Cesium entities
// the layers sample (src/data/bhoteKoshiEvent.js, bhoteKoshiLocator.js):
// Cesium draws them itself; another engine draws them through its
// story backend (`drawStory`, src/layers/shared/render/navaraStory.js on
// Navara), which the manifest passes in.

const IMAGERY_ALPHA = 0.96;
// Over Recent Imagery (10), under the weather (20 and up).
const IMAGERY_ORDER = 15;
const SIDES = ['left', 'right'];
// What a layer draws until its image is in.
const EMPTY_IMAGE = Object.freeze({
  width: 1,
  height: 1,
  data: new Uint8Array(4),
});
let events = 0;

/**
 * The event layer's renderer (bhoteKoshiEvent.js `createNativeRenderer`).
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ drawStory?: (engine: object, dataSource: object) => { destroy: () => void } }} [options]
 */
export function createBhoteKoshiDisplay(engine, { drawStory = null } = {}) {
  if (!engine?.imagery)
    throw new TypeError('The Bhote Koshi display needs a globe engine');
  const id = `bhote-koshi-imagery-${++events}`;
  let layers = [];
  let visible = true;
  let loads = 0;
  let destroyed = false;
  function clear() {
    for (const layer of layers) layer.destroy();
    layers = [];
    loads++;
    engine.render.request('nepal-imagery');
  }
  return {
    /** The story's entities through the engine's backend, or null: the
     * layer adds them to Cesium. */
    draw: (dataSource) => drawStory?.(engine, dataSource) ?? null,
    /**
     * The before and after images over `box` (degrees); resolves once both
     * draw, rejects when one would not load (unless replaced or cleared
     * first).
     */
    async loadImages(box, urls, credit = null) {
      if (destroyed) return;
      clear();
      const load = loads;
      const rectangle = {
        west: box.west,
        south: box.south,
        east: box.east,
        north: box.north,
      };
      // Each layer stages its image over an empty one, which tells whether
      // the image loaded.
      layers = urls.map((_url, index) =>
        engine.imagery.createLayer({
          id: `${id}-${SIDES[index]}`,
          order: IMAGERY_ORDER,
          alpha: IMAGERY_ALPHA,
          show: visible,
          split: SIDES[index],
          source: { kind: 'image', image: EMPTY_IMAGE, rectangle },
        }),
      );
      const loaded = await Promise.all(
        layers.map((layer, index) =>
          layer.setSource(
            {
              kind: 'image',
              url: urls[index],
              rectangle,
              ...(credit ? { credit } : {}),
            },
            { staged: true },
          ),
        ),
      );
      engine.render.request('nepal-imagery');
      if (load === loads && !loaded.every(Boolean))
        throw new Error('Bhote Koshi imagery unavailable');
    },
    setVisible(show) {
      visible = Boolean(show);
      for (const layer of layers) layer.show(visible);
      engine.render.request('nepal-imagery');
    },
    /** Where the swipe runs, a fraction of the canvas width from the left. */
    setSplit(fraction) {
      if (Number.isFinite(fraction))
        engine.imagery.setSplitPosition(Math.max(0, Math.min(1, fraction)));
      engine.render.request('nepal-split');
    },
    clear,
    destroy() {
      destroyed = true;
      clear();
    },
  };
}

/**
 * The locator layer's renderer (bhoteKoshiLocator.js `createNativeRenderer`):
 * its story source through the engine's backend; null where Cesium
 * draws it.
 */
export function createBhoteKoshiLocatorDisplay(
  engine,
  { data, drawStory = null } = {},
) {
  return drawStory ? drawStory(engine, data) : null;
}
