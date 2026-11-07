// Display cases run on both engines. Cesium uses real imagery layers and a
// headless camera; only GPU shell drawing and provider requests are faked.
import nodeTest from 'node:test';
import * as Cesium from 'cesium';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { normalizeImageryLayerOptions } from '../globe/imagery.js';
import { createCesiumMoversEngine } from './cesiumMoversEngine.mjs';

function createCesiumImageryEngine() {
  let renderRequests = 0;
  let pending = false;
  let frame;
  const {
    engine,
    viewer,
    frame: draw,
  } = createCesiumMoversEngine({
    engineOptions: {
      requestRender() {
        renderRequests++;
        if (pending) return;
        pending = true;
        queueMicrotask(() => {
          pending = false;
          if (!engine.isDestroyed()) frame();
        });
      },
      imageryFactories: {
        tiles(options) {
          const tilingScheme =
            options.tilingScheme ?? new Cesium.WebMercatorTilingScheme();
          return {
            tilingScheme,
            rectangle: options.rectangle ?? tilingScheme.rectangle,
            tileWidth: 256,
            tileHeight: 256,
            minimumLevel: 0,
            maximumLevel: 18,
            errorEvent: new Cesium.Event(),
            requestImage: () => undefined,
          };
        },
        shell(options) {
          let detail = null;
          return {
            rectangle: options.rectangle,
            setImage() {},
            setAlpha() {},
            setShow() {},
            setDetail: (image) => {
              detail = image;
            },
            detail: () => detail,
            drawn: () => true,
            destroy() {},
          };
        },
      },
    },
  });
  frame = draw;
  viewer.scene.globe.show = true;
  viewer.scene.globe.tilesLoaded = true;
  viewer.imageryLayers = new Cesium.ImageryLayerCollection();
  const layers = new Map();
  const create = engine.imagery.createLayer;
  engine.imagery.createLayer = (options) => {
    const layer = create(options);
    layers.set(layer.id, {
      layer,
      options: normalizeImageryLayerOptions(options),
    });
    return layer;
  };
  engine.fake = {
    get renderRequests() {
      return renderRequests;
    },
    script(method, value) {
      engine.camera[method] = typeof value === 'function' ? value : () => value;
    },
    emit(name) {
      if (name === 'frames.preRender') frame();
      else throw new Error(`Unsupported event ${name}`);
    },
    frames(count) {
      for (let i = 0; i < count; i++) frame();
    },
    imageryLayers: () => engine.imagery.list().map(({ id }) => id),
    imageryLayer(id) {
      const record = layers.get(id);
      if (!record || record.layer.isDestroyed()) return undefined;
      const { layer, options } = record;
      return {
        options,
        source: layer.source(),
        alpha: layer.alpha(),
        shown: layer.shown(),
        split: layer.split(),
        raise: layer.raise(),
        detail: layer.detail(),
        staging: layer.staging(),
      };
    },
  };
  return engine;
}

/** Each test owns its engines and releases them even after an assertion fails. */
export function imageryDisplayTests() {
  let make;
  let engines;
  return {
    test(name, run) {
      for (const factory of [createFakeEngine, createCesiumImageryEngine])
        nodeTest(
          `${name} (${factory === createFakeEngine ? 'fake' : 'cesium'})`,
          async (t) => {
            make = factory;
            engines = [];
            if (!globalThis.document) {
              globalThis.document = {
                createElement: () => ({
                  getContext: () => ({
                    createImageData: (w, h) => ({
                      data: new Uint8ClampedArray(w * h * 4),
                    }),
                    putImageData() {},
                  }),
                }),
              };
              t.after(() => {
                delete globalThis.document;
              });
            }
            try {
              await run(t);
            } finally {
              for (const engine of engines) engine.destroy();
            }
          },
        );
    },
    createEngine(options) {
      const engine = make(options);
      engines.push(engine);
      return engine;
    },
  };
}
