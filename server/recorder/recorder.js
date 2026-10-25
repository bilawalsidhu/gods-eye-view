import { cleanFence, createFenceTracker } from './fences.js';
import { createThinner } from './thin.js';
import { openHistoryStore } from './store.js';

const FLUSH_MS = 5000;
const PURGE_MS = 60 * 60 * 1000;
const MAX_BUFFER = 200000;
const MAX_NAMES = 300000;
// A name is saved again this often, so the contact stays findable while seen.
const NAME_REFRESH_SEC = 3600;

/**
 * Buffers thinned positions and writes them in batches.
 * `retentionDays` <= 0 keeps everything. `store` may be any history store
 * (SQLite, or the Postgres one); its methods may return promises.
 */
export function createRecorder({
  file,
  store = openHistoryStore(file),
  retentionDays = 7,
  retentionSec = retentionDays * 86400,
  layers = null,
  maxBytes = 0,
  intervalSec = 30,
  now = () => Date.now(),
}) {
  const keep = createThinner({ minGapSec: intervalSec });
  const wanted = layers ? new Set(layers) : null;
  let buffer = [];
  let eventBuffer = [];
  let nameBuffer = [];
  /** layer:id -> { name, saved } for names already queued or written. */
  const names = new Map();
  const tracker = createFenceTracker();
  const loaded = store.listFences();
  if (Array.isArray(loaded)) tracker.setFences(loaded);
  else loaded.then((f) => tracker.setFences(f)).catch(() => {});

  async function flush() {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    try {
      await store.insertMany(batch);
    } catch (error) {
      buffer = batch.concat(buffer).slice(-MAX_BUFFER);
      throw error;
    }
  }
  async function flushEvents() {
    if (!eventBuffer.length) return;
    const batch = eventBuffer;
    eventBuffer = [];
    try {
      await store.addEvents(batch);
    } catch (error) {
      eventBuffer = batch.concat(eventBuffer).slice(-MAX_BUFFER);
      throw error;
    }
  }
  async function flushNames() {
    if (!nameBuffer.length) return;
    const batch = nameBuffer;
    nameBuffer = [];
    try {
      await store.upsertContacts(batch);
    } catch (error) {
      nameBuffer = batch.concat(nameBuffer).slice(-MAX_BUFFER);
      throw error;
    }
  }
  /** Remembers a callsign or ship name the first time, when it changes, and hourly. */
  function noteName(point) {
    const key = `${point.layer}:${point.id}`;
    const known = names.get(key);
    if (
      known &&
      known.name === point.name &&
      point.ts - known.saved < NAME_REFRESH_SEC
    )
      return;
    names.delete(key);
    names.set(key, { name: point.name, saved: point.ts });
    if (names.size > MAX_NAMES) names.delete(names.keys().next().value);
    nameBuffer.push({
      layer: point.layer,
      id: point.id,
      name: point.name,
      ts: point.ts,
    });
  }
  async function purge() {
    if (retentionSec > 0)
      await store.purgeBefore(Math.floor(now() / 1000) - retentionSec);
  }
  /** Keeps the store under maxBytes by dropping the oldest positions. */
  async function enforceCap() {
    if (!maxBytes) return;
    for (let i = 0; i < 20 && (await store.usedBytes()) > maxBytes; i++)
      if (!(await store.dropOldest(0.1))) break;
  }
  const quiet = (work) => work.catch(() => {});
  const timers = [
    setInterval(() => {
      quiet(flush());
      quiet(flushEvents());
      quiet(flushNames());
      quiet(enforceCap());
    }, FLUSH_MS),
    setInterval(() => quiet(purge()), PURGE_MS),
  ];
  for (const t of timers) t.unref?.();
  quiet(purge());

  return {
    store,
    /** Accepts one point: { id, layer, lat, lon, alt, heading, speed, ts }. */
    ingest(point) {
      if (wanted && !wanted.has(point.layer)) return;
      if (point.name) noteName(point);
      eventBuffer.push(...tracker.check(point));
      if (keep(point)) buffer.push(point);
    },
    /** Fence definitions and their enter/exit events. */
    async addFence(input) {
      const id = await store.addFence(
        cleanFence(input),
        Math.floor(now() / 1000),
      );
      tracker.setFences(await store.listFences());
      return id;
    },
    async removeFence(id) {
      const removed = await store.removeFence(id);
      tracker.setFences(await store.listFences());
      return removed;
    },
    ingestMany(points) {
      for (const p of points) this.ingest(p);
    },
    async flush() {
      await Promise.all([flush(), flushEvents(), flushNames()]);
    },
    enforceCap,
    async close() {
      for (const t of timers) clearInterval(t);
      try {
        await Promise.all([flush(), flushEvents(), flushNames()]);
      } finally {
        await store.close();
      }
    },
  };
}
