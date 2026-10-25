import { cleanFence, createFenceTracker } from './fences.js';
import { createThinner } from './thin.js';
import { openHistoryStore } from './store.js';

const FLUSH_MS = 5000;
const PURGE_MS = 60 * 60 * 1000;

/**
 * Buffers thinned positions and writes them in batches.
 * `retentionDays` <= 0 keeps everything.
 */
export function createRecorder({
  file,
  retentionDays = 7,
  retentionSec = retentionDays * 86400,
  layers = null,
  maxBytes = 0,
  intervalSec = 30,
  now = () => Date.now(),
}) {
  const store = openHistoryStore(file);
  const keep = createThinner({ minGapSec: intervalSec });
  const wanted = layers ? new Set(layers) : null;
  let buffer = [];
  let eventBuffer = [];
  const tracker = createFenceTracker();
  tracker.setFences(store.listFences());

  function flush() {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    store.insertMany(batch);
  }
  function flushEvents() {
    if (!eventBuffer.length) return;
    const batch = eventBuffer;
    eventBuffer = [];
    store.addEvents(batch);
  }
  function purge() {
    if (retentionSec > 0)
      store.purgeBefore(Math.floor(now() / 1000) - retentionSec);
  }
  /** Keeps the file under maxBytes by dropping the oldest positions. */
  function enforceCap() {
    if (!maxBytes) return;
    for (let i = 0; i < 20 && store.usedBytes() > maxBytes; i++)
      if (!store.dropOldest(0.1)) break;
  }
  const timers = [
    setInterval(() => {
      flush();
      flushEvents();
      enforceCap();
    }, FLUSH_MS),
    setInterval(purge, PURGE_MS),
  ];
  for (const t of timers) t.unref?.();
  purge();

  return {
    store,
    /** Accepts one point: { id, layer, lat, lon, alt, heading, speed, ts }. */
    ingest(point) {
      if (wanted && !wanted.has(point.layer)) return;
      eventBuffer.push(...tracker.check(point));
      if (keep(point)) buffer.push(point);
    },
    /** Fence definitions and their enter/exit events. */
    addFence(input) {
      const id = store.addFence(cleanFence(input), Math.floor(now() / 1000));
      tracker.setFences(store.listFences());
      return id;
    },
    removeFence(id) {
      const removed = store.removeFence(id);
      tracker.setFences(store.listFences());
      return removed;
    },
    ingestMany(points) {
      for (const p of points) this.ingest(p);
    },
    flush() {
      flush();
      flushEvents();
    },
    enforceCap,
    close() {
      for (const t of timers) clearInterval(t);
      flush();
      flushEvents();
      store.close();
    },
  };
}
