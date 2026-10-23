import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  NightLightsOverlay,
  NIGHT_LIGHTS_ENTER_RATIO,
  NIGHT_LIGHTS_EXIT_RATIO,
  NIGHT_LIGHTS_FALLBACK_TEXTURE_URL,
  NIGHT_LIGHTS_FADE_START_RATIO,
  NIGHT_LIGHTS_FADE_DURATION_MS,
  NIGHT_LIGHTS_TWILIGHT_WIDTH,
  orderNightImagery,
  NIGHT_LIGHTS_TEXTURE_PRODUCT,
  NIGHT_LIGHTS_TEXTURE_URL,
  nightLightsFactor,
  nightLightsLampFactor,
  nightLightsOpacity,
  nightLightsTextureUv,
  shouldShowNightLights,
} from './nightLightsOverlay.js';

function transitionFixture(t) {
  const globals = ['window', 'requestAnimationFrame', 'cancelAnimationFrame'];
  let overlay;
  const previous = globals.map((key) => globalThis[key]);
  const frames = new Map();
  let frameId = 0;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
  };
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  t.after(() => {
    overlay?.destroy();
    globals.forEach((key, i) => {
      if (previous[i] === undefined) delete globalThis[key];
      else globalThis[key] = previous[i];
    });
  });
  t.mock.method(Cesium.SceneTransforms, 'worldToWindowCoordinates', () => ({
    x: 300,
    y: 150,
  }));
  const collection = new Cesium.ImageryLayerCollection();
  const base = collection.addImageryProvider(
    new Cesium.SingleTileImageryProvider({
      url: 'base.png',
      tileWidth: 2,
      tileHeight: 1,
    }),
  );
  let host = { kind: 'globe', collection };
  const camera = {
    positionWC: new Cesium.Cartesian3(
      1.2 * Cesium.Ellipsoid.WGS84.maximumRadius,
      0,
      0,
    ),
    directionWC: new Cesium.Cartesian3(-1, 0, 0),
    frustum: { fovy: Math.PI / 3, aspectRatio: 2 },
  };
  const viewer = {
    camera,
    scene: {
      canvas: { clientWidth: 600, clientHeight: 300 },
      postRender: new Cesium.Event(),
      requestRender() {},
    },
  };
  overlay = new NightLightsOverlay(viewer, { getHost: () => host });
  overlay._source = {};
  overlay.textureCanvas = { width: 2, height: 1 };
  function zoom(distance) {
    camera.positionWC.x = distance * Cesium.Ellipsoid.WGS84.maximumRadius;
    overlay.sync();
  }
  function finish() {
    overlay._stepFade(overlay._fadeStart + NIGHT_LIGHTS_FADE_DURATION_MS);
  }
  return {
    overlay,
    collection,
    base,
    frames,
    zoom,
    finish,
    rehome(value) {
      host = value;
      overlay.sync();
    },
  };
}

test('native night imagery stays below existing and newly enabled data', async (t) => {
  const { overlay, collection, base, zoom } = transitionFixture(t);
  const data = collection.addImageryProvider(
    new Cesium.SingleTileImageryProvider({
      url: 'data.png',
      tileWidth: 2,
      tileHeight: 1,
    }),
  );
  zoom(3);
  assert.equal(collection.get(0), base);
  assert.equal(collection.get(1), overlay.layer);
  assert.equal(collection.get(2), data);
  const newData = collection.addImageryProvider(data.imageryProvider, 1);
  assert.equal(collection.get(1), overlay.layer);
  assert.ok(collection.indexOf(newData) > collection.indexOf(overlay.layer));
  assert.equal(overlay.layer.name, 'gev-night-lights');
  const requested = overlay.layer.imageryProvider.requestImage(0, 0, 0);
  assert.equal(typeof requested.then, 'function');
  assert.equal(await requested, overlay.textureCanvas);
});

test('fast zoom-out fades in and fast zoom-in keeps live native geometry until fade ends', (t) => {
  const { overlay, zoom, finish } = transitionFixture(t);
  zoom(3);
  assert.equal(overlay.alpha, 0);
  assert.equal(overlay.targetAlpha, 1);
  overlay._stepFade(overlay._fadeStart + NIGHT_LIGHTS_FADE_DURATION_MS / 2);
  assert.ok(overlay.layer.alpha > 0 && overlay.layer.alpha < 1);
  finish();
  const layer = overlay.layer;
  zoom(1.5);
  assert.equal(overlay.visible, false);
  assert.equal(overlay.targetAlpha, 0);
  zoom(1.3);
  assert.equal(overlay.layer, layer);
  assert.equal(overlay.layer.show, true);
  finish();
  assert.equal(layer.show, false);
});

test('zoom reversal retains current alpha and restarts toward the new target', (t) => {
  const { overlay, zoom, finish } = transitionFixture(t);
  zoom(3);
  finish();
  zoom(1.5);
  const now = overlay._fadeStart + 120;
  overlay._stepFade(now);
  const alpha = overlay.alpha;
  overlay._setTarget(1, now);
  assert.equal(overlay.alpha, alpha);
  finish();
  assert.equal(overlay.layer.alpha, 1);
});

test('periodic sunlight refresh retains native imagery, opacity and ground atmosphere without a blank frame', (t) => {
  const { overlay, collection, zoom, finish } = transitionFixture(t);
  const ctx = {
    createImageData: () => ({ data: new Uint8ClampedArray(32) }),
    putImageData() {},
  };
  overlay.textureCanvas = { width: 4, height: 2, getContext: () => ctx };
  overlay._source = { data: new Uint8ClampedArray(32).fill(200) };
  overlay.sun = new Cesium.Cartesian3(1, 0, 0);
  overlay.viewer.scene.globe = { atmosphereLightIntensity: 10 };
  zoom(3);
  finish();
  const original = overlay.layer;
  let changes = 0;
  collection.layerAdded.addEventListener(() => changes++);
  collection.layerRemoved.addEventListener(() => changes++);
  for (let i = 0; i < 3; i++) {
    overlay.refreshTexture();
    assert.equal(overlay.layer, original);
    assert.equal(original.isDestroyed(), false);
    assert.equal(original.alpha, 1);
    assert.equal(original.show, true);
    assert.equal(overlay.viewer.scene.globe.atmosphereLightIntensity, 0);
  }
  assert.equal(changes, 0);
});

test('map source change transfers ownership to tileset collection and cleans the old layer', (t) => {
  const { overlay, collection, zoom, finish, rehome } = transitionFixture(t);
  zoom(3);
  finish();
  const old = overlay.layer;
  const tilesetCollection = new Cesium.ImageryLayerCollection();
  rehome({ kind: 'tileset', collection: tilesetCollection });
  assert.equal(collection.contains(old), false);
  assert.equal(old.isDestroyed(), true);
  assert.equal(tilesetCollection.get(0), overlay.layer);
  assert.equal(overlay.layer.imageryProvider.maximumLevel, 1);
  assert.equal(overlay.layer.alpha, 1);
  overlay.destroy();
  assert.equal(tilesetCollection.length, 0);
});

test('Display preference disables the effect through a fade and destroy cancels animation', (t) => {
  const { overlay, zoom, finish, frames } = transitionFixture(t);
  zoom(3);
  finish();
  overlay.setEnabled(false);
  assert.equal(overlay.isEnabled(), false);
  assert.equal(overlay.targetAlpha, 0);
  finish();
  assert.equal(overlay.layer.show, false);
  overlay.destroy();
  assert.equal(frames.size, 0);
  overlay.setEnabled(true);
  assert.equal(overlay.isEnabled(), false);
});

test('ground scattering follows the fade and restores on disable or disposal', (t) => {
  const { overlay, zoom, finish } = transitionFixture(t);
  const globe = { atmosphereLightIntensity: 10 };
  const atmosphere = { lightIntensity: 18 };
  overlay.viewer.scene.globe = globe;
  overlay.viewer.scene.atmosphere = atmosphere;
  zoom(3);
  finish();
  assert.equal(globe.atmosphereLightIntensity, 0);
  assert.equal(atmosphere.lightIntensity, 0);
  overlay.setEnabled(false);
  finish();
  assert.equal(globe.atmosphereLightIntensity, 10);
  assert.equal(atmosphere.lightIntensity, 18);
  overlay.setEnabled(true);
  finish();
  overlay.destroy();
  assert.equal(globe.atmosphereLightIntensity, 10);
  assert.equal(atmosphere.lightIntensity, 18);
});

test('tileset ordering leaves night below the first data layer', () => {
  const c = new Cesium.ImageryLayerCollection();
  const options = { url: 'texture.png', tileWidth: 2, tileHeight: 1 };
  const data = c.addImageryProvider(
    new Cesium.SingleTileImageryProvider(options),
  );
  const night = c.addImageryProvider(
    new Cesium.SingleTileImageryProvider(options),
  );
  orderNightImagery(c, night, 'tileset');
  assert.equal(c.get(0), night);
  assert.equal(c.get(1), data);
  c.destroy();
});

test('sunlight refresh performs no image readback, pixel processing or texture uploads', (t) => {
  const { overlay, rehome } = transitionFixture(t);
  rehome({ kind: 'none', collection: null });
  overlay.textureCanvas = {
    width: 8192,
    height: 4096,
    getContext() {
      throw new Error('Unexpected CPU image processing');
    },
  };
  overlay._source = true;
  let renders = 0;
  overlay.viewer.scene.requestRender = () => renders++;
  overlay.refreshTexture();
  assert.equal(renders, 1);
});

test('city lights have a doubled transition band entirely within night', () => {
  assert.equal(nightLightsLampFactor(1), 0);
  assert.equal(nightLightsLampFactor(0.1), 0);
  assert.equal(nightLightsLampFactor(0), 0);
  assert.equal(nightLightsLampFactor(-0.15), 0.5);
  assert.equal(nightLightsLampFactor(-0.3), 1);
  assert.equal(nightLightsLampFactor(-1), 1);
});

test('a late bundled image load cannot recreate imagery after disposal', async (t) => {
  const { overlay, collection } = transitionFixture(t);
  const previousImage = globalThis.Image;
  let image;
  globalThis.Image = class {
    constructor() {
      image = this;
    }
  };
  t.after(() => {
    if (previousImage === undefined) delete globalThis.Image;
    else globalThis.Image = previousImage;
  });
  overlay._source = null;
  overlay.textureCanvas = null;
  const loading = overlay.load();
  overlay.destroy();
  image.onload();
  await loading;
  assert.equal(overlay.layer, null);
  assert.equal(overlay.textureCanvas, null);
  assert.equal(collection.length, 1);
});

test('night lights enter only when the globe is small enough and leave with hysteresis', () => {
  assert.equal(shouldShowNightLights(100, 300, false), true);
  assert.equal(shouldShowNightLights(130, 300, false), false);
  assert.equal(shouldShowNightLights(130, 300, true), true);
  assert.equal(shouldShowNightLights(170, 300, true), true);
  assert.equal(shouldShowNightLights(190, 300, true), false);
  assert.equal(NIGHT_LIGHTS_ENTER_RATIO < NIGHT_LIGHTS_EXIT_RATIO, true);
});

test('night lights fade out continuously before the zoom exit threshold', () => {
  assert.equal(nightLightsOpacity(90, 300), 1);
  assert.equal(nightLightsOpacity(180, 300), 0);
  assert.equal(
    nightLightsOpacity(
      ((NIGHT_LIGHTS_FADE_START_RATIO + NIGHT_LIGHTS_EXIT_RATIO) / 2) * 300,
      300,
    ),
    0.5,
  );
});

test('terminator factor is full on the night side and zero on the day side', () => {
  assert.equal(nightLightsFactor(-1), 1);
  assert.equal(nightLightsFactor(1), 0);
  assert.ok(nightLightsFactor(0) > 0 && nightLightsFactor(0) < 1);
});

test('bundled night-light image uses north-up equirectangular coordinates', () => {
  const north = nightLightsTextureUv(Math.PI / 2, 0);
  const south = nightLightsTextureUv(-Math.PI / 2, 0);
  assert.equal(north.y, 1);
  assert.equal(south.y, 0);
  assert.equal(nightLightsTextureUv(0, 0).x, 0.5);
});

test('the bundled primary texture is the 2023 NASA independent-lights visualization', () => {
  assert.equal(NIGHT_LIGHTS_TEXTURE_PRODUCT, 'NASA Black Marble / SVS 5276');
  assert.match(NIGHT_LIGHTS_TEXTURE_URL, /2023-8192/);
  assert.match(NIGHT_LIGHTS_FALLBACK_TEXTURE_URL, /2016-3600/);
});

test('twilight spans twice the previous boundary width with smooth endpoints', () => {
  assert.equal(NIGHT_LIGHTS_TWILIGHT_WIDTH, 0.15);
  assert.equal(nightLightsFactor(-0.15), 1);
  assert.equal(nightLightsFactor(0.15), 0);
  assert.ok(nightLightsFactor(0.1) > 0);
  assert.ok(nightLightsFactor(-0.1) < 1);
  assert.equal(nightLightsFactor(0), 0.5);
});
