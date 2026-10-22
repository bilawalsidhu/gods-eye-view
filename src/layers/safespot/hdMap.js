import * as Cesium from 'cesium';
import { msg } from '../../i18n/marker.js';

/**
 * @module layers/safespot/hdMap
 * @description High-DPI Retina Street & Label Map Enhancer for SafeSpotSG Lab.
 *
 * Solves low-DPI blurry street labels on standard 256px OSM tiles by:
 * 1. Boosting viewer.resolutionScale to native devicePixelRatio (up to 2.0x Retina).
 * 2. Lowering globe.maximumScreenSpaceError to 1.0 so Cesium loads +1 higher zoom level of street tiles.
 * 3. Overlaying crisp 512px @2x Retina street & label tiles (CartoDB Voyager @2x, OneMap SG HD, CartoDB Dark @2x)
 *    on both 2D/terrain globe (viewer.imageryLayers) and 3D Tiles (tileset.imageryLayers).
 */

export const HD_MAP_MODES = Object.freeze({
  RETINA_VOYAGER: 'retina-voyager',
  ONEMAP_SG: 'onemap-sg',
  RETINA_DARK: 'retina-dark',
  BASE: 'base',
});

export const HD_MAP_LABELS = Object.freeze({
  'retina-voyager': msg('HD MAP: RETINA @2X'),
  'onemap-sg': msg('HD MAP: ONEMAP SG'),
  'retina-dark': msg('HD MAP: DARK @2X'),
  base: msg('HD MAP: BASE'),
});

export class SafeSpotHdMapController {
  constructor(viewer) {
    this._viewer = viewer;
    this._mode = HD_MAP_MODES.RETINA_VOYAGER;
    this._activeLayers = [];
    this._savedResolutionScale = null;
    this._savedMaxSse = null;
    this._attached = false;
  }

  get mode() {
    return this._mode;
  }

  attach(mode = this._mode) {
    this._mode = mode || HD_MAP_MODES.RETINA_VOYAGER;
    this._attached = true;
    this._applyResolutionBoost();
    this._syncImageryLayer();
  }

  setMode(mode) {
    if (!Object.values(HD_MAP_MODES).includes(mode)) return;
    this._mode = mode;
    if (this._attached) {
      this._applyResolutionBoost();
      this._syncImageryLayer();
    }
  }

  cycleMode() {
    const order = [
      HD_MAP_MODES.RETINA_VOYAGER,
      HD_MAP_MODES.ONEMAP_SG,
      HD_MAP_MODES.RETINA_DARK,
      HD_MAP_MODES.BASE,
    ];
    const idx = order.indexOf(this._mode);
    const next = order[(idx + 1) % order.length];
    this.setMode(next);
    return next;
  }

  _applyResolutionBoost() {
    if (!this._viewer || this._viewer.isDestroyed?.()) return;
    try {
      if (this._savedResolutionScale === null && typeof this._viewer.resolutionScale === 'number') {
        this._savedResolutionScale = this._viewer.resolutionScale;
      }
      const dpr = typeof window !== 'undefined' && window.devicePixelRatio
        ? Math.min(Math.max(window.devicePixelRatio, 1.5), 2.0)
        : 1.5;
      this._viewer.resolutionScale = dpr;

      const globe = this._viewer.scene?.globe;
      if (globe) {
        if (this._savedMaxSse === null && typeof globe.maximumScreenSpaceError === 'number') {
          this._savedMaxSse = globe.maximumScreenSpaceError;
        }
        // Lower screen-space error forces Cesium quadtree to fetch higher-zoom street text tiles
        globe.maximumScreenSpaceError = 1.0;
      }
    } catch {
      // Ignore in headless/mock test environments
    }
  }

  _removeImageryLayers() {
    for (const entry of this._activeLayers) {
      try {
        entry.collection?.remove?.(entry.layer, true);
      } catch {
        // ignore
      }
    }
    this._activeLayers = [];
  }

  _createProvider(for3DTilesetOverlay = false) {
    if (this._mode === HD_MAP_MODES.ONEMAP_SG) {
      // Authoritative Singapore Land Authority (SLA) OneMap High-Resolution street & building numbers
      return new Cesium.UrlTemplateImageryProvider({
        url: 'https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png',
        credit: '© Singapore Land Authority OneMap',
        minimumLevel: 11,
        maximumLevel: 19,
        tileWidth: 256,
        tileHeight: 256,
      });
    }
    if (this._mode === HD_MAP_MODES.RETINA_DARK) {
      return new Cesium.UrlTemplateImageryProvider({
        url: for3DTilesetOverlay
          ? 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png'
          : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        subdomains: ['a', 'b', 'c', 'd'],
        credit: '© OpenStreetMap contributors © CARTO (@2x Retina)',
        maximumLevel: 20,
        tileWidth: 256,
        tileHeight: 256,
      });
    }
    // Default: CartoDB Voyager @2x Retina (512px physical pixels in 256px logical tile = ultra-sharp road & street labels)
    return new Cesium.UrlTemplateImageryProvider({
      url: for3DTilesetOverlay
        ? 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}@2x.png'
        : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
      subdomains: ['a', 'b', 'c', 'd'],
      credit: '© OpenStreetMap contributors © CARTO (@2x Retina)',
      maximumLevel: 20,
      tileWidth: 256,
      tileHeight: 256,
    });
  }

  _syncImageryLayer() {
    this._removeImageryLayers();
    if (!this._attached || this._mode === HD_MAP_MODES.BASE) {
      this._viewer?.scene?.requestRender?.();
      return;
    }
    if (!this._viewer || this._viewer.isDestroyed?.()) return;

    try {
      // 1. Attach @2x Retina basemap to viewer.imageryLayers (used when OSM / SAT /Bing globe is visible)
      if (this._viewer.imageryLayers?.addImageryProvider) {
        const provider = this._createProvider(false);
        const layer = this._viewer.imageryLayers.addImageryProvider(provider);
        if (layer) {
          layer.alpha = 1.0;
          layer.magnificationFilter = Cesium.TextureMagnificationFilter.LINEAR;
          layer.minificationFilter = Cesium.TextureMinificationFilter.LINEAR;
          this._activeLayers.push({ collection: this._viewer.imageryLayers, layer });
        }
      }

      // 2. Also drape crisp @2x Retina street labels onto any active 3D Tileset if globe is hidden
      const primitives = this._viewer.scene?.primitives;
      if (primitives && typeof primitives.length === 'number' && typeof primitives.get === 'function') {
        for (let i = 0; i < primitives.length; i++) {
          const prim = primitives.get(i);
          if (prim?.imageryLayers?.addImageryProvider && !prim.isDestroyed?.()) {
            const labelProvider = this._createProvider(this._mode !== HD_MAP_MODES.ONEMAP_SG);
            const tileLayer = prim.imageryLayers.addImageryProvider(labelProvider);
            if (tileLayer) {
              tileLayer.alpha = this._mode === HD_MAP_MODES.ONEMAP_SG ? 0.55 : 0.95;
              tileLayer.magnificationFilter = Cesium.TextureMagnificationFilter.LINEAR;
              tileLayer.minificationFilter = Cesium.TextureMinificationFilter.LINEAR;
              this._activeLayers.push({ collection: prim.imageryLayers, layer: tileLayer });
            }
          }
        }
      }

      this._viewer.scene?.requestRender?.();
    } catch {
      // Ignore in mock viewer unit tests where UrlTemplateImageryProvider or imageryLayers is absent
    }
  }

  detach() {
    this._attached = false;
    this._removeImageryLayers();
    if (this._viewer && !this._viewer.isDestroyed?.()) {
      try {
        if (this._savedResolutionScale !== null) {
          this._viewer.resolutionScale = this._savedResolutionScale;
        }
        if (this._savedMaxSse !== null && this._viewer.scene?.globe) {
          this._viewer.scene.globe.maximumScreenSpaceError = this._savedMaxSse;
        }
        this._viewer.scene?.requestRender?.();
      } catch {
        // ignore
      }
    }
  }

  destroy() {
    this.detach();
    this._viewer = null;
  }
}
