import { UK_FEEDS } from './ukCatalog.js';
import { inUkBounds } from './ukDataModel.js';

export const UK_MAP_STORAGE_KEY = 'gev:uk-map-sources:v1';
export const UK_MAP_POINT_LIMIT = 12000;
const SOURCE_POINT_LIMIT = 5000;

/** Own independent public-feed requests, saved switches and refresh lifetimes. */
export function createUkMapLayers({
  fetchFeed,
  replace,
  remove,
  onChange = () => {},
  storage,
  feeds = UK_FEEDS,
  maxConcurrent = 3,
  pointLimit = UK_MAP_POINT_LIMIT,
}) {
  try {
    storage ??= globalThis.localStorage;
  } catch {
    /* Denied storage. */
  }
  const entries = new Map(
    feeds.map((info) => [
      info.id,
      {
        info,
        enabled: false,
        status: 'off',
        generation: 0,
        payload: null,
        mappedCount: 0,
        timer: null,
        request: null,
      },
    ]),
  );
  const queued = new Set();
  let active = 0,
    destroyed = false,
    suspended = false;
  const states = () =>
    [...entries.values()].map((e) => ({
      id: e.info.id,
      name: e.info.name,
      enabled: e.enabled,
      status: e.status,
      count: e.payload?.rows?.length || 0,
      mappedCount: e.mappedCount,
      coordinateCount:
        e.payload?.rows?.filter((r) => inUkBounds(r.lat, r.lon)).length || 0,
      retrievedAt: e.payload?.retrievedAt || null,
      message: e.payload?.message || '',
    }));
  const notify = () => {
    if (!destroyed) onChange(states());
  };
  function save() {
    try {
      storage?.setItem(
        UK_MAP_STORAGE_KEY,
        JSON.stringify(
          [...entries].filter(([, e]) => e.enabled).map(([id]) => id),
        ),
      );
    } catch {
      /* Storage can be denied; switches still work for this session. */
    }
  }
  function cancel(e) {
    e.generation++;
    clearTimeout(e.timer);
    e.timer = null;
    e.request?.abort();
    e.request = null;
    queued.delete(e.info.id);
  }
  function paint() {
    let budget = pointLimit;
    for (const [id, e] of entries) {
      if (!e.enabled || !e.payload) continue;
      const unique = new Set();
      const rows = e.payload.rows
        .filter((r) => {
          const key = String(r.id);
          if (!inUkBounds(r.lat, r.lon) || unique.has(key)) return false;
          unique.add(key);
          return true;
        })
        .slice(0, Math.min(SOURCE_POINT_LIMIT, budget));
      budget -= rows.length;
      const changed =
        e.renderedPayload !== e.payload || e.mappedCount !== rows.length;
      e.mappedCount = rows.length;
      if (changed) {
        if (rows.length) replace(id, rows, e.info);
        else remove(id);
        e.renderedPayload = e.payload;
      }
    }
    notify();
  }
  function queue(id) {
    const e = entries.get(id);
    if (destroyed || suspended || !e?.enabled || e.request) return;
    clearTimeout(e.timer);
    e.timer = null;
    queued.add(id);
    pump();
  }
  function pump() {
    if (destroyed || suspended) return;
    while (active < maxConcurrent && queued.size) {
      const id = queued.values().next().value;
      queued.delete(id);
      const e = entries.get(id);
      if (!e?.enabled || e.request) continue;
      void load(id, e);
    }
  }
  async function load(id, e) {
    active++;
    const generation = e.generation;
    const controller = new AbortController();
    e.request = controller;
    e.status = 'loading';
    notify();
    const deadline = setTimeout(() => controller.abort(), 60000);
    const current = () =>
      !destroyed && e.enabled && e.generation === generation;
    try {
      const payload = await fetchFeed(id, controller.signal);
      if (!current()) return;
      if (!Array.isArray(payload?.rows))
        throw new Error('Unexpected public data response');
      e.payload = { ...payload, rows: payload.rows.slice(0, 10000) };
      e.status = payload.status || 'available';
      paint();
    } catch (error) {
      if (!current()) return;
      e.status = 'unavailable';
      e.payload = {
        rows: [],
        retrievedAt: null,
        message:
          'This feed could not be loaded. Its missing points are not an all-clear.',
      };
      e.mappedCount = 0;
      remove(id);
      paint();
    } finally {
      clearTimeout(deadline);
      active--;
      if (e.request === controller) e.request = null;
      if (current() && !suspended && id !== 'places') {
        e.timer = setTimeout(() => queue(id), e.info.interval);
        e.timer.unref?.();
      }
      pump();
    }
  }
  function setEnabled(id, enabled, persist = true) {
    const e = entries.get(id);
    if (destroyed || !e || e.enabled === Boolean(enabled)) return;
    cancel(e);
    e.enabled = Boolean(enabled);
    e.status = e.enabled ? 'queued' : 'off';
    if (!e.enabled) {
      remove(id);
      e.payload = null;
      e.mappedCount = 0;
      paint();
    } else queue(id);
    if (persist) save();
    notify();
  }
  const api = {
    states,
    isEnabled: (id) => entries.get(id)?.enabled === true,
    payload: (id) => entries.get(id)?.payload,
    setEnabled,
    enableAll() {
      for (const info of feeds)
        if (info.id !== 'places') setEnabled(info.id, true, false);
      save();
    },
    disableAll() {
      for (const id of entries.keys()) setEnabled(id, false, false);
      save();
    },
    refresh(id) {
      if (id) queue(id);
      else for (const key of entries.keys()) queue(key);
    },
    setSuspended(value) {
      suspended = Boolean(value);
      if (suspended) {
        for (const e of entries.values()) cancel(e);
      } else {
        for (const id of entries.keys()) queue(id);
      }
    },
    destroy() {
      destroyed = true;
      for (const [id, e] of entries) {
        cancel(e);
        remove(id);
      }
      queued.clear();
    },
  };
  try {
    const saved = JSON.parse(storage?.getItem(UK_MAP_STORAGE_KEY) || '[]');
    if (Array.isArray(saved))
      for (const id of new Set(saved.slice(0, 30))) {
        if (typeof id === 'string' && entries.has(id))
          setEnabled(id, true, false);
      }
  } catch {
    /* Ignore malformed or unavailable preferences. */
  }
  return api;
}
