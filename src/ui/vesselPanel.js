import { normalizeVesselFilters } from '../data/vesselDisplayFilters.js';

const FEEDS = ['ais-live-vessels'];
const FEED = FEEDS[0];
const STORAGE_KEY = 'gev:vessel-display-filters:v1';

/** Present a paged vessel list only while its panel is open. Source polling
 * stays with the layers; local display preferences are separate from feed data.
 */
export function createVesselPanel({
  store,
  reveal,
  storage = null,
  doc = globalThis.document,
}) {
  let manager = null,
    unsubscribe = null,
    timer = null,
    token;
  let page = 0,
    lastSignature = '';
  const module = (id = FEED) => manager?.layers.get(id)?.module;
  function syncAvailability() {
    store.available = FEEDS.some((id) => manager?.isEnabled(id));
    if (!store.available) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function refresh() {
    syncAvailability();
    if (!manager) return;
    const layer = module();
    store.enabled = manager.isEnabled(FEED);
    const next = {
      filters: normalizeVesselFilters(layer?.getParams?.().displayFilters),
      list: layer?.getVesselList?.({ search: store.search, page }) || {
        rows: [],
        total: 0,
        matching: 0,
        page: 0,
        pages: 1,
      },
    };
    const signature = JSON.stringify(next);
    if (signature !== lastSignature) {
      store.filters = next.filters;
      store.list = next.list;
      lastSignature = signature;
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!store.available || !store.visible || doc?.hidden) return;
    refresh();
    timer = setTimeout(schedule, 1000);
  }
  function persist() {
    try {
      storage?.setItem(
        STORAGE_KEY,
        JSON.stringify(
          Object.fromEntries(
            FEEDS.map((id) => [
              id,
              normalizeVesselFilters(module(id)?.getParams?.().displayFilters),
            ]),
          ),
        ),
      );
    } catch {
      /* Display filtering still works when browser storage is denied. */
    }
  }
  function open() {
    page = 0;
    refresh();
    reveal();
  }
  function connect(next) {
    unsubscribe?.();
    for (const id of FEEDS) module(id)?.attachVesselPanel?.(null);
    manager = next;
    syncAvailability();
    if (!manager) return;
    let saved;
    try {
      const text = storage?.getItem(STORAGE_KEY);
      saved = text && text.length < 16384 ? JSON.parse(text) : null;
    } catch {
      saved = null;
    }
    for (const id of FEEDS) {
      module(id)?.attachVesselPanel?.(open);
      if (saved?.[id] && typeof saved[id] === 'object')
        manager.setLayerParams(
          id,
          { displayFilters: normalizeVesselFilters(saved[id]) },
          { origin: 'display-filter-restore' },
        );
    }
    unsubscribe = manager.subscribe((change) => {
      if (FEEDS.includes(change.layerId)) syncAvailability();
      if (
        FEEDS.includes(change.layerId) &&
        change.type === 'params' &&
        change.requestedParams?.displayFilters
      )
        persist();
      if (store.visible && FEEDS.includes(change.layerId)) refresh();
    });
    refresh();
    schedule();
  }
  token = store.connect({
    visibility: schedule,
    search(value) {
      store.search = String(value).slice(0, 120);
      page = 0;
      refresh();
    },
    page(value) {
      page = Number(value) || 0;
      refresh();
    },
    filter(patch) {
      page = 0;
      manager?.setLayerParams(
        FEED,
        { displayFilters: patch },
        { origin: 'user' },
      );
      refresh();
    },
    reset() {
      manager?.setLayerParams(
        FEED,
        { displayFilters: normalizeVesselFilters() },
        { origin: 'user' },
      );
      page = 0;
      refresh();
    },
    select(id) {
      if (!manager?.isEnabled(FEED)) return;
      return module()?.selectById?.(id);
    },
  });
  doc?.addEventListener?.('visibilitychange', schedule);
  return {
    connect,
    refresh,
    destroy() {
      clearTimeout(timer);
      unsubscribe?.();
      for (const id of FEEDS) module(id)?.attachVesselPanel?.(null);
      doc?.removeEventListener?.('visibilitychange', schedule);
      store.detach(token);
      manager = null;
    },
  };
}
