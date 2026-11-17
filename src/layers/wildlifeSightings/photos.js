import { ambientScore } from './cards.js';
import { compareWildlifeIds } from './model.js';
import { WILDLIFE_PHOTO_FETCH, WILDLIFE_PHOTO_CACHE_MAX } from './policy.js';

/** Own decoded ambient images and their cancellable, ranked queue. */
export function createPhotoSlots({
  imageFactory = () => new Image(),
  now = () => Date.now(),
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = (timer) => clearTimeout(timer),
  onChange = null,
} = {}) {
  const slots = new Map();
  let queue = [];
  let timer = null;
  let destroyed = false;
  let liveKeys = new Set();
  let cohortKey = null;

  function notify() {
    if (!destroyed) onChange?.();
  }

  function release(slot) {
    slot.cancelled = true;
    if (!slot.image) return;
    slot.image.onload = null;
    slot.image.onerror = null;
    // Detaching listeners alone would leave pending network and decoded data.
    slot.image.src = '';
  }

  function prune() {
    if (slots.size <= WILDLIFE_PHOTO_CACHE_MAX) return;
    const ranked = [...slots].sort(([a, slotA], [b, slotB]) => {
      const keepA = liveKeys.has(a);
      const keepB = liveKeys.has(b);
      const frameA = slotA.displayed;
      const frameB = slotB.displayed;
      // Decoded photographs that have actually been painted outrank unseen
      // prefetches. Preserve their Image objects for a flash-free return pan.
      return Number(keepA) - Number(keepB) || Number(frameA) - Number(frameB);
    });
    for (const [key, slot] of ranked) {
      if (slots.size <= WILDLIFE_PHOTO_CACHE_MAX) break;
      release(slot);
      slots.delete(key);
    }
  }

  function ensure(row) {
    const url = row?.photo?.square;
    if (!url) return null;
    const key = row.stableId;
    let slot = slots.get(key);
    if (slot && slot.url !== url) {
      release(slot);
      slots.delete(key);
      slot = null;
    }
    if (!slot) {
      slot = {
        key,
        url,
        image: null,
        state: 'queued',
        cancelled: false,
        displayed: false,
      };
    } else slots.delete(key);
    slots.set(key, slot);
    return slot;
  }

  function launch(slot) {
    if (
      destroyed ||
      slot.cancelled ||
      slots.get(slot.key) !== slot ||
      slot.state !== 'queued'
    )
      return;
    slot.state = 'loading';
    let image;
    try {
      image = imageFactory();
      slot.image = image;
      // Deliberately non-CORS: the overlay canvas is display-only and is
      // never read back. Viewport capture reads the separate Cesium canvas.
      image.onload = () => {
        if (destroyed || slot.cancelled || slots.get(slot.key) !== slot) return;
        slot.state = 'ready';
        image.onload = null;
        image.onerror = null;
        notify();
      };
      image.onerror = () => {
        if (destroyed || slot.cancelled || slots.get(slot.key) !== slot) return;
        slot.state = 'error';
        image.onload = null;
        image.onerror = null;
        notify();
      };
      image.src = slot.url;
    } catch {
      slot.state = 'error';
      notify();
    }
  }

  function pace() {
    timer = null;
    if (destroyed) return;
    while (queue.length) {
      const slot = queue.shift();
      if (slot.cancelled || slots.get(slot.key) !== slot) continue;
      launch(slot);
      break;
    }
    if (queue.length) timer = setTimer(pace, WILDLIFE_PHOTO_FETCH.intervalMs);
  }

  function setAmbient(rows) {
    if (destroyed) return;
    const ranked = [...rows].sort(
      (a, b) =>
        ambientScore(b, now()) - ambientScore(a, now()) ||
        compareWildlifeIds(a.stableId, b.stableId),
    );
    const nextKey = JSON.stringify(
      ranked.map((row) => [row.stableId, row.photo?.square]),
    );
    // A same-cohort refresh must not turn the paced tail into another burst.
    if (cohortKey === nextKey) return;
    cohortKey = nextKey;
    clearTimer(timer);
    timer = null;
    liveKeys = new Set(ranked.map((row) => row.stableId));
    queue = ranked.map(ensure).filter(Boolean);
    prune();
    queue = queue.filter(
      (slot) => slots.get(slot.key) === slot && slot.state === 'queued',
    );
    for (
      let index = 0;
      index < WILDLIFE_PHOTO_FETCH.burst && queue.length;
      index++
    )
      launch(queue.shift());
    if (queue.length) timer = setTimer(pace, WILDLIFE_PHOTO_FETCH.intervalMs);
  }

  function get(row) {
    const key = row?.stableId;
    const slot = slots.get(key);
    if (!slot || slot.state !== 'ready') return null;
    slot.displayed = true;
    slots.delete(key);
    slots.set(key, slot);
    return slot.image;
  }

  function clear() {
    clearTimer(timer);
    timer = null;
    queue = [];
    for (const slot of slots.values()) release(slot);
    slots.clear();
    liveKeys.clear();
    cohortKey = null;
  }

  return {
    setAmbient,
    get,
    clear,
    destroy() {
      destroyed = true;
      clear();
    },
    diagnostics: () => ({ slots: slots.size, queued: queue.length }),
  };
}
