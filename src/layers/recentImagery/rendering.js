/**
 * Draped-imagery renderer for the Recent Imagery layer: at most two GIBS
 * imagery layers (slot `a`, left of a swipe; slot `b`, right) on whichever
 * host the map stack offers. Against the basemap slot `a` splits left and
 * slot `b` stays empty. Every layer is removed from the collection that owns it, so a
 * host switch or a replaced image never strands one. Tile requests pass a
 * small semaphore of our own; Cesium's global request limits stay untouched.
 */
import * as Cesium from 'cesium';
import { PRODUCTS, gibsTemplate } from './model.js';

const SLOT_IDS = ['a', 'b'];
const SPLIT_ENUM = { left: 'LEFT', right: 'RIGHT', none: 'NONE' };
const NO_HOST = Object.freeze({ collection: null, kind: 'none' });

/** Render reason for a deferred or settled tile request. */
export const TILE_RENDER_REASON = 'recent-imagery-tiles';
/** Delay before the one frame that retries tiles Cesium itself deferred. */
export const TILE_RETRY_DELAY_MS = 250;

function clampAlpha(value) {
  const alpha = Number(value);
  return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
}

const boxKey = (box) =>
  [box.west, box.south, box.east, box.north].map(Number).join(',');

/**
 * Gate a provider's `requestImage` through the semaphore. Returning
 * `undefined` tells Cesium to retry on a later frame, but under
 * `requestRenderMode` there is no later frame unless something asks — and a
 * deferral must never ask for one itself: the retried tile would defer again
 * and ask again, keeping the scene rendering every frame. So a request that
 * finds our semaphore full asks for nothing (the request holding the slot
 * asks for one frame when it settles), and a request the provider itself
 * deferred goes through the one coalesced delayed retry.
 */
function admitTileRequests(provider, admission, requestRender, retry) {
  const original = provider.requestImage.bind(provider);
  provider.requestImage = (x, y, level, request) => {
    if (admission.inFlight >= admission.limit) return undefined;
    admission.inFlight += 1;
    const release = () => {
      admission.inFlight -= 1;
    };
    let promise;
    try {
      promise = original(x, y, level, request);
    } catch (error) {
      release();
      throw error;
    }
    if (!promise) {
      release();
      retry.schedule();
      return undefined;
    }
    return Promise.resolve(promise).finally(() => {
      release();
      requestRender(TILE_RENDER_REASON);
    });
  };
  return provider;
}

/**
 * Create the renderer.
 * @param {{ cesium?: object, maxTileRequests?: number, requestRender?: (reason: string) => void, setTimeoutImpl?: Function, clearTimeoutImpl?: Function }} [options]
 */
export function createRecentImageryRenderer({
  cesium = Cesium,
  maxTileRequests = 6,
  requestRender = () => {},
  setTimeoutImpl = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutImpl = (id) => globalThis.clearTimeout(id),
} = {}) {
  let host = NO_HOST;
  let destroyed = false;
  const admission = { limit: maxTileRequests, inFlight: 0 };
  /** @type {Record<'a'|'b', null | { layer: object, collection: object, candidate: object, box: object, alpha: number, split: string }>} */
  const owned = { a: null, b: null };

  // One timer for both slots: any number of upstream deferrals while it is
  // armed share the same single retry frame.
  let retryTimer = null;
  const retry = {
    schedule() {
      if (retryTimer !== null) return;
      retryTimer = setTimeoutImpl(() => {
        retryTimer = null;
        if (!destroyed) requestRender(TILE_RENDER_REASON);
      }, TILE_RETRY_DELAY_MS);
    },
    cancel() {
      if (retryTimer !== null) clearTimeoutImpl(retryTimer);
      retryTimer = null;
    },
  };

  function createProvider(candidate, box) {
    const spec = PRODUCTS[candidate.product];
    const provider = new cesium.UrlTemplateImageryProvider({
      url: gibsTemplate(candidate.product, candidate.day),
      subdomains: ['a', 'b', 'c'],
      minimumLevel: 0,
      maximumLevel: spec.maxLevel,
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      rectangle: cesium.Rectangle.fromDegrees(
        box.west,
        box.south,
        box.east,
        box.north,
      ),
      credit: 'NASA GIBS',
      hasAlphaChannel: spec.format === 'png',
    });
    return admitTileRequests(provider, admission, requestRender, retry);
  }

  function removeOwned(slotId) {
    const record = owned[slotId];
    if (!record) return false;
    owned[slotId] = null;
    try {
      record.collection.remove(record.layer, true);
    } catch {
      /* the collection is already gone */
    }
    return true;
  }

  function applyLook(record) {
    record.layer.alpha = record.alpha;
    record.layer.splitDirection =
      cesium.SplitDirection?.[SPLIT_ENUM[record.split] || 'NONE'] ?? 0;
  }

  function mount(slotId, { candidate, box, alpha, split }) {
    const layer = host.collection.addImageryProvider(
      createProvider(candidate, box),
    );
    owned[slotId] = {
      layer,
      collection: host.collection,
      candidate,
      box,
      alpha,
      split,
    };
    applyLook(owned[slotId]);
  }

  return {
    /**
     * Drape a candidate into a slot. The same candidate on the same host only
     * updates its look; anything else replaces the slot's layer.
     * @param {'a'|'b'} slotId
     * @param {object} candidate
     * @param {object} box Degrees box.
     * @param {{ alpha?: number, splitDirection?: 'left'|'right'|'none' }} [look]
     * @returns {boolean} Whether a layer is now draped for the slot.
     */
    showSlot(
      slotId,
      candidate,
      box,
      { alpha = 1, splitDirection = 'none' } = {},
    ) {
      if (destroyed || !candidate?.key || !box) return false;
      if (!host.collection) {
        removeOwned(slotId);
        return false;
      }
      const current = owned[slotId];
      const look = { alpha: clampAlpha(alpha), split: splitDirection };
      if (
        current &&
        current.collection === host.collection &&
        current.candidate.key === candidate.key &&
        boxKey(current.box) === boxKey(box)
      ) {
        if (current.alpha !== look.alpha || current.split !== look.split) {
          Object.assign(current, look);
          applyLook(current);
          requestRender('recent-imagery-look');
        }
        return true;
      }
      removeOwned(slotId);
      mount(slotId, { candidate, box, ...look });
      requestRender('recent-imagery-show');
      return true;
    },

    /** @param {'a'|'b'} slotId */
    hideSlot(slotId) {
      if (removeOwned(slotId)) requestRender('recent-imagery-hide');
    },

    /**
     * @param {'a'|'b'} slotId
     * @param {number} alpha 0–1
     */
    setAlpha(slotId, alpha) {
      const record = owned[slotId];
      const next = clampAlpha(alpha);
      if (!record || record.alpha === next) return;
      record.alpha = next;
      applyLook(record);
      requestRender('recent-imagery-alpha');
    },

    /**
     * Move every owned layer to a new host. Layers are rebuilt there, never
     * re-parented, so the old collection is left as it was found.
     * @param {{ collection: object | null, kind: string }} nextHost
     */
    rebind(nextHost) {
      host = nextHost || NO_HOST;
      let changed = false;
      for (const slotId of SLOT_IDS) {
        const record = owned[slotId];
        if (!record || record.collection === host.collection) continue;
        removeOwned(slotId);
        changed = true;
        if (host.collection && !destroyed) mount(slotId, record);
      }
      if (changed) requestRender('recent-imagery-rebind');
    },

    /** What is draped right now, per slot. */
    getOwned() {
      const out = {};
      for (const slotId of SLOT_IDS) {
        const record = owned[slotId];
        out[slotId] = record
          ? {
              key: record.candidate.key,
              kind: host.kind,
              alpha: record.alpha,
              split: record.split,
            }
          : null;
      }
      return out;
    },

    /** Number of layers this renderer owns (never above two). */
    ownedCount() {
      return SLOT_IDS.filter((slotId) => owned[slotId]).length;
    },

    /** Remove everything and refuse further work. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      retry.cancel();
      let changed = false;
      for (const slotId of SLOT_IDS) changed = removeOwned(slotId) || changed;
      host = NO_HOST;
      if (changed) requestRender('recent-imagery-destroy');
    },
  };
}
