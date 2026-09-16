import { indexMapSources } from './registry.js';
import * as Cesium from 'cesium';
import { createMapCredits } from './credits.js';

/** Coordinate source lifetimes and scene changes; the registry owns provider choices. */
export class MapSourceController {
  constructor(
    viewer,
    {
      registry,
      initialStack,
      onChange = null,
      onError = null,
      requestRender = () => viewer?.scene?.requestRender?.(),
      createImageryLayer = (provider) => new Cesium.ImageryLayer(provider),
    },
  ) {
    this.viewer = viewer;
    this._registry = registry;
    this._sources = indexMapSources(registry.sources);
    this._activeId = this.isStackAvailable(initialStack)
      ? initialStack
      : registry.defaultId;
    this._onChange = onChange;
    this._onError = onError;
    this._requestRender = requestRender;
    this._createImageryLayer = createImageryLayer;
    this._credits = createMapCredits(viewer);
    this._abort = new AbortController();
    this._imageryProviders = new Map();
    this._terrainProviders = new Map();
    this._tilesets = new Map();
    this._ownedTilesets = new Set();
    this._disposed = new WeakSet();
    this._switchGen = 0;
    this._isSwitching = false;
    this._lastError = null;
    this._imageryLayer = null;
    this._activeImageryProvider = null;
    this._removeImageryErrorListener = null;
    this._terrainMode = null;
    this._destroyed = false;
  }

  getStack(id) {
    return this._sources.get(id)?.descriptor || null;
  }
  getStacks() {
    return [...this._sources.values()].map(({ descriptor }) => {
      const stack = descriptor;
      const available = this.isStackAvailable(stack.id);
      return {
        ...stack,
        available,
        unavailableReason: available ? null : this._unavailableReason(stack),
      };
    });
  }
  isStackAvailable(id) {
    const source = this._sources.get(id);
    return Boolean(source && source.available !== false);
  }
  _unavailableReason(stack) {
    return (
      this._sources.get(stack?.id)?.unavailableReason ||
      `${stack?.label || 'This map stack'} is unavailable`
    );
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
  getState(status = this._isSwitching ? 'switching' : 'ready') {
    return {
      activeId: this._activeId,
      activeStack: this.getActiveStack(),
      stacks: this.getStacks(),
      status,
      lastError: this._lastError,
      ...this._registry.state,
    };
  }
  _emitChange(status) {
    this._onChange?.(this.getState(status));
  }

  async setStack(id, { silent = false } = {}) {
    if (this._destroyed) return this.getState();
    const stack = this.getStack(id) || this.getStack(this._registry.unknownId);
    if (!stack) return null;
    if (!this.isStackAvailable(stack.id)) {
      const message = this._unavailableReason(stack);
      this._lastError = message;
      this._onError?.(message, stack);
      return this.getState();
    }
    const gen = ++this._switchGen;
    this._isSwitching = true;
    this._lastError = null;
    if (!silent) this._emitChange('switching');
    try {
      const activation = await this._activate(stack, gen);
      if (gen !== this._switchGen) return this.getState();
      this._activeId = activation?.effectiveStackId || stack.id;
      if (activation?.fallbackMessage) {
        this._lastError = activation.fallbackMessage;
        this._onError?.(activation.fallbackMessage, stack);
      }
      this._requestRender('map-stack');
      if (!silent) this._emitChange('ready');
    } catch (error) {
      if (gen !== this._switchGen) return this.getState();
      const message = error?.message || String(error);
      this._lastError = message;
      this._onError?.(message, stack);
      const recovery = this.getStack(this._registry.recoveryId);
      if (
        recovery &&
        recovery.id !== stack.id &&
        this.isStackAvailable(recovery.id)
      ) {
        try {
          const activation = await this._activate(recovery, gen);
          if (gen !== this._switchGen) return this.getState();
          this._activeId = activation?.effectiveStackId || recovery.id;
        } catch (recoveryError) {
          if (gen !== this._switchGen) return this.getState();
          this._lastError = recoveryError?.message || String(recoveryError);
          this._onError?.(this._lastError, recovery);
        }
      }
      if (!silent) this._emitChange('error');
    } finally {
      if (gen === this._switchGen) this._isSwitching = false;
    }
    return this.getState();
  }

  _activate(stack, gen) {
    const source = this._sources.get(stack.id);
    return source.imagery
      ? this._activateGlobeStack(stack, gen)
      : this._activateTileset(source, gen);
  }

  async _activateTileset(source, gen) {
    let tileset = source.tileset;
    if (!tileset) {
      if (!source.createTileset)
        throw new Error(`Missing 3D source: ${source.descriptor.id}`);
      tileset = await this._cached(this._tilesets, source.descriptor.id, () =>
        source.createTileset({ signal: this._abort.signal }),
      );
    }
    if (gen !== this._switchGen) return;
    if (!source.tileset && !this._ownedTilesets.has(tileset)) {
      tileset.show = false;
      this.viewer.scene.primitives.add(tileset);
      this._ownedTilesets.add(tileset);
    }
    this._removeImageryLayer();
    this._credits.show(source.credit || null);
    this._showTileset(tileset);
    this.viewer.scene.globe.show = false;
    // Terrain is intentionally untouched while the globe is hidden.
  }

  _showTileset(active) {
    for (const source of this._sources.values())
      if (source.tileset) source.tileset.show = source.tileset === active;
    for (const tileset of this._ownedTilesets)
      tileset.show = tileset === active;
  }

  async _activateGlobeStack(stack, gen) {
    const resolution = await this._getImageryProvider(stack);
    if (gen !== this._switchGen) return;
    // Scene shots reapply their map stack at every handoff. Keep the live
    // layer (and its loaded tiles) when the resolved provider is unchanged;
    // rebuilding it exposes the bare globe while imagery loads again.
    if (
      !this._imageryLayer ||
      this._activeImageryProvider !== resolution.provider
    ) {
      this._removeImageryLayer();
      this._imageryLayer = this._createImageryLayer(resolution.provider);
      this._activeImageryProvider = resolution.provider;
      this.viewer.imageryLayers.add(this._imageryLayer, 0);
    }
    const source = this._sources.get(resolution.effectiveStackId);
    this._credits.show(source?.credit || null);
    // A repeated request still owns a new switch generation. Rebind its
    // failure listener so fallback remains live without accumulating listeners.
    this._removeImageryErrorListener?.();
    this._removeImageryErrorListener = null;
    this._watchProvider(resolution, gen);
    this._showTileset(null);
    this.viewer.scene.globe.show = true;
    this._activeId = resolution.effectiveStackId;
    if (source?.terrain && source.terrain.id !== this._terrainMode) {
      const terrain = source.terrain;
      const result = await this._cached(
        this._terrainProviders,
        terrain.id,
        () => terrain.create({ signal: this._abort.signal }),
      );
      if (gen !== this._switchGen) return;
      if (result.terrain) this.viewer.scene.setTerrain(result.terrain);
      else this.viewer.terrainProvider = result.provider;
      this._terrainMode = terrain.id;
    }
    return resolution;
  }

  _cached(cache, id, create) {
    if (cache.has(id)) return cache.get(id);
    const promise = Promise.resolve()
      .then(() => {
        this._abort.signal.throwIfAborted();
        return create();
      })
      .catch((error) => {
        if (cache.get(id) === promise) cache.delete(id);
        throw error;
      });
    cache.set(id, promise);
    return promise;
  }

  _getImageryProvider(stack, visited = new Set()) {
    if (visited.has(stack.id))
      return Promise.reject(new Error('Map source fallback cycle'));
    return this._cached(this._imageryProviders, stack.id, async () => {
      const source = this._sources.get(stack.id);
      try {
        const provider = await source.imagery({ signal: this._abort.signal });
        if (this._destroyed) this._dispose(provider);
        return { provider, effectiveStackId: stack.id, fallbackMessage: null };
      } catch (error) {
        const fallback = source.constructionFallback;
        if (this._destroyed || !fallback || !this.isStackAvailable(fallback.id))
          throw error;
        const next = new Set(visited).add(stack.id);
        const resolution = await this._getImageryProvider(
          this.getStack(fallback.id),
          next,
        );
        return { ...resolution, fallbackMessage: fallback.message };
      }
    });
  }

  _watchProvider(resolution, gen) {
    const fallback = this._sources.get(
      resolution.effectiveStackId,
    )?.tileFailureFallback;
    const errorEvent = resolution.provider?.errorEvent;
    if (!fallback || !errorEvent?.addEventListener) return;
    let failures = 0;
    let pending = false;
    this._removeImageryErrorListener = errorEvent.addEventListener((error) => {
      if (
        gen !== this._switchGen ||
        this._activeImageryProvider !== resolution.provider
      )
        return;
      const retryCount = Number(error?.timesRetried);
      failures =
        Number.isInteger(retryCount) && retryCount >= 0
          ? Math.max(failures + 1, retryCount + 1)
          : failures + 1;
      if (failures < fallback.threshold || pending) return;
      pending = true;
      this._onError?.(
        fallback.message,
        this.getStack(resolution.effectiveStackId),
      );
      const expectedGen = this._switchGen + 1;
      void this.setStack(fallback.id, { silent: true })
        .then((state) => {
          if (
            !this._destroyed &&
            this._switchGen === expectedGen &&
            state?.activeId === fallback.id
          ) {
            this._lastError = fallback.message;
            this._emitChange('error');
          }
        })
        .finally(() => {
          pending = false;
        });
    });
  }

  _removeImageryLayer() {
    this._removeImageryErrorListener?.();
    this._removeImageryErrorListener = null;
    if (this._imageryLayer)
      this.viewer.imageryLayers.remove(this._imageryLayer, true);
    this._imageryLayer = null;
    this._activeImageryProvider = null;
  }
  _dispose(value) {
    if (!value || this._disposed.has(value)) return;
    this._disposed.add(value);
    if (typeof value.destroy === 'function' && !value.isDestroyed?.())
      value.destroy();
  }
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._switchGen++;
    this._abort.abort();
    this._isSwitching = false;
    this._removeImageryLayer();
    this._credits.destroy();
    for (const promise of this._imageryProviders.values())
      void Promise.resolve(promise).then(
        (value) => this._dispose(value.provider),
        () => {},
      );
    for (const promise of this._terrainProviders.values())
      void Promise.resolve(promise).then(
        (value) => this._dispose(value.provider),
        () => {},
      );
    for (const tileset of this._ownedTilesets) {
      this.viewer.scene.primitives.remove(tileset);
      this._dispose(tileset);
    }
    for (const promise of this._tilesets.values())
      void Promise.resolve(promise).then(
        (value) => this._dispose(value),
        () => {},
      );
    this._imageryProviders.clear();
    this._terrainProviders.clear();
    this._tilesets.clear();
    this._ownedTilesets.clear();
    this._onChange = null;
    this._onError = null;
  }
}
