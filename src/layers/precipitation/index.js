import { createImageryStack } from './imagery.js';
import { isNoKeyError } from './model.js';
import {
  FALLBACK_REFRESH_MS,
  LAYER_ID,
  LAYER_TICK_MS,
  OBSERVED_LABEL,
  PRECIPITATION_TIERS,
} from './policy.js';

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
  // Distinct from _lastError on purpose: "the server has no credential" is a
  // standing state an operator can fix, while "the probe failed" may be a
  // passing fault. They read identically from outside and must not be merged.
  let _noKey = false;

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
      // Work out what is actually due. Anything whose frame is still held but
      // whose imagery went away with the globe is simply redrawn — no request,
      // and so nothing billed.
      const due = [];
      let redrawn = 0;
      for (const tier of tiers) {
        // The server owns the cadence — it is tuned against a billable quota —
        // so once a frame has been read, its value wins over the table's.
        const cadence =
          frames.get(tier.id)?.refreshMs ??
          tier.refreshMs ??
          FALLBACK_REFRESH_MS;
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

      // One request per distinct read, all in flight at once, settling
      // independently so one dead source cannot stop the others drawing.
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
      // A missing key is latched separately, and only cleared by a read that
      // succeeds — otherwise the row would flicker between "add a key" and a
      // generic error as ticks failed for different reasons.
      if (refreshed) _noKey = false;
      else if (failure && isNoKeyError(failure)) _noKey = true;
      // An outage only reaches the row when nothing is drawn at all; what it
      // always shows is age, since lastUpdate stops advancing.
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
    source: 'Vaisala Xweather',
    // Tick at the floor, not the refresh cadence: the cadence is a server
    // setting that can change without a rebuild, and the gating above decides
    // whether a tick does any work. A tick with nothing due is a comparison.
    updateInterval: LAYER_TICK_MS,

    init(viewer) {
      if (_viewer)
        throw new Error('Precipitation layer is already initialized');
      _viewer = viewer;
      _enabled = false;
      _hidden = false;
      _lastUpdate = null;
      _lastError = null;
      _noKey = false;
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
      _noKey = false;
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
      _noKey = false;
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
      // There is no keyless mode. Without a credential the layer cannot draw
      // at all, so it says so plainly rather than sitting on an empty globe
      // looking healthy — 'unavailable' is what turns the row red.
      if (_noKey)
        return {
          count: 0,
          lastUpdate: _lastUpdate,
          status: 'unavailable',
          error: 'ADD XWEATHER KEY',
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
        // An imagery layer counts nothing, and an observation has no forecast
        // lead to report, so the slot says what kind of field this is. It also
        // keeps the meta line as short as every other layer's.
        countLabel: OBSERVED_LABEL,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
