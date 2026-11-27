import { registerHooks } from 'node:module';
import { Event } from 'cesium';
export * from 'cesium';

globalThis.document ??= { createElement: () => ({}) };
export class CesiumWidget {
  constructor(container) {
    container.widget = this;
    this.tilesLoadedOnFirstFrame = container.tilesLoadedOnFirstFrame;
    this.useDefaultRenderLoop = true;
    this.renders = 0;
    this.destroyed = false;
    const preRender = new Event();
    const tileLoadProgressEvent = new Event();
    this.scene = {
      preRender,
      postRender: new Event(),
      requestRender() {},
      globe: { tilesLoaded: true, tileLoadProgressEvent },
      imageryLayers: { addImageryProvider: () => ({}) },
      screenSpaceCameraController: {},
      camera: { frustum: {} },
      fog: {},
    };
    this.camera = { lookAt() {}, setView() {} };
    this.entities = {
      values: [],
      add(entity) {
        this.values.push(entity);
        return entity;
      },
      removeAll() {
        this.values.length = 0;
      },
    };
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
  resize() {}
  render() {
    this.renders++;
    this.scene.preRender.raiseEvent(this.scene);
    // The first frame queues imagery for the camera view after preRender.
    if (this.renders === 1)
      this.scene.globe.tilesLoaded = this.tilesLoadedOnFirstFrame;
    this.scene.postRender.raiseEvent(this.scene);
  }
  /** One requestAnimationFrame tick of CesiumWidget's default loop. */
  tick() {
    if (!this.destroyed && this.useDefaultRenderLoop) this.render();
  }
}

export const TileMapServiceImageryProvider = { fromUrl: async () => ({}) };
export const buildModuleUrl = () => '';

const renderer = new URL('../render/cesium/cardPreviews.js', import.meta.url)
  .href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cesium' && context.parentURL === renderer)
      return { url: import.meta.url, shortCircuit: true };
    return next(specifier, context);
  },
});
export const from = { code: '', lat: 51.47, lon: -0.45 };
export const to = { code: '', lat: 40.64, lon: -73.78 };

export async function pausedRoute({ tilesLoaded = true } = {}) {
  globalThis.matchMedia = () => ({ matches: true });
  const { cesiumCardPreviews } = await import(renderer);
  const container = { tilesLoadedOnFirstFrame: tilesLoaded };
  const preview = cesiumCardPreviews.route(container, {
    from,
    to,
    at: { lat: 52, lon: -20 },
  });
  const { widget } = container;
  preview.setActive(false);
  await new Promise((r) => setImmediate(r));
  widget.tick();
  return { preview, widget };
}
