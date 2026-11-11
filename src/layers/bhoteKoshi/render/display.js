// The story's imagery, ground graphics and points on the globe contract.
import { drawStorySource } from './story.js';

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
 */
export function createBhoteKoshiDisplay(engine) {
  const id = `bhote-koshi-imagery-${++events}`;
  let layers = [];
  const stories = new Set();
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
    draw(dataSource) {
      const story = drawStorySource(engine, dataSource);
      stories.add(story);
      return {
        destroy() {
          story.destroy();
          stories.delete(story);
        },
      };
    },
    /**
     * The before and after images over `box` (degrees), each a URL or an
     * image already decoded; resolves once both draw, rejects when one
     * would not load (unless replaced or cleared first).
     */
    async loadImages(box, images, credit = null) {
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
      layers = images.map((_image, index) =>
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
              ...(typeof images[index] === 'string'
                ? { url: images[index] }
                : { image: images[index] }),
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
      for (const story of stories) story.destroy();
      stories.clear();
      clear();
    },
  };
}

/** The locator's border, flood path and callouts on the same display. */
export function createBhoteKoshiLocatorDisplay(engine, { data } = {}) {
  return drawStorySource(engine, data);
}
