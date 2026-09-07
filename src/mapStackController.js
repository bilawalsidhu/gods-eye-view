import * as Cesium from 'cesium';
import {
  AzureMapsAttributionController,
  OSM_FALLBACK_METADATA,
  createAzureMapsCesiumImageryProviders,
  createOsmFallbackProvider,
} from './azure/mapsImagery.js';
import { governorRequestRender } from './renderGovernor.js';

export const MAP_STACKS = Object.freeze([
  Object.freeze({ id: 'azure-satellite', label: 'Azure Satellite', shortLabel: 'SAT', style: 'satellite' }),
  Object.freeze({ id: 'azure-hybrid', label: 'Azure Hybrid', shortLabel: 'HYB', style: 'hybrid' }),
  Object.freeze({ id: 'azure-streets', label: 'Azure Streets', shortLabel: 'ROAD', style: 'streets' }),
  Object.freeze({ id: 'osm', label: 'OpenStreetMap', shortLabel: 'OSM', style: 'osm' }),
]);

const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';

function viewForAttribution(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle?.(viewer.scene?.globe?.ellipsoid)
    || Cesium.Rectangle.MAX_VALUE;
  const height = Number(viewer?.camera?.positionCartographic?.height);
  const zoom = Number.isFinite(height)
    ? Math.max(1, Math.min(19, Math.round(Math.log2(40_000_000 / Math.max(1, height)))))
    : 1;
  return {
    bounds: {
      west: Cesium.Math.toDegrees(rectangle.west),
      south: Cesium.Math.toDegrees(rectangle.south),
      east: Cesium.Math.toDegrees(rectangle.east),
      north: Cesium.Math.toDegrees(rectangle.north),
    },
    zoom,
  };
}

/**
 * Controls Cesium raster imagery while keeping all Azure credentials in the BFF.
 * Every stack uses Re:Earth terrain; Azure failures resolve to the explicit OSM
 * fallback instead of leaving a blank or mislabelled globe.
 */
export class MapStackController {
  constructor(viewer, {
    initialStack = 'azure-satellite',
    fetchImpl = globalThis.fetch,
    onChange = null,
    onError = null,
  } = {}) {
    this.viewer = viewer;
    this.fetchImpl = fetchImpl;
    this._activeId = initialStack;
    this._onChange = onChange;
    this._onError = onError;
    this._imageryLayers = [];
    this._imageryProviders = new Map();
    this._attributionControllers = new Map();
    this._removeImageryErrorListeners = [];
    this._reearthTerrainProvider = null;
    this._terrainInstalled = false;
    this._switchGen = 0;
    this._isSwitching = false;
    this._lastError = null;
    this._fallbackPending = false;
    this._cameraMoveEnd = () => void this._refreshAttribution(this._activeId).catch(() => {});
    this.viewer?.camera?.moveEnd?.addEventListener?.(this._cameraMoveEnd);
  }

  getStacks() {
    return MAP_STACKS.map((stack) => ({
      ...stack,
      available: true,
      unavailableReason: null,
    }));
  }

  getStack(id) {
    return MAP_STACKS.find((stack) => stack.id === id) || null;
  }

  getActiveId() {
    return this._activeId;
  }

  getActiveStack() {
    return this.getStack(this._activeId);
  }

  getSwitchGeneration() {
    return this._switchGen;
  }

  isStackAvailable(id) {
    return Boolean(this.getStack(id));
  }

  getState(status = this._isSwitching ? 'switching' : 'ready') {
    return {
      activeId: this._activeId,
      activeStack: this.getActiveStack(),
      stacks: this.getStacks(),
      status,
      lastError: this._lastError,
    };
  }

  async setStack(id, { silent = false } = {}) {
    const requested = this.getStack(id) || this.getStack('azure-satellite');
    const gen = ++this._switchGen;
    this._isSwitching = true;
    this._lastError = null;
    if (!silent) this._emitChange('switching');

    try {
      await this._installReearthTerrain(gen);
      if (gen !== this._switchGen) return this.getState();
      if (requested.id === 'osm') {
        this._activateProviders([createOsmFallbackProvider(Cesium)], gen);
        this._activeId = 'osm';
      } else {
        const resolution = this._getAzureProviders(requested);
        await resolution.attribution.update(viewForAttribution(this.viewer));
        if (gen !== this._switchGen) return this.getState();
        this._activateProviders(resolution.providers, gen, requested);
        this._activeId = requested.id;
      }
      this.viewer.scene.globe.show = true;
      governorRequestRender('map-stack');
      if (!silent) this._emitChange('ready');
    } catch (error) {
      if (gen !== this._switchGen) return this.getState();
      await this._activateOsmFallback(requested, error, gen, silent);
    } finally {
      if (gen === this._switchGen) this._isSwitching = false;
    }
    return this.getState();
  }

  _getAzureProviders(stack) {
    if (this._imageryProviders.has(stack.id)) return this._imageryProviders.get(stack.id);
    const attribution = new AzureMapsAttributionController({
      style: stack.style,
      fetchImpl: this.fetchImpl,
      requestRender: () => governorRequestRender('azure-maps-attribution'),
    });
    const providers = createAzureMapsCesiumImageryProviders(Cesium, {
      style: stack.style,
      attributionController: attribution,
    });
    const resolution = { providers, attribution };
    this._imageryProviders.set(stack.id, resolution);
    this._attributionControllers.set(stack.id, attribution);
    return resolution;
  }

  _activateProviders(providers, gen, stack = null) {
    if (gen !== this._switchGen) return;
    this._removeImagery();
    providers.forEach((provider, index) => {
      this._imageryLayers.push(this.viewer.imageryLayers.add(new Cesium.ImageryLayer(provider), index));
      if (stack) this._watchProvider(provider, stack, gen);
    });
  }

  _watchProvider(provider, stack, gen) {
    if (!provider?.errorEvent?.addEventListener) return;
    let failures = 0;
    const remove = provider.errorEvent.addEventListener((error) => {
      if (gen !== this._switchGen || this._activeId !== stack.id) return;
      failures += 1;
      if (failures < 2 || this._fallbackPending) return;
      this._fallbackPending = true;
      void this._activateOsmFallback(stack, error, this._switchGen, false)
        .finally(() => { this._fallbackPending = false; });
    });
    this._removeImageryErrorListeners.push(remove);
  }

  async _activateOsmFallback(requested, error, gen, silent) {
    if (gen !== this._switchGen) return;
    const reason = error?.message || String(error || 'unavailable');
    this._activateProviders([createOsmFallbackProvider(Cesium)], gen);
    this._activeId = 'osm';
    this.viewer.scene.globe.show = true;
    this._lastError = `${requested.label} is unavailable; using ${OSM_FALLBACK_METADATA.label}`;
    this._onError?.(`${this._lastError} (${reason})`, requested);
    governorRequestRender('map-stack-fallback');
    if (!silent) this._emitChange('error');
  }

  async _refreshAttribution(stackId) {
    const stack = this.getStack(stackId);
    const controller = this._attributionControllers.get(stackId);
    if (!stack || !controller || stack.id === 'osm') return;
    await controller.update(viewForAttribution(this.viewer));
  }

  async _installReearthTerrain(gen) {
    if (this._terrainInstalled) return;
    if (!this._reearthTerrainProvider) {
      try {
        this._reearthTerrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL);
      } catch (error) {
        console.warn('[MapStack] Re:Earth terrain unavailable; using the ellipsoid:', error);
        this._reearthTerrainProvider = new Cesium.EllipsoidTerrainProvider();
      }
    }
    if (gen !== this._switchGen) return;
    this.viewer.terrainProvider = this._reearthTerrainProvider;
    this._terrainInstalled = true;
  }

  _removeImagery() {
    this._removeImageryErrorListeners.splice(0).forEach((remove) => remove?.());
    this._imageryLayers.splice(0).forEach((layer) => this.viewer.imageryLayers.remove(layer, false));
  }

  _emitChange(status) {
    this._onChange?.(this.getState(status));
  }

  destroy() {
    this.viewer?.camera?.moveEnd?.removeEventListener?.(this._cameraMoveEnd);
    this._removeImagery();
  }
}
