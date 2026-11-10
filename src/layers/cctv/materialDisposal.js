/** Native Entity visualizers own their primitives, but Cesium's static material
 * batch removes a primitive without destroying its Material. Collect only CCTV
 * image materials, then release their textures AFTER the visualizer detaches
 * them. Public primitive/appearance APIs avoid patching SDK internals. */
function sceneMaterials(scene) {
  const materials = new Set();
  const visited = new Set();
  function visit(primitive) {
    if (!primitive || visited.has(primitive) || primitive.isDestroyed?.())
      return;
    visited.add(primitive);
    if (primitive.appearance?.material)
      materials.add(primitive.appearance.material);
    if (primitive.depthFailAppearance?.material)
      materials.add(primitive.depthFailAppearance.material);
    if (
      typeof primitive.get === 'function' &&
      Number.isInteger(primitive.length) &&
      typeof primitive.destroyPrimitives === 'boolean'
    ) {
      // PrimitiveCollection's public ownership flag distinguishes nested scene
      // primitives from BillboardCollection/PointPrimitiveCollection. Never
      // walk thousands of contact sprites to retire one camera material.
      for (let i = 0; i < primitive.length; i++) visit(primitive.get(i));
    }
  }
  visit(scene.primitives);
  return materials;
}

export function createProjectionMaterialDisposal(getScene) {
  const owned = new Set();
  const sources = new Map();
  let stop = null;
  let wakeFrames = 0;
  let dirty = true;
  const imagesFor = (runtime) =>
    new Set(
      [runtime.canvas, runtime.video, ...(runtime.buffers || [])].filter(
        Boolean,
      ),
    );

  function capture(used) {
    const images = new Set();
    for (const [runtime, source] of sources) {
      if (!source.retired) source.images = imagesFor(runtime);
      for (const image of source.images) images.add(image);
    }
    for (const material of used) {
      if (images.has(material.uniforms?.image)) owned.add(material);
    }
  }
  function flush(scene) {
    const used = sceneMaterials(scene);
    capture(used);
    for (const material of owned) {
      if (material.isDestroyed?.()) owned.delete(material);
      else if (!used.has(material)) {
        material.destroy();
        owned.delete(material);
      }
    }
    for (const [runtime, source] of sources) {
      if (
        source.retired &&
        ![...used].some((material) =>
          source.images.has(material.uniforms?.image),
        )
      )
        sources.delete(runtime);
    }
    if (!sources.size && !owned.size) {
      stop?.();
      stop = null;
    } else if (wakeFrames-- > 0) scene.requestRender?.();
  }
  function observe(scene) {
    dirty = true;
    if (stop || !scene.postRender?.addEventListener) return;
    const collection = scene.primitives;
    const events = [collection.primitiveAdded, collection.primitiveRemoved];
    const observable = events.every((event) => event?.addEventListener);
    const removers = observable
      ? events.map((event) =>
          event.addEventListener(() => {
            dirty = true;
          }),
        )
      : [];
    removers.push(
      scene.postRender.addEventListener(() => {
        // Entity image batches live in this collection. Reuse the ownership
        // result between native batch changes instead of scanning every frame.
        if (!observable || dirty || wakeFrames > 0) {
          dirty = false;
          flush(scene);
        }
      }),
    );
    stop = () => removers.forEach((remove) => remove());
  }
  return {
    watch(runtime) {
      const scene = getScene();
      if (!scene?.primitives || scene.isDestroyed?.()) return;
      sources.set(runtime, { images: imagesFor(runtime), retired: false });
      // A uniform change can replace a native batch even while its camera is
      // active. Observe each rendered frame so those earlier materials are
      // released too. This listener never starts a continuous render loop.
      observe(scene);
    },
    retire(runtime) {
      const scene = getScene();
      if (!scene?.primitives || scene.isDestroyed?.()) return;
      sources.set(runtime, { images: imagesFor(runtime), retired: true });
      capture(sceneMaterials(scene));
      wakeFrames = 3;
      observe(scene);
      scene.requestRender?.();
    },
    // Full viewer teardown also frees its context. Do not leave a subscription
    // from a retained layer module holding that old scene after destruction.
    destroy() {
      const scene = getScene();
      if (scene && !scene.isDestroyed?.()) flush(scene);
      stop?.();
      stop = null;
      owned.clear();
      sources.clear();
    },
  };
}
