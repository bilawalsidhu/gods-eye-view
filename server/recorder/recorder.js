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
  now = () => Date.now(),
}) {
  const store = openHistoryStore(file);
  const keep = createThinner();
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
    if (retentionDays > 0)
      store.purgeBefore(Math.floor(now() / 1000) - retentionDays * 86400);
  }
  const timers = [
    setInterval(() => {
      flush();
      flushEvents();
    }, FLUSH_MS),
    setInterval(purge, PURGE_MS),
  ];
  for (const t of timers) t.unref?.();
  purge();

  return {
    store,
    /** Accepts one point: { id, layer, lat, lon, alt, heading, speed, ts }. */
    ingest(point) {
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
    close() {
      for (const t of timers) clearInterval(t);
      flush();
      flushEvents();
      store.close();
    },
  };
}
