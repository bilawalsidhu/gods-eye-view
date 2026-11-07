import { createEmergencyWatcher } from './alerts.js';
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
  // Opens the store again after a failed write (a drive that was unplugged).
  reopen = null,
  retentionDays = 7,
  retentionSec = retentionDays * 86400,
  layers = null,
  maxBytes = 0,
  intervalSec = 30,
  now = () => Date.now(),
}) {
  /** How writing is going: a drive can be pulled out while recording. */
  const health = {
    ok: true,
    since: Math.floor(now() / 1000),
    error: '',
    failures: 0,
  };
  let lastReopen = 0;
  const markFailed = (error) => {
    if (health.ok) health.since = Math.floor(now() / 1000);
    health.ok = false;
    health.failures += 1;
    health.error = String(error?.message ?? error).slice(0, 200);
  };
  const markWorking = () => {
    if (!health.ok) health.since = Math.floor(now() / 1000);
    health.ok = true;
    health.failures = 0;
    health.error = '';
  };
  const waiting = () =>
    buffer.length + eventBuffer.length + nameBuffer.length + alertBuffer.length;
  const keep = createThinner({ minGapSec: intervalSec });
  let wanted = layers ? new Set(layers) : null;
  let buffer = [];
  let eventBuffer = [];
  let nameBuffer = [];
  let alertBuffer = [];
  const emergencies = createEmergencyWatcher();
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
      markWorking();
    } catch (error) {
      buffer = batch.concat(buffer).slice(-MAX_BUFFER);
      markFailed(error);
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
  async function flushAlerts() {
    if (!alertBuffer.length) return;
    const batch = alertBuffer;
    alertBuffer = [];
    try {
      await store.addAlerts(batch);
    } catch (error) {
      alertBuffer = batch.concat(alertBuffer).slice(-MAX_BUFFER);
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
  /** After repeated failed writes, try to open the store again, at most every 15 s. */
  async function maybeReopen() {
    if (!reopen || health.ok || health.failures < 2) return;
    if (Date.now() - lastReopen < 15000) return;
    lastReopen = Date.now();
    const fresh = await reopen();
    const old = store;
    store = fresh;
    try {
      await old.close();
    } catch {
      // The old handle was on a drive that is gone.
    }
  }
  const timers = [
    setInterval(() => {
      quiet(flush());
      quiet(flushEvents());
      quiet(flushNames());
      quiet(flushAlerts());
      quiet(enforceCap());
      quiet(maybeReopen());
    }, FLUSH_MS),
    setInterval(() => quiet(purge()), PURGE_MS),
  ];
  for (const t of timers) t.unref?.();
  quiet(purge());

  return {
    get store() {
      return store;
    },
    /** Whether writing works, since when, and how many points are waiting. */
    health: () => ({ ...health, waiting: waiting() }),
    /**
     * Moves recording to another store, which must already hold everything the
     * old one did. The old store is returned for the caller to close.
     */
    async switchStore(next) {
      // Swap at once: points that arrive meanwhile, and what is still
      // buffered, are written to the new store.
      const old = store;
      store = next;
      markWorking();
      tracker.setFences(await next.listFences());
      return old;
    },
    /** What the recorder is using now. */
    settings: () => ({
      retentionSec,
      maxBytes,
      intervalSec,
      layers: wanted ? [...wanted] : null,
    }),
    /** Changes settings from now on: { retentionSec, maxBytes, intervalSec, layers }. */
    configure(patch) {
      if (patch.retentionSec !== undefined) retentionSec = patch.retentionSec;
      if (patch.maxBytes !== undefined) maxBytes = patch.maxBytes;
      if (patch.intervalSec !== undefined) {
        intervalSec = patch.intervalSec;
        keep.setMinGap(intervalSec);
      }
      if (patch.layers !== undefined) wanted = new Set(patch.layers);
    },
    /** Accepts one point: { id, layer, lat, lon, alt, heading, speed, ts }. */
    ingest(point) {
      if (wanted && !wanted.has(point.layer)) return;
      if (point.name) noteName(point);
      const alert = emergencies(point);
      if (alert) alertBuffer.push(alert);
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
      await Promise.all([flush(), flushEvents(), flushNames(), flushAlerts()]);
    },
    enforceCap,
    async close() {
      for (const t of timers) clearInterval(t);
      try {
        await Promise.all([
          flush(),
          flushEvents(),
          flushNames(),
          flushAlerts(),
        ]);
      } finally {
        await store.close();
      }
    },
  };
}
