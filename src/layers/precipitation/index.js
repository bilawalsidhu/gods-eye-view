import { createImageryStack } from './imagery.js';
import { frameMessage, inlayMessage, leadLabel } from './model.js';
import {
  LAYER_ID,
  PRECIPITATION_TIERS,
  REFRESH_INTERVAL_MS,
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
    frames.clear();
  };

  const runUpdate = async (viewer) => {
    if (!_enabled || !viewer || _hidden) return false;
    _request?.abort();
    const request = new AbortController();
    _request = request;
    const settled = () =>
      request.signal.aborted || _request !== request || !_enabled || _hidden;
    try {
      let applied = 0;
      // Placements that read the same service and layer share one request.
      const fetched = new Map();
      for (const tier of tiers) {
        let frame = fetched.get(tier.frameKey);
        if (!frame) {
          frame = await source.getFrame(tier, { signal: request.signal });
          // A late body must never publish into a layer that moved on.
          if (settled()) return false;
          fetched.set(tier.frameKey, frame);
        }
        if (frames.get(tier.id)?.key !== frame.key) {
          // Add before removing so a live tier never blinks through the base map.
          stack.apply(viewer, tier, frame);
          frames.set(tier.id, frame);
        }
        applied += 1;
      }
      _lastUpdate = Date.now();
      _lastError = null;
      return applied > 0;
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
    updateInterval: REFRESH_INTERVAL_MS,

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
      const inlay = tiers.find(
        (entry) => entry.role === 'inlay' && frames.has(entry.id),
      );
      return {
        count: 0,
        // An imagery layer counts nothing; the forecast lead is the number that
        // tells a reader how much to trust the field.
        countLabel: leadLabel(frame),
        lastUpdate: _lastUpdate,
        error: _lastError,
        // 'idle' is a guidance status, so naming the frame cannot redden the chip.
        status: _lastError ? undefined : 'idle',
        statusMessage: [
          frameMessage(primary, frame),
          inlay && inlayMessage(inlay, frames.get(inlay.id)),
        ]
          .filter(Boolean)
          .join(' · '),
      };
    },
  };
  return layer;
}
