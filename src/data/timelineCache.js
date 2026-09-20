/**
 * 4D Historical Timeline Position Snapshot Cache.
 *
 * Maintains a ring buffer of periodic entity state snapshots (sampled every 30s)
 * enabling 24-hour historical scrub, replay, and temporal query.
 */

const MAX_SNAPSHOTS = 2880; // 24 hours at 30s intervals
const DB_NAME = 'gev_timeline_db';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';

export class TimelineCache {
  /**
   * @param {object} [options]
   * @param {number} [options.maxSnapshots=2880]
   * @param {boolean} [options.useIndexedDB=true]
   */
  constructor({ maxSnapshots = MAX_SNAPSHOTS, useIndexedDB = true } = {}) {
    this.maxSnapshots = maxSnapshots;
    this.useIndexedDB = useIndexedDB;
    this._snapshots = []; // Array<{ timestampMs: number, entities: Array<object> }>
    this._db = null;
    this._initDb();
  }

  async _initDb() {
    if (!this.useIndexedDB || typeof indexedDB === 'undefined') return;
    try {
      this._db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'timestampMs' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await this._restoreFromDb();
    } catch {}
  }

  async _restoreFromDb() {
    if (!this._db) return;
    try {
      const tx = this._db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        if (Array.isArray(req.result) && req.result.length) {
          this._snapshots = req.result.sort((a, b) => a.timestampMs - b.timestampMs);
          if (this._snapshots.length > this.maxSnapshots) {
            this._snapshots = this._snapshots.slice(-this.maxSnapshots);
          }
        }
      };
    } catch {}
  }

  /**
   * Save a snapshot of currently visible entities at given timestamp.
   * @param {Array<{ id: string, lat: number, lon: number, alt?: number, heading?: number, speed?: number }>} entities
   * @param {number} [timestampMs=Date.now()]
   */
  recordSnapshot(entities, timestampMs = Date.now()) {
    if (!Array.isArray(entities) || !entities.length) return;

    // Compact entity records to minimal payload
    const compacted = entities.map((e) => ({
      id: e.id || e.name || 'contact',
      lat: Number(e.lat ?? e.latDeg ?? 0),
      lon: Number(e.lon ?? e.lonDeg ?? 0),
      alt: Number(e.alt ?? e.altitudeM ?? 0),
      heading: Number(e.heading ?? e.headingDeg ?? 0),
      speed: Number(e.speed ?? e.speedKts ?? 0),
      type: e.type || 'flight',
    }));

    const snapshot = {
      timestampMs,
      entities: compacted,
    };

    this._snapshots.push(snapshot);
    if (this._snapshots.length > this.maxSnapshots) {
      this._snapshots.shift();
    }

    if (this._db) {
      try {
        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(snapshot);
      } catch {}
    }
  }

  /**
   * Find closest recorded snapshot at or immediately preceding target timestamp.
   * @param {number} targetTimeMs
   * @returns {Array<object> | null}
   */
  getEntitiesAtTime(targetTimeMs) {
    if (!this._snapshots.length) return null;

    // Binary search for closest timestamp
    let low = 0;
    let high = this._snapshots.length - 1;

    if (targetTimeMs <= this._snapshots[0].timestampMs) {
      return this._snapshots[0].entities;
    }
    if (targetTimeMs >= this._snapshots[high].timestampMs) {
      return this._snapshots[high].entities;
    }

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const midTime = this._snapshots[mid].timestampMs;

      if (midTime === targetTimeMs) {
        return this._snapshots[mid].entities;
      }
      if (midTime < targetTimeMs) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    // Return the snapshot closest to targetTimeMs
    const idx = Math.max(0, Math.min(this._snapshots.length - 1, high));
    return this._snapshots[idx].entities;
  }

  /**
   * Returns earliest and latest available timestamps.
   */
  getTimeRange() {
    if (!this._snapshots.length) {
      const now = Date.now();
      return { startMs: now, endMs: now, count: 0 };
    }
    return {
      startMs: this._snapshots[0].timestampMs,
      endMs: this._snapshots[this._snapshots.length - 1].timestampMs,
      count: this._snapshots.length,
    };
  }

  clear() {
    this._snapshots = [];
    if (this._db) {
      try {
        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
      } catch {}
    }
  }
}
