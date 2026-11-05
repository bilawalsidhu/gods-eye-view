import { Texture, LinearFilter } from 'three';
import { createImageryGround } from '../../recentImagery/render/navaraGround.js';
import { drawStorySource } from '../../shared/render/navaraStory.js';

export function createNepalEventDisplay(engine, native) {
  const owner = { slots: { a: null, b: null }, preview: null, split: 0.5 };
  const ground = createImageryGround(engine, native, owner, 'gevNepalEvent');
  let disposed = false;
  function clear() {
    for (const id of ['a', 'b']) {
      owner.slots[id]?.atlas.texture.dispose();
      owner.slots[id] = null;
    }
    if (!disposed) ground.sync();
  }
  return {
    draw: (data) => drawStorySource(engine, native, data),
    async loadImages(box, providers) {
      const images = await Promise.all(
        providers.map((p) => p.requestImage(0, 0, 0)),
      );
      if (disposed) return;
      clear();
      for (const [i, id] of ['a', 'b'].entries()) {
        const texture = new Texture(images[i]);
        texture.flipY = false;
        texture.minFilter = texture.magFilter = LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        owner.slots[id] = {
          atlas: {
            texture,
            plan: {
              geographic: true,
              bounds: [
                box.west,
                box.north,
                box.east - box.west,
                box.south - box.north,
              ],
            },
          },
          box,
          alpha: 0.96,
          split: i === 0 ? 'left' : 'right',
        };
      }
      ground.sync();
      engine.render.request('nepal-imagery');
    },
    setVisible(show) {
      for (const slot of Object.values(owner.slots))
        if (slot) slot.alpha = show ? 0.96 : 0;
      engine.render.request('nepal-imagery');
    },
    setSplit(x) {
      owner.split = x;
      engine.render.request('nepal-split');
    },
    clear,
    destroy() {
      disposed = true;
      clear();
      ground.destroy();
    },
  };
}
