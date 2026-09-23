/**
 * Thumbnail loader for the Recent Imagery strip: one Worldview snapshot per
 * candidate day. The response's `Data-Present` header is the only proof that
 * a day has pixels in the box (GIBS answers an empty tile with HTTP 200), and
 * `Acquisition-Time` carries the sensing time. Fetches are bounded, and so
 * are decoded images: residency is least-recently-USED, where a request or a
 * completed decode is a use and a `get` read never is (the panel reads every
 * card on every render, so a read that counted would evict the visible cards
 * first). Eviction revokes the image only; what the probe proved is kept.
 */
import { thumbnailOrder, wvsSnapshotUrl } from './model.js';

const EMPTY = Object.freeze({
  status: 'unknown',
  objectUrl: null,
  acquisitionTime: null,
  loading: false,
});

/**
 * @param {{ fetchImpl?: typeof fetch, maxInFlight?: number, maxDecoded?: number, createObjectUrl?: (blob: Blob) => string, revokeObjectUrl?: (url: string) => void, size?: number }} [options]
 */
export function createThumbnailLoader({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  maxInFlight = 3,
  maxDecoded = 16,
  createObjectUrl = (blob) => URL.createObjectURL(blob),
  revokeObjectUrl = (url) => URL.revokeObjectURL(url),
  size = 256,
} = {}) {
  const limit = Math.max(1, Math.trunc(maxInFlight) || 1);
  const resident = Math.max(1, Math.trunc(maxDecoded) || 1);
  const entries = new Map();
  const listeners = new Set();
  const queue = [];
  let inFlight = 0;
  let touchCounter = 0;
  let destroyed = false;

  function notify(key) {
    for (const listener of [...listeners]) {
      try {
        listener(key);
      } catch (error) {
        console.warn('[Data:RecentImagery] thumbnail listener failed:', error);
      }
    }
  }

  function touch(entry) {
    touchCounter += 1;
    entry.touched = touchCounter;
  }

  function revokeImage(entry) {
    if (!entry.objectUrl) return;
    try {
      revokeObjectUrl(entry.objectUrl);
    } catch {
      /* a revoked URL is already gone */
    }
    entry.objectUrl = null;
  }

  function evictDecoded(keep) {
    const decoded = [...entries.values()]
      .filter((entry) => entry.objectUrl && entry !== keep)
      .sort((a, b) => a.touched - b.touched);
    let count = decoded.length + (keep?.objectUrl ? 1 : 0);
    for (const entry of decoded) {
      if (count <= resident) break;
      revokeImage(entry);
      notify(entry.key);
      count -= 1;
    }
  }

  function enqueue(entry) {
    if (!queue.includes(entry)) queue.push(entry);
    pump();
  }

  async function run(entry) {
    const controller = new AbortController();
    entry.controller = controller;
    entry.loading = true;
    inFlight += 1;
    let status = 'error';
    let objectUrl = null;
    let acquisitionTime = null;
    let cancelled = false;
    try {
      const url = wvsSnapshotUrl({
        product: entry.candidate.product,
        day: entry.candidate.day,
        box: entry.box,
        width: size,
        height: size,
      });
      const response = await fetchImpl(url, { signal: controller.signal });
      if (controller.signal.aborted) {
        cancelled = true;
      } else if (response?.ok) {
        const present = String(
          response.headers?.get?.('Data-Present') ?? 'true',
        ).toLowerCase();
        acquisitionTime = response.headers?.get?.('Acquisition-Time') || null;
        if (present === 'false') {
          status = 'empty';
        } else {
          const blob = await response.blob();
          if (controller.signal.aborted) cancelled = true;
          else {
            objectUrl = createObjectUrl(blob);
            status = 'present';
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError')
        cancelled = true;
      else status = 'error';
    } finally {
      inFlight -= 1;
      entry.loading = false;
      entry.controller = null;
    }
    // Every settlement frees a slot, so a cancelled fetch pumps too.
    if (cancelled || destroyed || entries.get(entry.key) !== entry) {
      if (objectUrl) revokeObjectUrl(objectUrl);
      pump();
      return;
    }
    // A failed re-fetch of an evicted image keeps what the day proved.
    if (status !== 'error' || entry.status !== 'present') {
      entry.status = status;
      entry.acquisitionTime = acquisitionTime;
    }
    entry.objectUrl = objectUrl;
    touch(entry);
    if (objectUrl) evictDecoded(entry);
    notify(entry.key);
    pump();
  }

  function pump() {
    if (destroyed) return;
    queue.sort((a, b) => a.priority - b.priority);
    while (inFlight < limit && queue.length) {
      const entry = queue.shift();
      if (entries.get(entry.key) !== entry) continue;
      void run(entry);
    }
  }

  return {
    /**
     * Ask for one candidate's thumbnail. Lower priority loads sooner. A day
     * already known is only touched (and re-prioritised while it waits); a
     * known-present day whose image was evicted is fetched again.
     * @param {object} candidate
     * @param {object} box Degrees box.
     * @param {number} [priority]
     */
    request(candidate, box, priority = 0) {
      if (destroyed || !candidate?.key || !box) return;
      const key = candidate.key;
      const existing = entries.get(key);
      if (existing) {
        touch(existing);
        if (existing.loading) return;
        if (existing.status === 'unknown') {
          existing.priority = priority;
        } else if (existing.status === 'present' && !existing.objectUrl) {
          existing.priority = priority;
          enqueue(existing);
        }
        return;
      }
      const entry = {
        key,
        candidate,
        box,
        priority,
        status: 'unknown',
        objectUrl: null,
        acquisitionTime: null,
        loading: false,
        controller: null,
        touched: 0,
      };
      touch(entry);
      entries.set(key, entry);
      enqueue(entry);
    },

    /**
     * Request the visible window of a strip in `thumbnailOrder` priority.
     * @param {Array<object>} candidates
     * @param {object} box
     * @param {{ focusIndex: number, firstVisible: number, lastVisible: number, extra?: number }} window
     */
    requestOrdered(
      candidates,
      box,
      { focusIndex, firstVisible, lastVisible, extra },
    ) {
      const order = thumbnailOrder(
        focusIndex,
        firstVisible,
        lastVisible,
        candidates.length,
        extra,
      );
      order.forEach((index, priority) => {
        this.request(candidates[index], box, priority);
      });
    },

    /**
     * Abort every fetch in flight and forget every unsettled request. A
     * known day whose image was being fetched again keeps what it knows.
     */
    cancelAll() {
      queue.length = 0;
      for (const entry of [...entries.values()]) {
        if (entry.loading) entry.controller?.abort();
        if (entry.status === 'unknown') entries.delete(entry.key);
      }
    },

    /** Cancel everything and revoke every decoded thumbnail. */
    clear() {
      this.cancelAll();
      for (const entry of entries.values()) revokeImage(entry);
      entries.clear();
    },

    /**
     * Read a day's state. A read is not a use: it never changes residency.
     * @param {string} key Candidate key.
     * @returns {{ status: 'unknown'|'present'|'empty'|'error', objectUrl: string | null, acquisitionTime: string | null, loading: boolean }}
     */
    get(key) {
      const entry = entries.get(key);
      if (!entry) return EMPTY;
      return {
        status: entry.status,
        objectUrl: entry.objectUrl,
        acquisitionTime: entry.acquisitionTime,
        loading: entry.loading,
      };
    },

    /** @param {(key: string) => void} listener */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    stats() {
      return {
        inFlight,
        queued: queue.length,
        decoded: [...entries.values()].filter((entry) => entry.objectUrl)
          .length,
        tracked: entries.size,
      };
    },

    destroy() {
      if (destroyed) return;
      this.clear();
      destroyed = true;
      listeners.clear();
    },
  };
}
