import { validTransitIdentifier } from './transitHistory.js';
export { validTransitIdentifier } from './transitHistory.js';
/** Bounded, process-local operator position history. No upstream or scene access. */
export const TRANSIT_HISTORY_LIMITS = Object.freeze({
  retentionMs: 900000,
  fixes: 128,
  feedBytes: 16 * 1024 * 1024,
  processBytes: 64 * 1024 * 1024,
  keys: 15000,
  identifierBytes: 256,
  responseBytes: 32768,
});
const FIX_BYTES = 32,
  CHUNK = 8,
  EPOCH_SLOTS = 8,
  EPOCH_BYTES = 544;
const META_BYTES = 64;
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
// All stores in this process share the hard process allocation ceiling.
const processStorage = { bytes: 0, keys: 0, stores: new Set() };

function contextOf(record, mode) {
  const trip = typeof record.tripId === 'string' ? record.tripId : '';
  const route = typeof record.routeId === 'string' ? record.routeId : '';
  if (encoder.encode(trip).length > 256 || encoder.encode(route).length > 256)
    return null;
  return { trip, route, mode: mode || 'unknown' };
}
function contextAt(entry, slot) {
  const offset = 0,
    view = entry.contexts[slot];
  const bytes = new Uint8Array(view.buffer);
  const length = view.getUint16(offset + 4),
    routeLength = view.getUint16(offset + 6);
  return {
    id: view.getUint32(offset),
    trip: decoder.decode(bytes.subarray(offset + 16, offset + 16 + length)),
    route: decoder.decode(
      bytes.subarray(offset + 272, offset + 272 + routeLength),
    ),
    mode: decoder.decode(
      bytes.subarray(offset + 528, offset + 528 + view.getUint8(offset + 8)),
    ),
  };
}
function storeContext(entry, context, id) {
  const slot = (id - 1) % EPOCH_SLOTS,
    offset = 0;
  const trip = encoder.encode(context.trip),
    route = encoder.encode(context.route),
    mode = encoder.encode(context.mode).subarray(0, 16);
  const view = entry.contexts[slot],
    bytes = new Uint8Array(view.buffer);
  view.setUint32(offset, id);
  view.setUint16(offset + 4, trip.length);
  view.setUint16(offset + 6, route.length);
  view.setUint8(offset + 8, mode.length);
  bytes.set(trip, offset + 16);
  bytes.set(route, offset + 272);
  bytes.set(mode, offset + 528);
}
function offset(entry, index) {
  return ((entry.head + index) % entry.capacity) * FIX_BYTES;
}
function read(entry, index) {
  const at = offset(entry, index),
    v = entry.fixes;
  return [
    v.getFloat64(at),
    v.getFloat64(at + 8),
    v.getFloat64(at + 16),
    v.getUint32(at + 24),
    v.getUint32(at + 28),
  ];
}
function firstTime(entry) {
  return entry.count ? entry.fixes.getFloat64(offset(entry, 0)) : Infinity;
}
function drop(entry) {
  entry.head = (entry.head + 1) % entry.capacity;
  entry.count--;
  entry.truncated = true;
}

// Indexed eviction queues keep removal and receipt-order updates logarithmic.
function evictionQueue() {
  const items = [],
    positions = new Map();
  const less = (a, b) =>
    a.observedAt < b.observedAt ||
    (a.observedAt === b.observedAt && a.key < b.key);
  function swap(a, b) {
    [items[a], items[b]] = [items[b], items[a]];
    positions.set(items[a], a);
    positions.set(items[b], b);
  }
  function repair(index) {
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!less(items[index], items[parent])) break;
      swap(index, parent);
      index = parent;
    }
    for (;;) {
      let child = index * 2 + 1;
      if (child >= items.length) break;
      if (child + 1 < items.length && less(items[child + 1], items[child]))
        child++;
      if (!less(items[child], items[index])) break;
      swap(index, child);
      index = child;
    }
  }
  function remove(entry) {
    const index = positions.get(entry);
    if (index === undefined) return;
    positions.delete(entry);
    const last = items.pop();
    if (index < items.length) {
      items[index] = last;
      positions.set(last, index);
      repair(index);
    }
  }
  return {
    remove,
    add(entry) {
      remove(entry);
      positions.set(entry, items.length);
      items.push(entry);
      repair(items.length - 1);
    },
    oldest(except) {
      if (items[0] !== except) return items[0] || null;
      if (!items[1]) return null;
      return items[2] && less(items[2], items[1]) ? items[2] : items[1];
    },
    get size() {
      return items.length;
    },
  };
}

export function createTransitHistory({
  limits = {},
  storage = processStorage,
  sweep = true,
} = {}) {
  const policy = { ...TRANSIT_HISTORY_LIMITS };
  for (const [key, limit] of Object.entries(limits))
    if (key in policy && Number.isFinite(limit) && limit > 0)
      policy[key] = Math.min(policy[key], Math.floor(limit));
  const entries = new Map(),
    feedBytes = new Map(),
    eviction = evictionQueue(),
    feedEviction = new Map();
  storage.feedBytes ||= new Map();
  storage.lossUntil ||= new Map();
  let protectedEntries = null;
  function queue(entry) {
    if (!feedEviction.has(entry.feed))
      feedEviction.set(entry.feed, evictionQueue());
    eviction.add(entry);
    feedEviction.get(entry.feed).add(entry);
  }
  function unqueue(entry) {
    eviction.remove(entry);
    const feedQueue = feedEviction.get(entry.feed);
    feedQueue?.remove(entry);
    if (feedQueue?.size === 0) feedEviction.delete(entry.feed);
  }
  function recordLoss(feed, until) {
    storage.lossUntil.set(
      feed,
      Math.max(storage.lossUntil.get(feed) || 0, until),
    );
  }
  let prunedAt = -Infinity;
  let allocatedBytes = 0,
    timer = null,
    closed = false;
  function account(feed, delta) {
    allocatedBytes += delta;
    storage.bytes += delta;
    storage.feedBytes.set(feed, (storage.feedBytes.get(feed) || 0) + delta);
    if (storage.feedBytes.get(feed) === 0) storage.feedBytes.delete(feed);
    feedBytes.set(feed, (feedBytes.get(feed) || 0) + delta);
    if (feedBytes.get(feed) === 0) feedBytes.delete(feed);
  }
  function remove(entry) {
    unqueue(entry);
    entries.delete(entry.key);
    storage.keys--;
    account(entry.feed, -entry.bytes);
  }
  function canAllocate(feed, bytes) {
    return (
      storage.bytes + bytes <= policy.processBytes &&
      (storage.feedBytes.get(feed) || 0) + bytes <= policy.feedBytes
    );
  }
  function resize(entry, capacity) {
    const next = new Uint8Array(capacity * FIX_BYTES),
      before = new Uint8Array(entry.fixes.buffer);
    for (let i = 0; i < entry.count; i++)
      next.set(
        before.subarray(offset(entry, i), offset(entry, i) + FIX_BYTES),
        i * FIX_BYTES,
      );
    const delta = next.byteLength - entry.fixes.byteLength;
    entry.fixes = new DataView(next.buffer);
    entry.head = 0;
    entry.capacity = capacity;
    entry.bytes += delta;
    account(entry.feed, delta);
  }
  function prune(now) {
    if (now === prunedAt) return;
    prunedAt = now;
    for (const [feed, until] of storage.lossUntil)
      if (until <= now) storage.lossUntil.delete(feed);
    for (const entry of entries.values()) {
      while (entry.count && firstTime(entry) < now - policy.retentionMs)
        drop(entry);
      if (!entry.count || now - entry.observedAt >= policy.retentionMs)
        remove(entry);
      else if (
        entry.capacity > CHUNK &&
        entry.count <= entry.capacity / 2 &&
        canAllocate(
          entry.feed,
          Math.max(CHUNK, Math.ceil(entry.count / CHUNK) * CHUNK) * FIX_BYTES,
        )
      )
        resize(entry, Math.max(CHUNK, Math.ceil(entry.count / CHUNK) * CHUNK));
    }
  }
  function oldest(feed = null, except = null) {
    return (feed ? feedEviction.get(feed) : eviction)?.oldest(except) || null;
  }
  function evictOne(feed = null, except = null) {
    const entry = oldest(feed, except);
    if (!entry) return false;
    recordLoss(entry.feed, entry.observedAt + policy.retentionMs);
    if (entry.count > CHUNK) {
      const target = Math.max(CHUNK, entry.capacity - CHUNK);
      if (!canAllocate(entry.feed, target * FIX_BYTES)) {
        remove(entry);
        return true;
      }
      while (entry.count > target) drop(entry);
      resize(entry, target);
    } else remove(entry);
    return true;
  }
  const api = {
    prune,
    evictOne,
    oldest,
    get allocatedBytes() {
      return allocatedBytes;
    },
  };
  storage.stores.add(api);
  function reserve(feed, bytes, except = null, newKey = false) {
    while ((storage.feedBytes.get(feed) || 0) + bytes > policy.feedBytes) {
      let owner = null,
        candidate = null;
      for (const store of storage.stores) {
        const entry = store.oldest(feed, except);
        if (entry && (!candidate || entry.observedAt < candidate.observedAt)) {
          owner = store;
          candidate = entry;
        }
      }
      if (!owner || !owner.evictOne(feed, except)) return false;
    }
    while (
      storage.bytes + bytes > policy.processBytes ||
      (newKey && storage.keys >= policy.keys)
    ) {
      let owner = null,
        candidate = null;
      for (const store of storage.stores) {
        const entry = store.oldest(null, except);
        if (entry && (!candidate || entry.observedAt < candidate.observedAt)) {
          owner = store;
          candidate = entry;
        }
      }
      if (!owner || !owner.evictOne(null, except)) return false;
    }
    return true;
  }
  function ingest(feed, records, now) {
    if (
      closed ||
      feed.historyRetention !== true ||
      !validTransitIdentifier(feed.id)
    )
      return;
    prune(now);
    // Pin all existing snapshot members before admitting any new key. A later
    // row must not lose its retained path to an earlier row in the same feed.
    protectedEntries = new Set();
    for (const record of records) {
      const entry = entries.get(`${feed.id}\u0000${record.id}`);
      if (entry) {
        protectedEntries.add(entry);
        unqueue(entry);
      }
    }
    try {
      for (const record of records) {
        if (
          !validTransitIdentifier(record.id) ||
          !Number.isFinite(record.lat) ||
          Math.abs(record.lat) > 90 ||
          !Number.isFinite(record.lon) ||
          Math.abs(record.lon) > 180
        )
          continue;
        const t = record.timestamp * 1000;
        if (
          !Number.isFinite(t) ||
          t < now - policy.retentionMs ||
          t > now + 10000
        )
          continue;
        const mode =
          feed.routeMode?.(record.routeId) || feed.defaultMode || 'unknown';
        const context = contextOf(record, mode);
        if (!context) continue;
        const key = `${feed.id}\u0000${record.id}`;
        let entry = entries.get(key);
        if (entry) {
          const last = read(entry, entry.count - 1);
          if (t <= last[0]) continue;
        } else {
          const encodedKey = encoder.encode(key),
            bytes =
              META_BYTES +
              EPOCH_BYTES +
              encodedKey.byteLength +
              CHUNK * FIX_BYTES;
          if (!reserve(feed.id, bytes, null, true)) {
            recordLoss(feed.id, now + policy.retentionMs);
            continue;
          }
          entry = {
            key,
            encodedKey,
            feed: feed.id,
            vehicle: record.id,
            metadata: new DataView(new ArrayBuffer(META_BYTES)),
            contexts: [new DataView(new ArrayBuffer(EPOCH_BYTES))],
            fixes: new DataView(new ArrayBuffer(CHUNK * FIX_BYTES)),
            capacity: CHUNK,
            head: 0,
            count: 0,
            epoch: 0,
            observedAt: now,
            truncated: (storage.lossUntil.get(feed.id) || 0) > now,
            bytes,
          };
          entries.set(key, entry);
          protectedEntries.add(entry);
          storage.keys++;
          account(feed.id, bytes);
        }
        let flags =
          record.timestampSource === 'vehicle'
            ? 1
            : record.timestampSource === 'header'
              ? 2
              : 4;
        const previous = entry.epoch
          ? contextAt(entry, (entry.epoch - 1) % EPOCH_SLOTS)
          : null;
        if (
          !previous ||
          previous.trip !== context.trip ||
          previous.route !== context.route ||
          previous.mode !== context.mode
        ) {
          const slot = entry.epoch % EPOCH_SLOTS;
          if (!entry.contexts[slot]) {
            if (!reserve(feed.id, EPOCH_BYTES, entry)) {
              entry.truncated = true;
              recordLoss(feed.id, now + policy.retentionMs);
              continue;
            }
            entry.contexts[slot] = new DataView(new ArrayBuffer(EPOCH_BYTES));
            entry.bytes += EPOCH_BYTES;
            account(feed.id, EPOCH_BYTES);
          }
          entry.epoch++;
          // Expiring epoch metadata also expires its positions; never label a
          // retained point with a reused context slot.
          const expiredEpoch = entry.epoch - EPOCH_SLOTS;
          while (entry.count && read(entry, 0)[4] <= expiredEpoch) drop(entry);
          storeContext(entry, context, entry.epoch);
          flags |= 16;
        }
        if (entry.count === entry.capacity) {
          const next = Math.min(policy.fixes, entry.capacity + CHUNK);
          if (
            next > entry.capacity &&
            reserve(feed.id, next * FIX_BYTES, entry)
          )
            resize(entry, next);
          else drop(entry);
        }
        const at = offset(entry, entry.count++),
          v = entry.fixes;
        v.setFloat64(at, t);
        v.setFloat64(at + 8, record.lat);
        v.setFloat64(at + 16, record.lon);
        v.setUint32(at + 24, flags);
        v.setUint32(at + 28, entry.epoch);
        entry.observedAt = now;
      }
    } finally {
      for (const entry of protectedEntries) queue(entry);
      protectedEntries = null;
    }
  }
  function get(feedId, vehicleId, now) {
    prune(now);
    const entry = entries.get(`${feedId}\u0000${vehicleId}`);
    const fixes = [],
      epochs = [];
    if (entry) {
      const used = new Set();
      for (let i = 0; i < entry.count; i++) {
        const fix = read(entry, i);
        fixes.push(fix);
        used.add(fix[4]);
      }
      for (const id of used)
        epochs.push(contextAt(entry, (id - 1) % EPOCH_SLOTS));
    }
    const payload = {
      version: 1,
      feedId,
      vehicleId,
      oldestT: fixes[0]?.[0] ?? null,
      newestT: fixes.at(-1)?.[0] ?? null,
      truncated:
        entry?.truncated ||
        (!entry && (storage.lossUntil.get(feedId) || 0) > now),
      epochs,
      fixes,
    };
    // The normal bound is smaller; keep a byte guard for worst-case Unicode.
    while (
      encoder.encode(JSON.stringify(payload)).length > policy.responseBytes &&
      payload.fixes.length
    ) {
      payload.fixes.shift();
      payload.oldestT = payload.fixes[0]?.[0] ?? null;
      payload.truncated = true;
      const used = new Set(payload.fixes.map((f) => f[4]));
      payload.epochs = payload.epochs.filter((e) => used.has(e.id));
    }
    return payload;
  }
  function clear() {
    if (timer) clearInterval(timer);
    timer = null;
    closed = true;
    for (const entry of entries.values()) remove(entry);
    storage.stores.delete(api);
  }
  if (sweep) {
    timer = setInterval(() => prune(Date.now()), 60000);
    timer.unref?.();
  }
  return {
    ingest,
    get,
    prune,
    clear,
    diagnostics: () => ({
      allocatedBytes,
      processBytes: storage.bytes,
      keys: entries.size,
      feedBytes: Object.fromEntries(feedBytes),
      sweepActive: timer !== null,
    }),
  };
}
