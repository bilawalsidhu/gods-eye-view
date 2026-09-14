import { createImageryStack } from './imagery.js';
import { leadLabel } from './model.js';
import { LAYER_ID, MODEL_REFRESH_MS, PRECIPITATION_TIERS } from './policy.js';

export * from './model.js';
export * from './policy.js';
export { createPrecipitationSource } from './source.js';

const MAP_STACK_EVENT = 'gev:map-stack-changed';

/** Read the app's rebroadcast of map-stack changes without importing the controller. */
function windowMapStack() {
  return {
    subscribe(handler) {
      if (typeof window === 'undefined') return () => {};
      window.addEventListener(MAP_STACK_EVENT, handler);
      return () => window.removeEventListener(MAP_STACK_EVENT, handler);
    },
  };
}

/**
 * A photoreal stack hides the globe, taking every imagery layer with it. Read
 * live scene state rather than the event payload: the controller also emits
 * 'switching', where the new stack is not applied yet.
 */
function globeHidden(viewer) {
  return viewer?.scene?.globe?.show === false;
}

/** Own one precipitation display and its frame lifecycle. */
export function createPrecipitationLayer({
  source,
  tiers = PRECIPITATION_TIERS,
  services: { mapStack = windowMapStack() } = {},
} = {}) {
  if (typeof source?.getFrame !== 'function')
    throw new TypeError('Precipitation requires a frame source');

  const stack = createImageryStack();
  const frames = new Map();
  const polledAt = new Map();
  let _viewer = null;
  let _enabled = false;
  let _request = null;
  let _unsubscribe = null;
  let _hidden = false;
  let _lastUpdate = null;
  let _lastError = null;

  // Shared by disable and destroy: an arrow-bound `this` would be undefined in
  // one of the two call paths.
  const clearImagery = (viewer) => {
    stack.clear(viewer || _viewer);
  };

  /**
   * Drop what was read, not just what was drawn.
   *
   * Only teardown does this. A photoreal stack hides the globe and takes the
   * imagery with it, but the frames stay valid for as long as their cadence
   * says — so flipping to Google 3D and back redraws from what is already
   * held instead of re-polling every service on each round trip.
   */
  const forget = () => {
    frames.clear();
    polledAt.clear();
  };

  const runUpdate = async (viewer) => {
    if (!_enabled || !viewer || _hidden) return false;
    _request?.abort();
    const request = new AbortController();
    _request = request;
    const settled = () =>
      request.signal.aborted || _request !== request || !_enabled || _hidden;
    try {
      const now = Date.now();
      // Radar turns over in minutes and the model in hours, so work out what
      // is actually due. Anything whose frame is still held but whose imagery
      // went away with the globe is simply redrawn — no request at all.
      const due = [];
      let redrawn = 0;
      for (const tier of tiers) {
        const cadence = tier.refreshMs ?? MODEL_REFRESH_MS;
        const stale = now - (polledAt.get(tier.id) ?? -Infinity) >= cadence;
        const held = frames.get(tier.id);
        if (stale || !held) {
          due.push(tier);
          continue;
        }
        if (stack.has(tier.id)) continue;
        stack.apply(viewer, tier, held);
        redrawn += 1;
      }

      // One request per capabilities read, all in flight at once. Sequential
      // awaits meant a single dead service threw and every tier listed after
      // it never drew; settling them independently keeps an outage local to
      // the source that has it. Placements resolving to the same capsKey
      // still share one read.
      const reads = new Map();
      for (const tier of due)
        if (!reads.has(tier.capsKey)) reads.set(tier.capsKey, tier);
      const keys = [...reads.keys()];
      const settlements = await Promise.allSettled(
        keys.map((key) =>
          source.getFrame(reads.get(key), { signal: request.signal }),
        ),
      );
      // A late body must never publish into a layer that moved on.
      if (settled()) return false;

      const read = new Map();
      let failure = null;
      settlements.forEach((settlement, index) => {
        if (settlement.status === 'fulfilled')
          read.set(keys[index], settlement.value);
        else failure ??= settlement.reason;
      });

      let refreshed = 0;
      for (const tier of due) {
        const frame = read.get(tier.capsKey);
        // This source is down. The tier keeps whatever it is already drawing
        // and will be due again on the next tick.
        if (!frame) continue;
        polledAt.set(tier.id, now);
        if (!stack.has(tier.id) || frames.get(tier.id)?.key !== frame.key) {
          // Add before removing so a live tier never blinks through the base map.
          stack.apply(viewer, tier, frame);
          frames.set(tier.id, frame);
        }
        refreshed += 1;
      }

      if (refreshed || redrawn) _lastUpdate = Date.now();
      // One source failing among many is a gap in coverage, not a broken
      // layer, so it only reaches the row when nothing is drawn at all. What
      // an outage does show is age: lastUpdate stops advancing.
      _lastError = stack.size ? null : failure?.message || _lastError;
      // A tick with nothing due is a healthy tick, not a failed refresh.
      return stack.size > 0 || due.length === 0;
    } catch (error) {
      if (settled()) return false;
      _lastError = error?.message || 'Precipitation source unavailable';
      return false;
    } finally {
      if (_request === request) _request = null;
    }
  };

  const syncGlobeVisibility = () => {
    if (!_enabled || !_viewer) return;
    const hidden = globeHidden(_viewer);
    if (hidden === _hidden) return;
    _hidden = hidden;
    if (hidden) clearImagery(_viewer);
    else void runUpdate(_viewer);
  };

  const layer = {
    id: LAYER_ID,
    name: 'Precipitation',
    icon: '🌧',
    source: 'ECCC GDPS · IEM NEXRAD',
    // Poll at the shortest tier cadence; each tier then refreshes on its own.
    updateInterval: Math.min(
      ...tiers.map((tier) => tier.refreshMs ?? MODEL_REFRESH_MS),
    ),

    init(viewer) {
      if (_viewer)
        throw new Error('Precipitation layer is already initialized');
      _viewer = viewer;
      _enabled = false;
      _hidden = false;
      _lastUpdate = null;
      _lastError = null;
      console.log('[Data:Precipitation] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      _viewer = viewer || _viewer;
      _hidden = globeHidden(_viewer);
      // No continuous-render hold: imagery tiles drive their own redraws, so
      // the layer has no per-frame animator to keep the render loop alive for.
      _unsubscribe ??= mapStack.subscribe(syncGlobeVisibility);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _unsubscribe?.();
      _unsubscribe = null;
      clearImagery(viewer);
      forget();
      _lastError = null;
    },

    async update(viewer) {
      return runUpdate(viewer || _viewer);
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _unsubscribe?.();
      _unsubscribe = null;
      clearImagery(viewer);
      forget();
      _viewer = null;
      _hidden = false;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      // The globe is gone in photoreal, so the toggle must not read as healthy.
      if (_hidden)
        return {
          count: 0,
          lastUpdate: _lastUpdate,
          status: 'unavailable',
          error: 'GLOBE HIDDEN IN 3D',
        };
      const primary =
        tiers.find(
          (entry) => entry.role === 'primary' && frames.has(entry.id),
        ) ||
        tiers.find((entry) => frames.has(entry.id)) ||
        null;
      const frame = primary ? frames.get(primary.id) : null;
      if (!frame)
        return { count: 0, lastUpdate: _lastUpdate, error: _lastError };
      return {
        count: 0,
        // An imagery layer counts nothing. The forecast lead goes in the count
        // slot because it is the one number that says how much to trust the
        // field, and it keeps the meta line as short as every other layer's.
        countLabel: leadLabel(frame),
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
