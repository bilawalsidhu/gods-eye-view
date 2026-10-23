import * as Cesium from 'cesium';
import { projectEarthDiscToViewport } from './celestialRing.js';
import {
  createNativeRasterImageryProvider,
  nativeRasterDimensions,
  installNativeNightGlobeLighting,
  NATIVE_NIGHT_BRIGHTNESS,
} from './maps/nativeRasterImagery.js';

/** Native night imagery shares the map's geometry and visual post-processing. */
// Ratios are the projected Earth radius divided by the viewport height. The
// shared projection helper uses vertical FOV, so this keeps the threshold
// stable across portrait and wide desktop layouts.
export const NIGHT_LIGHTS_ENTER_RATIO = 0.38;
export const NIGHT_LIGHTS_EXIT_RATIO = 0.6;
export const NIGHT_LIGHTS_FADE_START_RATIO = NIGHT_LIGHTS_ENTER_RATIO;
export const NIGHT_LIGHTS_FADE_DURATION_MS = 360;
// The image is bundled so globe view never depends on a tile service or a
// burst of network requests while the operator is rotating the Earth.
export const NIGHT_LIGHTS_TEXTURE_DATE = '2023-01-01';
export const NIGHT_LIGHTS_TEXTURE_PRODUCT = 'NASA Black Marble / SVS 5276';
export const NIGHT_LIGHTS_TEXTURE_URL =
  '/assets/night-lights/black-marble-svs-night-lights-2023-8192.png';
export const NIGHT_LIGHTS_FALLBACK_TEXTURE_URL =
  '/assets/night-lights/vnp46a4-viirs-night-lights-2016-3600.png';
export const NIGHT_LIGHTS_DARKNESS = 0.94;
export const NIGHT_LIGHTS_LIGHT_THRESHOLD = 0.12;
// Sampled from the dark map/terrain tones in the supplied Apple Maps mobile
// reference: a muted blue-purple rather than saturated violet.
export const NIGHT_LIGHTS_GOLD = Object.freeze({ r: 1.0, g: 0.82, b: 0.36 });
export const NIGHT_LIGHTS_PURPLE = Object.freeze({
  r: 39 / 255,
  g: 38 / 255,
  b: 51 / 255,
});
export const NIGHT_LIGHTS_TWILIGHT_WIDTH = 0.15;
const PREFERENCE_KEY = 'gev-night-lights-enabled';

function tryInstallNativeLighting(C, viewer, install, label) {
  try {
    install(C, viewer);
    return true;
  } catch (error) {
    console.warn(`[NightLights] ${label} shader contract unavailable`, error);
    return false;
  }
}

/** Return the north-up equirectangular UV used by the bundled map. */
export function nightLightsTextureUv(latitude, longitude) {
  const lat = Cesium.Math.clamp(
    Number(latitude),
    -Cesium.Math.PI_OVER_TWO,
    Cesium.Math.PI_OVER_TWO,
  );
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    x: lon / (2 * Math.PI) + 0.5,
    y: 0.5 + lat / Math.PI,
  };
}

export function shouldShowNightLights(
  earthRadiusPx,
  viewportMinPx,
  wasVisible = false,
) {
  const ratio = Number(earthRadiusPx) / Number(viewportMinPx);
  if (!Number.isFinite(ratio) || !(ratio > 0)) return false;
  return (
    ratio <= (wasVisible ? NIGHT_LIGHTS_EXIT_RATIO : NIGHT_LIGHTS_ENTER_RATIO)
  );
}

/** Fade the layer while zooming from the globe threshold toward the exit. */
export function nightLightsOpacity(earthRadiusPx, viewportMinPx) {
  const ratio = Number(earthRadiusPx) / Number(viewportMinPx);
  if (!Number.isFinite(ratio) || !(ratio > 0)) return 0;
  if (ratio <= NIGHT_LIGHTS_FADE_START_RATIO) return 1;
  if (ratio >= NIGHT_LIGHTS_EXIT_RATIO) return 0;
  return (
    (NIGHT_LIGHTS_EXIT_RATIO - ratio) /
    (NIGHT_LIGHTS_EXIT_RATIO - NIGHT_LIGHTS_FADE_START_RATIO)
  );
}

export function nightLightsFactor(
  dotSun,
  twilightWidth = NIGHT_LIGHTS_TWILIGHT_WIDTH,
) {
  if (!Number.isFinite(dotSun)) return 0;
  const width = Math.max(
    0.001,
    Number(twilightWidth) || NIGHT_LIGHTS_TWILIGHT_WIDTH,
  );
  const t = Math.min(1, Math.max(0, (dotSun + width) / (2 * width)));
  return 1 - t * t * (3 - 2 * t);
}

/** Lights fade over the wider twilight band entirely on the night hemisphere. */
export function nightLightsLampFactor(dotSun) {
  return nightLightsFactor(dotSun + NIGHT_LIGHTS_TWILIGHT_WIDTH);
}

/** Keep the native night layer above the base and below all data imagery. */
export function orderNightImagery(collection, layer, kind) {
  const target = kind === 'globe' && collection.length > 1 ? 1 : 0;
  while (collection.indexOf(layer) > target) collection.lower(layer);
  while (collection.indexOf(layer) >= 0 && collection.indexOf(layer) < target)
    collection.raise(layer);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

export class NightLightsOverlay {
  constructor(
    viewer,
    {
      getHost = () => ({ kind: 'globe', collection: viewer.imageryLayers }),
    } = {},
  ) {
    this.viewer = viewer;
    this.getHost = getHost;
    this.enabled = true;
    try {
      this.enabled = localStorage.getItem(PREFERENCE_KEY) !== 'false';
    } catch {
      /* Storage is optional. */
    }
    this.visible = false;
    this.destroyed = false;
    this.alpha = 0;
    this.targetAlpha = 0;
    this._frame = null;
    this._removers = [];
    this._atmosphereOverrides = [];
    // Install before the first globe shader can enter Cesium's shader cache.
    this._nativeGlobeLighting =
      !viewer.scene.globe?._surface ||
      tryInstallNativeLighting(
        Cesium,
        viewer,
        installNativeNightGlobeLighting,
        'globe',
      );
    this._onSync = () => this.sync();
    this._removers.push(viewer.scene.postRender.addEventListener(this._onSync));
    window.addEventListener('gev:map-stack-changed', this._onSync);
    window.addEventListener('resize', this._onSync);
    this._sunTimer = window.setInterval(() => this.refreshTexture(), 60000);
    this.sync();
  }

  isEnabled() {
    return this.enabled;
  }
  setEnabled(value) {
    if (this.destroyed) return;
    this.enabled = Boolean(value);
    try {
      localStorage.setItem(PREFERENCE_KEY, String(this.enabled));
    } catch {
      /* Storage is optional. */
    }
    this.sync();
  }

  async load() {
    if (this._loading || this._source || this.destroyed) return;
    this._loading = true;
    try {
      const image = await loadImage(NIGHT_LIGHTS_TEXTURE_URL).catch(() =>
        loadImage(NIGHT_LIGHTS_FALLBACK_TEXTURE_URL),
      );
      if (this.destroyed) return;
      this.textureCanvas = document.createElement('canvas');
      const maximum = Math.min(
        8192,
        Cesium.ContextLimits.maximumTextureSize || 4096,
      );
      const { width, height } = nativeRasterDimensions(
        image.naturalWidth,
        maximum,
      );
      this.textureCanvas.width = width;
      this.textureCanvas.height = height;
      const ctx = this.textureCanvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, width, height);
      // Static, independently sampled lamp texture; no per-minute pixel readback.
      this._source = true;
      this._install(this.getHost());
      this.refreshTexture();
      this.sync();
    } catch (error) {
      console.warn('[NightLights] Bundled texture unavailable', error);
    } finally {
      this._loading = false;
    }
  }

  refreshTexture() {
    if (this.destroyed || !this._source) return;
    // Cesium refreshes its automatic sun uniform on the next frame. Native
    // geometry, imagery and mipmaps remain intact even when the clock changes.
    this.viewer.scene.requestRender();
  }

  _removeLayer() {
    this._updateAtmosphere(0);
    if (this.layer && !this.collection?.isDestroyed?.())
      this.collection?.remove(this.layer, true);
    this.layer = null;
    this.collection = null;
    this._removeAdded?.();
    this._removeAdded = null;
  }

  _install(host) {
    this._removeLayer();
    this.kind = host.kind;
    this.collection = host.collection;
    if (!this.textureCanvas || !this.collection || host.kind === 'none') return;
    if (host.kind === 'globe' && this.viewer.scene.globe?._surface) {
      this._nativeGlobeLighting = tryInstallNativeLighting(
        Cesium,
        this.viewer,
        installNativeNightGlobeLighting,
        'globe',
      );
      if (!this._nativeGlobeLighting) return;
    }
    const canvas = this.textureCanvas;
    let provider;
    try {
      provider = createNativeRasterImageryProvider(
        Cesium,
        {
          canvas,
          nightLighting: true,
          url: NIGHT_LIGHTS_TEXTURE_URL,
          tileWidth: canvas.width,
          tileHeight: canvas.height,
          rectangle: Cesium.Rectangle.MAX_VALUE,
        },
        host.kind,
      );
    } catch (error) {
      console.warn('[NightLights] map host shader contract unavailable', error);
      return;
    }
    this.layer = this.collection.addImageryProvider(
      provider,
      host.kind === 'globe' && this.collection.length ? 1 : 0,
    );
    this.layer.name = 'gev-night-lights';
    this.layer.brightness = NATIVE_NIGHT_BRIGHTNESS;
    this._applyAlpha();
    this._removeAdded = this.collection.layerAdded.addEventListener(() =>
      orderNightImagery(this.collection, this.layer, this.kind),
    );
  }

  _applyAlpha() {
    this._updateAtmosphere(this.layer ? this.alpha : 0);
    if (!this.layer) return;
    this.layer.alpha = this.alpha;
    this.layer.show = this.alpha > 0;
  }

  _updateAtmosphere(alpha) {
    // Ground scattering is applied after native imagery. Fade its extra blue
    // wash with the effect so it cannot brighten the dark purple surface or
    // bleach data ramps. SkyAtmosphere still supplies the outer planet rim.
    if (alpha > 0 && !this._atmosphereOverrides.length) {
      for (const [owner, key] of [
        [this.viewer.scene.globe, 'atmosphereLightIntensity'],
        [this.viewer.scene.atmosphere, 'lightIntensity'],
      ]) {
        if (owner && Number.isFinite(owner[key]))
          this._atmosphereOverrides.push({ owner, key, original: owner[key] });
      }
    }
    for (const entry of this._atmosphereOverrides) {
      if (
        entry.applied !== undefined &&
        entry.owner[entry.key] !== entry.applied
      )
        entry.original = entry.owner[entry.key];
      entry.applied = entry.original * (1 - alpha);
      entry.owner[entry.key] = entry.applied;
    }
    if (alpha === 0) this._atmosphereOverrides.length = 0;
  }

  _setTarget(target, now = performance.now()) {
    if (Math.abs(target - this.targetAlpha) < 0.0001) return;
    this._stepFade(now);
    this._fadeFrom = this.alpha;
    this._fadeStart = now;
    this.targetAlpha = target;
    if (this._frame === null)
      this._frame = requestAnimationFrame((time) => this._animate(time));
  }

  _stepFade(now) {
    if (this._fadeStart === undefined) return;
    const t = Math.max(
      0,
      Math.min(1, (now - this._fadeStart) / NIGHT_LIGHTS_FADE_DURATION_MS),
    );
    this.alpha =
      this._fadeFrom + (this.targetAlpha - this._fadeFrom) * (1 - (1 - t) ** 3);
    this._applyAlpha();
  }

  _animate(now) {
    this._frame = null;
    if (this.destroyed) return;
    this._stepFade(now);
    this.viewer.scene.requestRender();
    if (now - this._fadeStart < NIGHT_LIGHTS_FADE_DURATION_MS)
      this._frame = requestAnimationFrame((time) => this._animate(time));
  }

  sync() {
    if (this.destroyed) return;
    const canvas = this.viewer.scene.canvas;
    const disc = projectEarthDiscToViewport(
      this.viewer,
      canvas.clientWidth,
      canvas.clientHeight,
    );
    this.visible =
      this.enabled &&
      !!disc &&
      shouldShowNightLights(
        disc.earthRadius,
        canvas.clientHeight,
        this.visible,
      );
    if (this.visible && !this._source) void this.load();
    const host = this.getHost();
    if (
      host.collection !== this.collection ||
      host.kind !== this.kind ||
      (this.textureCanvas && !this.layer && host.collection)
    )
      this._install(host);
    this._setTarget(
      this.visible && this._source
        ? nightLightsOpacity(disc.earthRadius, canvas.clientHeight)
        : 0,
    );
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._frame !== null) cancelAnimationFrame(this._frame);
    window.clearInterval(this._sunTimer);
    window.removeEventListener('gev:map-stack-changed', this._onSync);
    window.removeEventListener('resize', this._onSync);
    for (const remove of this._removers) remove();
    this._removeLayer();
    this._source = null;
    this.textureCanvas = null;
  }
}
