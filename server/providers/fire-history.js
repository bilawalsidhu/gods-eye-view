import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { parseFirmsCsv } from '../../src/data/firmsCsv.js';
import {
  filterRecordsToEvent,
  firmsAreaSegment,
  normalizeFireEventCatalog,
  splitDateWindows,
} from '../../src/data/fireHistoryEvents.js';

/**
 * NASA FIRMS archive proxy for REGISTERED historic fire events.
 *
 * Only events listed in config/fire_events.json are ever fetched — the
 * browser cannot supply dates, boxes or sources (same "registered URLs only"
 * posture as the CCTV proxy, see SECURITY.md). Each event is split into ≤5
 * day windows per source (FIRMS cap for dated archive requests), fetched sequentially for quota
 * courtesy, and written to .gev-cache/fire-history/<id>.json. Archive data
 * never changes, so a COMPLETE cache is served forever without touching
 * upstream; a partial cache (some windows failed) is served as-is and only
 * its failed windows are retried on a later request.
 *
 * Routes:
 *   GET /api/fire-history          → {hasKey, events:[{id,name,...}]}  (works keyless)
 *   GET /api/fire-history/<id>     → {event, fetchedAt, complete, windows, count, fires}
 *
 * Keyless (no FIRMS_MAP_KEY): the detail route answers 503 {error:'no_key'}
 * unless a complete cache already exists. Never log upstream URLs — they
 * embed the MAP_KEY.
 *
 * @param {{eventsPath?: string, cacheDir?: string, fetchImpl?: typeof fetch}} [options]
 * @returns {import('vite').Plugin}
 */
export function fireHistoryProxy({
  eventsPath = path.join(process.cwd(), 'config', 'fire_events.json'),
  cacheDir = path.join(process.cwd(), '.gev-cache', 'fire-history'),
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const UPSTREAM_TIMEOUT_MS = 60_000;

  /** @type {?{events: object[], byId: Map<string, object>}} */
  let catalog = null;
  /** @type {Map<string, object>} in-memory per-event cache entries */
  const mem = new Map();
  /** @type {Map<string, Promise<?object>>} single-flight per event */
  const inflight = new Map();

  const mapKey = () => String(process.env.FIRMS_MAP_KEY || '').trim();

  async function loadCatalog() {
    if (catalog) return catalog;
    let payload = null;
    try {
      payload = JSON.parse(await fsp.readFile(eventsPath, 'utf8'));
    } catch (err) {
      console.warn(
        '[fire-history] event config unreadable:',
        err?.message || err,
      );
    }
    const { events, rejected } = normalizeFireEventCatalog(payload);
    if (rejected.length)
      console.warn(
        `[fire-history] ignoring invalid event definitions: ${rejected.join(', ')}`,
      );
    catalog = { events, byId: new Map(events.map((e) => [e.id, e])) };
    return catalog;
  }

  const cachePath = (id) => path.join(cacheDir, `${id}.json`);

  async function readDisk(id) {
    if (mem.has(id)) return mem.get(id);
    try {
      const parsed = JSON.parse(await fsp.readFile(cachePath(id), 'utf8'));
      if (
        Number.isFinite(parsed?.fetchedAt) &&
        Array.isArray(parsed?.windows) &&
        Array.isArray(parsed?.fires)
      ) {
        mem.set(id, parsed);
        return parsed;
      }
    } catch {
      /* no disk cache yet */
    }
    return null;
  }

  async function writeDisk(id, entry) {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(cachePath(id), JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[fire-history] cache write failed:', err?.message || err);
    }
  }

  /** One ≤10-day window of one source. Throws on HTTP error or non-CSV body. */
  async function fetchWindow(key, event, source, window) {
    const url =
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}` +
      `/${source}/${firmsAreaSegment(event.bbox)}/${window.days}/${window.date}`;
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = parseFirmsCsv(await res.text());
    if (records === null) throw new Error('non-CSV upstream response');
    return filterRecordsToEvent(records, event);
  }

  const windowKey = (source, window) => `${source}:${window.date}`;

  /**
   * Fetch every window not already marked ok in `previous`, sequentially.
   * Returns a merged cache entry; `complete` is true once every window is ok.
   */
  async function refresh(key, event, previous) {
    const okWindows = new Map(
      (previous?.windows || [])
        .filter((w) => w.ok)
        .map((w) => [windowKey(w.source, w), w]),
    );
    const firesByWindow = new Map(
      (previous?.firesByWindow && Object.entries(previous.firesByWindow)) || [],
    );
    const windows = [];
    for (const source of event.sources) {
      for (const window of splitDateWindows(event.startDate, event.endDate)) {
        const k = windowKey(source, window);
        if (okWindows.has(k)) {
          windows.push(okWindows.get(k));
          continue;
        }
        try {
          const records = await fetchWindow(key, event, source, window);
          firesByWindow.set(k, records);
          windows.push({ source, ...window, ok: true, count: records.length });
        } catch (err) {
          console.warn(
            `[fire-history] ${event.id} ${k} failed:`,
            err?.message || err,
          );
          windows.push({ source, ...window, ok: false, count: 0 });
        }
      }
    }
    if (!windows.some((w) => w.ok)) throw new Error('all windows failed');
    const fires = [];
    for (const w of windows) {
      if (!w.ok) continue;
      for (const record of firesByWindow.get(windowKey(w.source, w)) || [])
        fires.push(record);
    }
    return {
      fetchedAt: Date.now(),
      complete: windows.every((w) => w.ok),
      windows,
      fires,
      firesByWindow: Object.fromEntries(firesByWindow),
    };
  }

  function buildPayload(event, entry) {
    return {
      event: publicEvent(event),
      fetchedAt: entry.fetchedAt,
      complete: entry.complete,
      windows: entry.windows,
      count: entry.fires.length,
      fires: entry.fires,
    };
  }

  /** Public event shape — no internal ms fields, nothing the client can't render. */
  function publicEvent(event) {
    const { startMs, endMs, ...rest } = event;
    return rest;
  }

  async function resolveEvent(key, event) {
    const cached = await readDisk(event.id);
    if (cached?.complete) return cached;
    if (!key) return cached;
    if (!inflight.has(event.id)) {
      inflight.set(
        event.id,
        refresh(key, event, cached)
          .then(async (fresh) => {
            mem.set(event.id, fresh);
            await writeDisk(event.id, fresh);
            return fresh;
          })
          .catch((err) => {
            console.warn(
              `[fire-history] ${event.id} refresh failed (${err?.message || err}) — serving cache if any`,
            );
            return cached;
          })
          .finally(() => inflight.delete(event.id)),
      );
    }
    return inflight.get(event.id);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/fire-history', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        if (req.method !== 'GET') {
          sendJson(405, { error: 'method not allowed' });
          return;
        }
        const subPath = String(req.url || '').split('?')[0];
        const { events, byId } = await loadCatalog();
        const key = mapKey();

        if (subPath === '' || subPath === '/') {
          sendJson(200, {
            hasKey: Boolean(key),
            events: events.map(publicEvent),
          });
          return;
        }

        const id = subPath.replace(/^\/+/, '');
        const event = byId.get(id);
        if (!event) {
          sendJson(404, { error: 'unknown event' });
          return;
        }
        const entry = await resolveEvent(key, event);
        if (entry) {
          sendJson(200, buildPayload(event, entry));
        } else if (!key) {
          sendJson(503, { error: 'no_key' });
        } else {
          sendJson(502, { error: 'FIRMS archive fetch failed' });
        }
      } catch (err) {
        console.warn('[fire-history] error:', err?.message || err);
        sendJson(500, { error: 'fire history proxy error' });
      }
    });
  };
  return {
    name: 'fire-history-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
