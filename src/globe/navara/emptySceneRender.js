import { Scene } from 'three';

export function hasGeometry(scene) {
  let found = false;
  scene.traverseVisible((object) => {
    if (object.isMesh || object.isLine || object.isPoints || object.isSprite)
      found = true;
  });
  return found;
}

// Navara renders its MRT and forward scenes even when they contain only lights.
// Three resolves the current MSAA target on every render(), including no draws.
// Scope the override to this pass; retain clears, backgrounds and callbacks.
export function skipEmptySceneRenders(render, scenes) {
  return function (renderer, ...args) {
    const original = renderer.render;
    const clear = renderer.clear;
    const pendingClears = new Set();
    if (clear)
      renderer.clear = function (...args) {
        pendingClears.add(this.getRenderTarget());
        return clear.apply(this, args);
      };
    renderer.render = function (scene, ...args) {
      const shadow = this.shadowMap;
      const target = this.getRenderTarget?.();
      if (
        (scene === scenes.mrt || scene === scenes.opaque) &&
        !this.autoClear &&
        !pendingClears.has(target) &&
        !(shadow?.enabled && (shadow.autoUpdate || shadow.needsUpdate)) &&
        scene.background === null &&
        scene.onBeforeRender === Scene.prototype.onBeforeRender &&
        scene.onAfterRender === Scene.prototype.onAfterRender &&
        !hasGeometry(scene)
      )
        return;
      const result = original.call(this, scene, ...args);
      pendingClears.delete(target);
      return result;
    };
    try {
      return render.call(this, renderer, ...args);
    } finally {
      renderer.render = original;
      if (clear) renderer.clear = clear;
    }
  };
}
