import { indexMapSources } from './registry.js';
import * as Cesium from 'cesium';
import { createMapCredits } from './credits.js';
import { acquireImageryComparison } from './imageryComparison.js';

/**
 * Private `setStack` option marking a switch the controller issues itself
 * (a tile-failure fallback); outside callers cannot forge it.
 */
const AUTOMATIC = Symbol('automatic switch');

/** Background retries of a fallback in use back off from 30 s to 10 min. */
const FALLBACK_RETRY_MS = 30_000;
const FALLBACK_RETRY_MAX_MS = 600_000;
/** A retry attempt still unsettled after a minute counts as failed. */
const FALLBACK_ATTEMPT_MS = 60_000;

const resolved = (provider, effectiveStackId) => ({
  provider,
  effectiveStackId,
  fallbackMessage: null,
});

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
    /** Who chose the current generation's stack: 'manual' | 'automatic'. */
    this._switchOrigin = 'manual';
    this._isSwitching = false;
    this._lastError = null;
    this._imageryLayer = null;
    this._activeImageryProvider = null;
    this._activeResolution = null;
    this._removeImageryErrorListener = null;
    this._terrainMode = null;
    this._terrainFallback = null;
    this._retryTimer = null;
    this._retrying = false;
    this._retryRequested = false;
    this._retryDelay = FALLBACK_RETRY_MS;
    /** Expire callbacks of retry attempts in flight; destroy() runs them. */
    this._retryDeadlines = new Set();
    /** A fallback terrain a retry replaced while it stayed installed. */
    this._replacedTerrain = null;
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
    // A destroyed controller never settles again, so it takes no listeners.
    if (typeof listener !== 'function' || this._destroyed) return () => {};
    this._subscribers.add(listener);
    return () => {
      this._subscribers.delete(listener);
    };
  }

  _notifySubscribers() {
    if (this._destroyed || !this._subscribers.size) return;
    const state = this.getState();
    for (const listener of [...this._subscribers]) {
      if (this._destroyed) return;
      if (!this._subscribers.has(listener)) continue;
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
    this._activeResolution = resolution;
    if (source?.terrain && source.terrain.id !== this._terrainMode) {
      const terrain = source.terrain;
      const pending = this._cached(this._terrainProviders, terrain.id, () =>
        terrain.create({ signal: this._abort.signal }),
      );
      let result = await pending;
      if (gen !== this._switchGen) return;
      // A background retry may have replaced a fallback while this waited.
      const latest = this._terrainProviders.get(terrain.id);
      if (latest !== pending) result = await latest;
      if (gen !== this._switchGen) return;
      this._applyTerrain(result);
      this._terrainMode = terrain.id;
    }
    if (resolution.fallbackFor || this._terrainFallback) this._scheduleRetry();
    return resolution;
  }

  _applyTerrain(result) {
    if (result.terrain) this.viewer.scene.setTerrain(result.terrain);
    else this.viewer.terrainProvider = result.provider;
    this._terrainFallback = result.fallback ? result : null;
    if (this._replacedTerrain && this._replacedTerrain !== result) {
      this._dispose(this._replacedTerrain.provider);
      this._replacedTerrain = null;
    }
  }

  /**
   * One timer retries the real provider behind whichever fallback is on
   * screen: Esri's OSM stand-in, or flat terrain on a shown globe. Fallbacks
   * stay cached and shown meanwhile, so no switch waits on a retry; a
   * fallback out of use is left alone until an activation shows it again.
   * One retry runs at a time; a request made meanwhile re-arms once it ends.
   */
  _scheduleRetry() {
    if (this._retryTimer || this._destroyed) return;
    if (this._retrying) {
      this._retryRequested = true;
      return;
    }
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      void this._retryFallbacks();
    }, this._retryDelay);
  }

  async _retryFallbacks() {
    const resolution = this._activeResolution;
    const flat = this.viewer.scene.globe.show ? this._terrainFallback : null;
    const id = resolution?.fallbackFor;
    let terrain = flat && this._sources.get(this._activeId)?.terrain;
    if (terrain?.id !== this._terrainMode) terrain = null;
    if (!id && !terrain) return;
    this._retrying = true;
    this._retryRequested = false;
    // An attempt that outlives its deadline counts as a failure. Its signal is
    // aborted, but the Esri and keyless factories ignore it and Cesium's
    // requests have no timeout, so a late result is released, never used.
    const attempt = async (create, release) => {
      const expiry = new AbortController();
      let expire;
      const deadline = new Promise((resolve) => {
        expire = () => {
          clearTimeout(timer);
          resolve(expiry);
        };
      });
      const timer = setTimeout(expire, FALLBACK_ATTEMPT_MS);
      this._retryDeadlines.add(expire);
      const pending = Promise.resolve().then(() =>
        create?.({
          signal: AbortSignal.any([this._abort.signal, expiry.signal]),
        }),
      );
      try {
        const result = await Promise.race([pending, deadline]);
        if (result !== expiry) return result;
        expiry.abort();
        pending.then(release, () => {});
        return null;
      } catch {
        return null; // Still unavailable: keep the fallback.
      } finally {
        clearTimeout(timer);
        this._retryDeadlines.delete(expire);
      }
    };
    // Each recovers as soon as it loads, never waiting on the other.
    const retryImagery = async () => {
      const cached = this._imageryProviders.get(id);
      const provider = await attempt(this._sources.get(id).imagery, (late) =>
        this._dispose(late),
      );
      // Obsolete: destroyed, or the cache moved on while this was in flight.
      if (this._destroyed || this._imageryProviders.get(id) !== cached) {
        this._dispose(provider);
        return true;
      }
      if (!provider) return false;
      this._imageryProviders.set(id, Promise.resolve(resolved(provider, id)));
      // Still showing the fallback once any switch settles: use the real one.
      const recover = () => {
        if (this._activeResolution === resolution)
          void this.setStack(id, { [AUTOMATIC]: true });
      };
      if (!this._isSwitching) recover();
      else {
        const stop = this.subscribe(() => {
          stop();
          recover();
        });
      }
      return true;
    };
    const retryTerrain = async () => {
      const cached = this._terrainProviders.get(terrain.id);
      const real = await attempt(terrain.create, (late) =>
        this._dispose(late?.provider),
      );
      if (
        this._destroyed ||
        this._terrainProviders.get(terrain.id) !== cached ||
        !real ||
        real.fallback
      ) {
        this._dispose(real?.provider);
        return Boolean(real && !real.fallback);
      }
      this._terrainProviders.set(terrain.id, Promise.resolve(real));
      if (this._terrainFallback === flat && this.viewer.scene.globe.show) {
        this._applyTerrain(real);
        this._dispose(flat.provider);
        this._requestRender('map-stack');
      } else {
        this._terrainMode = null; // The next globe activation installs it.
        // Release the replaced fallback once nothing shows it.
        if (this._terrainFallback === flat) this._replacedTerrain = flat;
        else this._dispose(flat.provider);
      }
      return true;
    };
    const settled = (retry) =>
      retry().catch((error) => {
        console.warn('[MapSourceController] fallback recovery failed:', error);
        return false;
      });
    let failed = false;
    try {
      const results = await Promise.all([
        id && settled(retryImagery),
        terrain && settled(retryTerrain),
      ]);
      failed = results.includes(false);
    } finally {
      this._retrying = false;
    }
    if (this._destroyed) return;
    this._retryDelay = failed
      ? Math.min(this._retryDelay * 2, FALLBACK_RETRY_MAX_MS)
      : FALLBACK_RETRY_MS;
    if (failed || this._retryRequested) this._scheduleRetry();
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
        return resolved(provider, stack.id);
      } catch (error) {
        const fallback = source.constructionFallback;
        if (this._destroyed || !fallback || !this.isStackAvailable(fallback.id))
          throw error;
        const next = new Set(visited).add(stack.id);
        const resolution = await this._getImageryProvider(
          this.getStack(fallback.id),
          next,
        );
        return {
          ...resolution,
          fallbackMessage: fallback.message,
          fallbackFor: stack.id,
        };
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
    if (this._imageryLayer)
      this.viewer.imageryLayers.remove(this._imageryLayer, true);
    this._imageryLayer = null;
    this._activeImageryProvider = null;
    this._activeResolution = null;
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
    clearTimeout(this._retryTimer);
    for (const expire of this._retryDeadlines) expire();
    this._retryDeadlines.clear();
    this._retrying = false;
    this._dispose(this._replacedTerrain?.provider);
    this._replacedTerrain = null;
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
