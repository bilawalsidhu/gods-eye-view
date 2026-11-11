// A scene bind or detach waits this long for asynchronous layer attachments.
// A late attachment sees its scene signal aborted and releases its own work.
export const ATTACH_SETTLE_TIMEOUT_MS = 5000;

/** One readiness gate shared by every layer attached to this scene. */
export function createLayerSceneContext(options = {}) {
  let viewReady = !options.viewRestored;
  const context = {
    ...options,
    get viewReady() {
      return viewReady && options.signal?.aborted !== true;
    },
    viewRestored: Promise.resolve(options.viewRestored).then(() => {
      viewReady = true;
    }),
  };
  return context;
}

/** Scene attachment and parked work for the layer lifecycle. */
export class LayerSceneBinding {
  constructor(attachSettleTimeoutMs) {
    // The bound scene: its signal reaches every attachRenderer() call and is
    // aborted when the scene detaches. Asynchronous attachments still running
    // are kept here so the detach releases them only after they stopped.
    this._failedReleases = new WeakMap();
    this._sceneController = null;
    this._sceneDetached = false;
    this._pendingAttachments = new Set();
    this._viewResumptions = [];
    this._attachSettleTimeoutMs = attachSettleTimeoutMs;
    // Lifecycle work and explicit refreshes that wait for the next scene.
    // detachScene() does not wait for parked work, which waits for it.
    this._sceneWaiters = new Set();
    this._parkListeners = new Set();
  }

  /**
   * Release the scene only. Models with an explicit renderer lifetime keep
   * their entry, polling interval, visibility intents and in-flight source.
   * Legacy modules use their ordinary teardown until they gain that contract.
   *
   * Every layer is released even when another one fails, and the manager is
   * always left unbound, so the next bindCatalog() can attach a scene. The
   * failures are reported together. A layer whose release failed keeps it
   * pending: a repeated detachScene(), or the next bindCatalog(), retries it.
   * Periodic refreshes, explicit refreshes and enables requested while no
   * scene is bound wait for the next one.
   */
  async detachScene() {
    // Attachments still in flight stop at their next checkpoint; their
    // partial work is released below like a finished attachment.
    this._sceneController?.abort();
    this._sceneController = null;
    this._sceneDetached = true;
    const viewer = this.viewer;
    const errors = [];
    const droppedQaLayers = [];
    try {
      await this._awaitAttachments([...this._pendingAttachments], 'detach');
      for (const [id, entry] of [...this.layers]) {
        try {
          await this._lifecycleIdleOrParked(entry);
          if (entry.module.attachRenderer && entry.module.detachRenderer) {
            await this._detachEntryRenderer(entry, viewer);
          } else {
            const qaLayer = this._qaLayerIds.has(id);
            if (!(await this.destroyLayer(id))) {
              // The next catalog brings a fresh module for this id. A stale
              // entry would refuse it, so the failed one is dropped here.
              this._stopUpdateLoop(entry);
              this.layers.delete(id);
              this._qaLayerIds.delete(id);
              throw new Error(`Cannot detach layer ${id}`);
            }
            if (qaLayer) droppedQaLayers.push(id);
          }
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      this.viewer = null;
      this.engine = null;
      this._registrationsFinalized = false;
      this._registrationDispositions = null;
    }
    if (droppedQaLayers.length)
      console.warn(
        `[Data] QA layers do not survive a scene switch; register them again: ${droppedQaLayers.join(', ')}`,
      );
    if (errors.length) {
      for (const error of errors)
        console.warn('[Data] scene detach error:', error);
      throw new AggregateError(errors, 'Data layers could not detach');
    }
  }

  /** Release one retained layer's renderer, keeping a failure for a retry. */
  async _detachEntryRenderer(entry, viewer) {
    const pending = this._failedReleases.get(entry);
    if (!pending && (!entry.initialized || entry.sceneDetached)) return;
    const target = pending ? pending.target : viewer;
    this._failedReleases.set(entry, { target });
    await entry.module.detachRenderer(target);
    this._failedReleases.delete(entry);
    entry.sceneDetached = true;
  }

  /** Bind the next catalog only after the preceding scene released its entries. */
  bindCatalog(engine, catalog, options = {}) {
    if (this._registrationsFinalized) throw new Error('Scene already attached');
    this.engine = engine ?? null;
    this._catalogSourceAvailability = catalog.getSourceAvailability;
    const scene = new AbortController();
    this._sceneController = scene;
    // An attachment that is still running when the scene detaches sees this
    // signal aborted and must stop touching the scene.
    const context = createLayerSceneContext({
      ...this._moduleContext(scene.signal),
      ...options,
    });
    this._viewResumptions = [];
    const attachments = [];
    for (const layer of catalog.layers) {
      const entry = this.layers.get(layer.id);
      if (!entry) this.register(layer);
      else {
        if (entry.module !== layer)
          throw new Error(`Layer owner changed: ${layer.id}`);
        if (entry.initialized) {
          attachments.push(this._attachEntryRenderer(entry, context));
        }
      }
    }
    // Retained entries may appear anywhere in the directory. Preserve both
    // catalog order (panel/serialization) and each live entry's identity.
    for (const { id } of catalog.layers) {
      const entry = this.layers.get(id);
      this.layers.delete(id);
      this.layers.set(id, entry);
    }
    this.finalizeRegistrations(catalog.metadata);
    const pending = attachments.filter((ready) => ready?.then);
    // The scene counts as bound for refreshes and parked enables once its
    // attachments settled (or the wait for them timed out).
    const bound = () => {
      if (this._sceneController !== scene) return;
      this._sceneDetached = false;
      this._runDeferredRefreshes();
      this._settleSceneWaiters(true);
    };
    if (!pending.length) {
      bound();
      return undefined;
    }
    return this._awaitAttachments(pending, 'bind').then((settled) => {
      bound();
      const failure = settled?.find(({ status }) => status === 'rejected');
      if (failure) throw failure.reason;
    });
  }

  /**
   * Wait for attachments to settle, at most attachSettleTimeoutMs. Returns
   * their allSettled results, or null when the wait timed out.
   */
  async _awaitAttachments(attachments, phase) {
    if (!attachments.length) return [];
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(resolve, this._attachSettleTimeoutMs, null);
    });
    const settled = await Promise.race([
      Promise.allSettled(attachments),
      timedOut,
    ]);
    clearTimeout(timer);
    if (!settled)
      console.warn(
        `[Data] layer attachments still running after ${this._attachSettleTimeoutMs} ms; scene ${phase} continues without them`,
      );
    return settled;
  }

  /**
   * Wait until a scene is bound. Resolves true then, or false when the
   * signal aborts or the entry is destroyed. `refresh` marks an explicit
   * refresh, which replaces the entry's deferred periodic one.
   */
  _waitForScene(entry, signal = null, { refresh = false } = {}) {
    if (!this._sceneDetached) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => waiter.settle(false);
      const waiter = {
        entry,
        refresh,
        settle: (bound) => {
          if (!this._sceneWaiters.delete(waiter)) return;
          if (refresh) entry.sceneRefreshWaiters -= 1;
          signal?.removeEventListener?.('abort', onAbort);
          resolve(bound);
        },
      };
      if (refresh) entry.sceneRefreshWaiters += 1;
      this._sceneWaiters.add(waiter);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      for (const listener of [...this._parkListeners]) listener(entry);
    });
  }

  _settleSceneWaiters(bound, entry = null) {
    for (const waiter of [...this._sceneWaiters])
      if (!entry || waiter.entry === entry) waiter.settle(bound);
  }

  /** The entry's queued lifecycle work settled, or is parked for a scene. */
  _lifecycleIdleOrParked(entry) {
    const parked = () =>
      [...this._sceneWaiters].some(
        (waiter) => waiter.entry === entry && !waiter.refresh,
      );
    if (parked()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this._parkListeners.delete(listener);
        resolve();
      };
      const listener = (parkedEntry) => {
        if (parkedEntry === entry && parked()) done();
      };
      this._parkListeners.add(listener);
      entry.toggleChain.catch(() => {}).then(done);
    });
  }

  /**
   * Attach one retained layer to the bound scene. A release that failed on
   * the previous scene is retried first. Asynchronous attachments are tracked
   * so detachScene() releases them only after they stopped.
   */
  _attachEntryRenderer(entry, context) {
    let ready;
    try {
      const pending = this._failedReleases.get(entry);
      entry.sceneDetached = false;
      if (pending) {
        ready = Promise.resolve()
          .then(() => entry.module.detachRenderer(pending.target))
          .then(() => {
            this._failedReleases.delete(entry);
            if (context.signal.aborted) return undefined;
            return entry.module.attachRenderer(context);
          });
      } else ready = entry.module.attachRenderer(context);
    } catch (error) {
      ready = Promise.reject(error);
    }
    const attached = () => {
      if (context.signal.aborted) return;
      entry.module.show?.(entry.enabled);
      const picks = entry.module.picks;
      if (picks) {
        const picking = context.services?.picking;
        picking?.registerPickOwner(
          picks.owner,
          (id) => entry.enabled && picks.predicate(id),
        );
        context.signal.addEventListener(
          'abort',
          () => picking?.unregisterPickOwner(picks.owner),
          { once: true },
        );
      }
      const resumed = context.viewRestored.then(() => {
        if (context.signal.aborted || entry.sceneDetached) return;
        if (entry.module.cameraOwner) return entry.module.cameraOwner.resume();
        return entry.module.resumeViewport?.();
      });
      // Resume failures belong to the switch transaction, including when the
      // camera settles before the switcher starts awaiting its owners.
      resumed.catch(() => {});
      this._viewResumptions.push(resumed);
    };
    if (!ready?.then) return attached();
    ready = Promise.resolve(ready).then(attached);
    const tracked = Promise.resolve(ready);
    this._pendingAttachments.add(tracked);
    const untrack = () => this._pendingAttachments.delete(tracked);
    tracked.then(untrack, untrack);
    return tracked;
  }

  /** Await camera owners after the switcher resolves the incoming view. */
  resumeScene() {
    return Promise.all(this._viewResumptions);
  }

  /** Run the periodic refreshes that came due while no scene was bound. */
  _runDeferredRefreshes() {
    for (const [layerId, entry] of this.layers) {
      if (!entry.refreshDeferred) continue;
      entry.refreshDeferred = false;
      // An explicit refresh waiting for this scene runs instead.
      if (entry.sceneRefreshWaiters > 0) continue;
      void this._runPeriodicUpdate(layerId, entry);
    }
  }
}
