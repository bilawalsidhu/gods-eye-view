import { indexMapSources } from './registry.js';
import * as Cesium from 'cesium';
import { createMapScene } from './sceneApply.js';
import { applyTerrain } from './terrain.js';
import { acquireImageryComparison } from './imageryComparison.js';

/**
 * Private `setStack` option marking a switch the controller issues itself
 * (a tile-failure fallback); outside callers cannot forge it.
 */
const AUTOMATIC = Symbol('automatic switch');

/**
 * Coordinate source lifetimes and scene changes; the registry owns provider
 * choices.
 *
 * With `engine` (the page's globe engine) every scene change goes through
 * `engine.maps` as an engine-neutral description of the registry source
 * (imagery `kind`/`style`/`accessToken`, terrain `kind`/`accessToken`,
 * photoreal credentials, credit). The registry's factories build Cesium
 * objects, so only a Cesium engine also gets them prebuilt (`provider`,
 * `tileset`, terrain `create`): the controller then keeps resolving, caching
 * and watching them as before (supplied tilesets must be ones the engine
 * knows, i.e. its startup tileset, or has shown). Any other engine builds
 * its own sources from the descriptions; the controller constructs nothing
 * for it, falls back by description when a setter rejects, and has no tile
 * failure watch. On destroy the engine keeps what it shows; owned tilesets
 * are released and disposed. Without an engine the controller applies
 * sources to the viewer itself (standalone use and tests).
 */
export class MapSourceController {
  constructor(
    viewer,
    {
      registry,
      initialStack,
      onChange = null,
      onError = null,
      engine = null,
      requestRender = engine
        ? () => engine.render.request('map-stack')
        : () => viewer?.scene?.requestRender?.(),
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
    this._engine = engine;
    /** Whether the engine takes the registry's prebuilt Cesium objects. */
    this._prebuilt = engine?.kind === 'cesium';
    this._scene = engine
      ? null
      : createMapScene(viewer, { createImageryLayer });
    /** Engine mode: the provider last handed to engine.maps as base imagery. */
    this._baseProvider = null;
    this._abort = new AbortController();
    this._imageryProviders = new Map();
    this._terrainProviders = new Map();
    this._tilesets = new Map();
    this._ownedTilesets = new Set();
    this._disposed = new WeakSet();
    this._switchGen = 0;
    /** Who chose the current generation's stack: 'manual' | 'automatic'. */
    this._switchOrigin = 'manual';
    this._isSwitching = false;
    this._lastError = null;
    this._removeImageryErrorListener = null;
    this._terrainMode = null;
    this._subscribers = new Set();
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
  /** Return the shown supplied or controller-owned tileset, if any. */
  getImageryHostTileset() {
    if (this._destroyed) return null;
    for (const source of this._sources.values())
      if (source.tileset?.show === true) return source.tileset;
    for (const tileset of this._ownedTilesets)
      if (tileset.show === true) return tileset;
    return null;
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
  /**
   * Who chose the stack of the current switch generation: 'manual' for a
   * `setStack` issued from outside (the operator, a scene, a lease),
   * 'automatic' when the controller replaced it itself (a construction or
   * tile-failure fallback, or a recovery after a failed activation).
   * @returns {'manual' | 'automatic'}
   */
  getSwitchOrigin() {
    return this._switchOrigin;
  }
  getState(status = this._isSwitching ? 'switching' : 'ready') {
    return {
      activeId: this._activeId,
      activeStack: this.getActiveStack(),
      stacks: this.getStacks(),
      status,
      lastError: this._lastError,
      switchOrigin: this._switchOrigin,
      ...this._registry.state,
    };
  }
  _emitChange(status) {
    this._onChange?.(this.getState(status));
  }

  /**
   * Hear every settled activation: a stack switch, a silent switch, a
   * fallback after a failure, a recovery. Unlike `onChange` (the UI's
   * status feed, muted by `silent`), listeners fire once per `setStack`
   * after `_activeId` has settled, so a layer that drapes on the active
   * host can rebind. The state's `switchOrigin` says whether the caller
   * ('manual') or the controller itself ('automatic') chose the settled
   * stack. A listener that throws is logged, never fatal.
   * @param {(state: object) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this._subscribers.add(listener);
    return () => {
      this._subscribers.delete(listener);
    };
  }

  _notifySubscribers() {
    if (this._destroyed || !this._subscribers.size) return;
    const state = this.getState();
    for (const listener of [...this._subscribers]) {
      try {
        listener(state);
      } catch (error) {
        console.warn('[MapSourceController] subscriber failed:', error);
      }
    }
  }

  /**
   * Lease the map for an imagery comparison. switchPolicy: 'preserve' (never
   * switch) | 'esri' (switch to Esri imagery from any other stack) |
   * 'esri-if-photoreal' (switch only when Google 3D is active). Throws while
   * another owner holds the lease; see acquireImageryComparison().
   */
  acquireImageryComparison(options) {
    return acquireImageryComparison(this, options);
  }

  async setStack(id, { silent = false, [AUTOMATIC]: automatic = false } = {}) {
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
    this._switchOrigin = automatic ? 'automatic' : 'manual';
    this._isSwitching = true;
    this._lastError = null;
    if (!silent) this._emitChange('switching');
    try {
      const activation = await this._activate(stack, gen);
      if (gen !== this._switchGen) return this.getState();
      this._activeId = activation?.effectiveStackId || stack.id;
      if (this._activeId !== stack.id) this._switchOrigin = 'automatic';
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
        // Whatever settles now is the controller's choice, not the caller's.
        this._switchOrigin = 'automatic';
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
      if (gen === this._switchGen) {
        this._isSwitching = false;
        // The active id has settled for this generation (activated, fell
        // back, or recovered): every subscriber hears it, silent or not.
        this._notifySubscribers();
      }
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
    if (this._engine && !this._prebuilt) {
      this._removeImageryLayer();
      await this._engine.maps.setPhotorealTiles(this._describeTiles(source));
      return;
    }
    let tileset = source.tileset;
    if (!tileset) {
      if (!source.createTileset)
        throw new Error(`Missing 3D source: ${source.descriptor.id}`);
      tileset = await this._cached(this._tilesets, source.descriptor.id, () =>
        source.createTileset({ signal: this._abort.signal }),
      );
    }
    if (gen !== this._switchGen) return;
    if (this._engine) {
      // The engine adds an owned tileset to the scene when it shows it.
      if (!source.tileset) this._ownedTilesets.add(tileset);
      this._removeImageryLayer();
      await this._engine.maps.setPhotorealTiles(
        this._describeTiles(source, tileset),
      );
      return;
    }
    if (!source.tileset && !this._ownedTilesets.has(tileset)) {
      tileset.show = false;
      this.viewer.scene.primitives.add(tileset);
      this._ownedTilesets.add(tileset);
    }
    this._removeImageryLayer();
    this._scene.showCredit(source.credit);
    this._showTileset(tileset);
    this._scene.showGlobe(false);
    // Terrain is intentionally untouched while the globe is hidden.
  }

  _showTileset(active) {
    const tilesets = [];
    for (const source of this._sources.values())
      if (source.tileset) tilesets.push(source.tileset);
    this._scene.showTileset(active, [...tilesets, ...this._ownedTilesets]);
  }

  async _activateGlobeStack(stack, gen) {
    if (this._engine && !this._prebuilt)
      return this._activateDescribedGlobeStack(stack, gen);
    const resolution = await this._getImageryProvider(stack);
    if (gen !== this._switchGen) return;
    if (this._engine) return this._activateEngineGlobeStack(resolution, gen);
    // Scene shots reapply their map stack at every handoff; the map scene
    // keeps the live layer when the resolved provider is unchanged.
    if (this._scene.baseProvider !== resolution.provider) {
      this._removeImageryLayer();
      this._scene.showBaseImagery(resolution.provider);
    }
    const source = this._sources.get(resolution.effectiveStackId);
    this._scene.showCredit(source?.credit);
    // A repeated request still owns a new switch generation. Rebind its
    // failure listener so fallback remains live without accumulating listeners.
    this._removeImageryErrorListener?.();
    this._removeImageryErrorListener = null;
    this._watchProvider(resolution, gen);
    this._showTileset(null);
    this._scene.showGlobe(true);
    this._activeId = resolution.effectiveStackId;
    if (source?.terrain && source.terrain.id !== this._terrainMode) {
      const terrain = source.terrain;
      const result = await this._cached(
        this._terrainProviders,
        terrain.id,
        () => terrain.create({ signal: this._abort.signal }),
      );
      if (gen !== this._switchGen) return;
      applyTerrain(this.viewer, result);
      this._terrainMode = terrain.id;
    }
    return resolution;
  }

  // engine.maps in the order the viewer path applies them: base imagery and
  // its credit, no photoreal tiles (the globe shows), then terrain.
  async _activateEngineGlobeStack(resolution, gen) {
    const { maps } = this._engine;
    const source = this._sources.get(resolution.effectiveStackId);
    this._removeImageryErrorListener?.();
    this._removeImageryErrorListener = null;
    await maps.setBaseImagery(
      this._describeImagery(source, resolution.provider),
    );
    if (gen !== this._switchGen) return;
    this._baseProvider = resolution.provider;
    this._watchProvider(resolution, gen);
    await maps.setPhotorealTiles(null);
    if (gen !== this._switchGen) return;
    this._activeId = resolution.effectiveStackId;
    if (source?.terrain && source.terrain.id !== this._terrainMode) {
      const terrain = source.terrain;
      const result = await this._cached(
        this._terrainProviders,
        terrain.id,
        () => terrain.create({ signal: this._abort.signal }),
      );
      if (gen !== this._switchGen) return;
      await maps.setTerrain(this._describeTerrain(terrain, result));
      if (gen !== this._switchGen) return;
      this._terrainMode = terrain.id;
    }
    return resolution;
  }

  // A non-Cesium engine builds every source from its description. A source it
  // cannot build falls back as the construction fallback says.
  async _activateDescribedGlobeStack(stack, gen, visited = new Set()) {
    const { maps } = this._engine;
    const source = this._sources.get(stack.id);
    try {
      await maps.setBaseImagery(this._describeImagery(source));
    } catch (error) {
      const fallback = source.constructionFallback;
      if (
        this._destroyed ||
        !fallback ||
        visited.has(stack.id) ||
        !this.isStackAvailable(fallback.id)
      )
        throw error;
      const resolution = await this._activateDescribedGlobeStack(
        this.getStack(fallback.id),
        gen,
        new Set(visited).add(stack.id),
      );
      return resolution && { ...resolution, fallbackMessage: fallback.message };
    }
    if (gen !== this._switchGen) return;
    await maps.setPhotorealTiles(null);
    if (gen !== this._switchGen) return;
    this._activeId = stack.id;
    if (source.terrain && source.terrain.id !== this._terrainMode) {
      await maps.setTerrain(this._describeTerrain(source.terrain));
      if (gen !== this._switchGen) return;
      this._terrainMode = source.terrain.id;
    }
    return { effectiveStackId: stack.id, fallbackMessage: null };
  }

  /** Engine description of an imagery source (+ a prebuilt Cesium provider). */
  _describeImagery(source, provider) {
    const { descriptor } = source;
    return {
      descriptor,
      kind: descriptor.kind,
      ...(descriptor.style !== undefined && { style: descriptor.style }),
      ...(source.accessToken !== undefined && {
        accessToken: source.accessToken,
      }),
      credit: source.credit ?? null,
      ...(provider && { provider }),
    };
  }

  /** Engine description of a terrain source (+ the cached Cesium result). */
  _describeTerrain(terrain, result) {
    return {
      id: terrain.id,
      kind: terrain.kind ?? terrain.id,
      ...(terrain.accessToken !== undefined && {
        accessToken: terrain.accessToken,
      }),
      ...(result && { create: () => result }),
    };
  }

  /** Engine description of a photoreal source (+ a prebuilt Cesium tileset). */
  _describeTiles(source, tileset) {
    return {
      descriptor: source.descriptor,
      kind: source.descriptor.kind,
      credit: source.credit ?? null,
      ...(source.googleApiKey && { googleApiKey: source.googleApiKey }),
      ...(source.cesiumToken && { cesiumToken: source.cesiumToken }),
      ...(tileset && { tileset }),
    };
  }

  /** The live base imagery provider, or null. */
  _liveBaseProvider() {
    return this._engine ? this._baseProvider : this._scene.baseProvider;
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
        this._liveBaseProvider() !== resolution.provider
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
      void this.setStack(fallback.id, { silent: true, [AUTOMATIC]: true })
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
    // Engine mode: engine.maps drops the base layer when tiles replace it.
    if (this._engine) this._baseProvider = null;
    else this._scene.removeBaseImagery();
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
    this._subscribers.clear();
    this._switchGen++;
    this._abort.abort();
    this._isSwitching = false;
    this._removeImageryLayer();
    this._scene?.destroy();
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
      if (this._engine) this._engine.maps.releasePhotorealTiles({ tileset });
      else this.viewer.scene.primitives.remove(tileset);
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
