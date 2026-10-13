import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { parseFirmsCsv } from '../../src/data/firmsCsv.js';
import { readResponseTextCapped } from './common/http.js';
import {
  filterRecordsToEvent,
  firmsAreaSegment,
  normalizeFireEventCatalog,
  splitDateWindows,
} from '../../src/data/fireHistoryEvents.js';

/**
 * NASA FIRMS archive proxy for registered historic fire events.
 *
 * Continued from @lleon-at-navteca's PR #609. This version follows the
 * maintainer-requested ownership changes: definitions live under local_data,
 * cache identity includes the normalized event definition, failed windows cool
 * down before retry, and perimeter fetching is left to the shared provider.
 */
export function fireHistoryProxy({
  eventsPath = path.join(
    process.cwd(),
    'src',
    'data',
    'local_data',
    'fire_events',
    'fire_events.json',
  ),
  cacheDir = path.join(process.cwd(), '.gev-cache', 'fire-history'),
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const UPSTREAM_TIMEOUT_MS = 60_000;
  const WINDOW_MAX_BYTES = 16 * 1024 * 1024;
  const RETRY_BASE_MS = 15 * 60_000;
  const RETRY_MAX_MS = 6 * 60 * 60_000;

  let catalog = null;
  const mem = new Map();
  const inflight = new Map();

  const mapKey = () => String(process.env.FIRMS_MAP_KEY || '').trim();

  const publicEvent = (event) => {
    const { startMs, endMs, ...rest } = event;
    return rest;
  };

  const definitionHash = (event) =>
    createHash('sha256')
      .update(JSON.stringify(publicEvent(event)))
      .digest('hex')
      .slice(0, 16);

  const definitionKey = (event) => `${event.id}:${definitionHash(event)}`;

  async function loadCatalog() {
    if (catalog) return catalog;
    let payload = null;
    try {
      payload = JSON.parse(await fsp.readFile(eventsPath, 'utf8'));
    } catch (err) {
      console.warn('[fire-history] event registry unreadable:', err?.message || err);
    }
    const { events, rejected } = normalizeFireEventCatalog(payload);
    if (rejected.length)
      console.warn(
        `[fire-history] ignoring invalid event definitions: ${rejected.join(', ')}`,
      );
    catalog = { events, byId: new Map(events.map((event) => [event.id, event])) };
    return catalog;
  }

  const cachePath = (event) =>
    path.join(cacheDir, `${event.id}.${definitionHash(event)}.json`);

  async function readDisk(event) {
    const key = definitionKey(event);
    if (mem.has(key)) return mem.get(key);
    try {
      const parsed = JSON.parse(await fsp.readFile(cachePath(event), 'utf8'));
      if (
        parsed?.definitionHash === definitionHash(event) &&
        Number.isFinite(parsed?.fetchedAt) &&
        Array.isArray(parsed?.windows) &&
        Array.isArray(parsed?.fires)
      ) {
        mem.set(key, parsed);
        return parsed;
      }
    } catch {
      // No cache for this exact event definition yet.
    }
    return null;
  }

  async function writeDisk(event, entry) {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(cachePath(event), JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[fire-history] cache write failed:', err?.message || err);
    }
  }

  async function fetchWindow(key, event, source, window) {
    const url =
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}` +
      `/${source}/${firmsAreaSegment(event.bbox)}/${window.days}/${window.date}`;
    const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const records = parseFirmsCsv(
      await readResponseTextCapped(response, WINDOW_MAX_BYTES, signal),
    );
    if (records === null) throw new Error('non-CSV upstream response');
    return filterRecordsToEvent(records, event);
  }

  const windowKey = (source, window) => `${source}:${window.date}`;

  const retryDelay = (attempts) =>
    Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

  async function refresh(key, event, previous) {
    const previousWindows = new Map(
      (previous?.windows || []).map((window) => [
        windowKey(window.source, window),
        window,
      ]),
    );
    const fires = Array.isArray(previous?.fires) ? [...previous.fires] : [];
    const windows = [];
    let attempted = false;

    for (const source of event.sources) {
      for (const window of splitDateWindows(event.startDate, event.endDate)) {
        const id = windowKey(source, window);
        const before = previousWindows.get(id);
        if (before?.ok) {
          windows.push(before);
          continue;
        }
        if (Number.isFinite(before?.retryAt) && before.retryAt > now()) {
          windows.push(before);
          continue;
        }

        attempted = true;
        try {
          const records = await fetchWindow(key, event, source, window);
          fires.push(...records);
          windows.push({ source, ...window, ok: true, count: records.length });
        } catch (err) {
          const attempts = Math.max(0, Number(before?.attempts) || 0) + 1;
          console.warn(
            `[fire-history] ${event.id} ${id} failed:`,
            err?.message || err,
          );
          windows.push({
            source,
            ...window,
            ok: false,
            count: 0,
            attempts,
            retryAt: now() + retryDelay(attempts),
          });
        }
      }
    }

    if (!attempted && previous) return previous;
    if (!windows.some((window) => window.ok)) throw new Error('all windows failed');

    return {
      definitionHash: definitionHash(event),
      fetchedAt: now(),
      complete: windows.every((window) => window.ok),
      windows,
      fires,
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

  async function resolveEvent(key, event) {
    const cacheKey = definitionKey(event);
    const cached = await readDisk(event);
    if (cached?.complete) return cached;
    if (!key) return cached;
    if (!inflight.has(cacheKey)) {
      inflight.set(
        cacheKey,
        refresh(key, event, cached)
          .then(async (fresh) => {
            mem.set(cacheKey, fresh);
            if (fresh !== cached) await writeDisk(event, fresh);
            return fresh;
          })
          .catch((err) => {
            console.warn(
              `[fire-history] ${event.id} refresh failed (${err?.message || err}) — serving cache if any`,
            );
            return cached;
          })
          .finally(() => inflight.delete(cacheKey)),
      );
    }
    return inflight.get(cacheKey);
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
        if (req.method !== 'GET') return sendJson(405, { error: 'method_not_allowed' });
        const subPath = String(req.url || '').split('?')[0];
        const { events, byId } = await loadCatalog();
        const key = mapKey();

        if (subPath === '' || subPath === '/') {
          return sendJson(200, {
            hasKey: Boolean(key),
            events: events.map(publicEvent),
          });
        }

        const parts = subPath.replace(/^\/+/, '').split('/');
        if (parts.length !== 1) return sendJson(404, { error: 'unknown_event' });
        const event = byId.get(parts[0]);
        if (!event) return sendJson(404, { error: 'unknown_event' });

        const entry = await resolveEvent(key, event);
        if (entry) return sendJson(200, buildPayload(event, entry));
        if (!key) return sendJson(503, { error: 'no_key' });
        return sendJson(502, { error: 'firms_archive_unavailable' });
      } catch (err) {
        console.warn('[fire-history] error:', err?.message || err);
        return sendJson(500, { error: 'fire_history_proxy_error' });
      }
    });
  };

  return {
    name: 'fire-history-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
