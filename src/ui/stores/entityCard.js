import { defineStore } from 'pinia';
import { markRaw, ref, shallowRef, triggerRef } from 'vue';
import { sourceLabel } from '../layerNames.js';
import {
  alertsNear,
  describeEntity,
  entityKind,
  layerBreakdown,
  nearbyByKind,
  nearbyByLayer,
  nearbyEntities,
  layerMatches,
  searchEntities,
  viewSummary,
} from '../../data/entityContext.js';
import { formatDate, formatNumber, t } from '../../i18n/index.js';

const FACT_DATE = Object.freeze({
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * Words from entityContext (a fact's, an insight's or a warning's `words`) in
 * the active language, or `fallback` (its English as given) when it has none.
 * @param {?{text?: string, values?: object, context?: string, fixed?: number, date?: number}} words
 * @param {string} [fallback]
 * @returns {string}
 */
export function sayWords(words, fallback = '') {
  if (!words) return fallback;
  if (words.date !== undefined) return formatDate(words.date, FACT_DATE);
  const digits =
    words.fixed === undefined
      ? { maximumFractionDigits: 2 }
      : {
          minimumFractionDigits: words.fixed,
          maximumFractionDigits: words.fixed,
        };
  const values = {};
  for (const [name, value] of Object.entries(words.values || {}))
    values[name] =
      typeof value === 'number'
        ? formatNumber(value, digits)
        : value && typeof value === 'object'
          ? sayWords(value)
          : value;
  if (words.context) values.context = words.context;
  return t(words.text, values);
}

/** A fact's or insight's value in the active language. */
export const factValue = (fact) => sayWords(fact?.words, fact?.value ?? '');

/**
 * A fact's label in the active language. Labels whose plain English means
 * something else elsewhere in the catalog take a context here.
 */
export function factLabel(fact) {
  if (fact?.label === 'Country') return t('Country', { context: 'place' });
  return t(fact?.label || '', fact?.labelValues);
}

/**
 * A figure split for a tile, so its number can lead: `{number, unit}` in the
 * active language. A value that does not start with its number shows whole.
 */
export function factFigure(fact) {
  const words = fact?.words;
  if (words?.text?.startsWith('{n}') && typeof words.values?.n === 'number')
    return {
      number: sayWords({ ...words, text: '{n}' }),
      unit: sayWords({ ...words, values: { ...words.values, n: '' } }).trim(),
    };
  return { number: factValue(fact), unit: '' };
}

/** How often the in-view answer reads a moving layer's items again, at most. */
export const MOVING_REFRESH_MS = 10_000;
/** The longest a moving layer's in-view rows wait to be read again. */
export const MOVING_REFRESH_MAX_MS = 60_000;
/**
 * The most of the main thread reading a moving layer again may take: the
 * wait between its reads is at least its last read's cost divided by this.
 */
const MOVING_REFRESH_COST_SHARE = 0.01;
/**
 * A layer whose last read took longer than this (a frame) is not read again
 * for each step of a camera that is still moving; see readLayers.
 */
const COSTLY_READ_MS = 16;

/** At or above this camera height the whole globe is in view (Context's globe view). */
const GLOBE_HEIGHT_M = 5_000_000;
/** Whether a view is the globe view, where "in view" is what the camera's height can see. */
export const isGlobeView = (where) =>
  Boolean(where?.center) && (where.heightM ?? 0) >= GLOBE_HEIGHT_M;

/** How often an open card re-reads its item, so moving things stay current. */
const REFRESH_MS = 2000;

/**
 * The thing the Context panel is about: whatever was last clicked on the
 * globe, chosen in the omnibar, or picked from the card's nearby list.
 *
 * The shell connects `{dataManager(), flyTo(card), follow(card), openPanel()}`;
 * until then nothing can be selected.
 */
export const useEntityCardStore = defineStore('gev-entity-card', () => {
  const shell = shallowRef(null);
  /** The card model from `describeEntity`, or null. */
  const card = shallowRef(null);
  /** True once a moving item has dropped out of its feed. */
  const lost = ref(false);
  /** Bumped on each refresh, so ages shown on the card tick. */
  const tick = ref(0);
  /**
   * True while the item is not to be seen: out of its feed, off screen or
   * behind the globe. The card then offers to find it.
   */
  const away = ref(false);
  /**
   * Finding the item again (see locate): `'idle'`, `'finding'` while its
   * layer looks it up, or `'none'` when it has no reading at the time.
   */
  const finding = ref('idle');
  /**
   * Where an item out of its feed was found (see locate):
   * `{lat, lon, altitudeM, observedAtMs, atMs}`, or null.
   */
  const located = shallowRef(null);
  /** The track reference of the card's item, kept for when it leaves its feed. */
  let reference = null;
  let locating = null;
  /** An aircraft found again is followed once it is back in its feed. */
  let followWhenBack = false;
  /**
   * What the camera shows, for the panel to describe when nothing is picked:
   * `{center: {lat, lon}, rect: {west, south, east, north}, heightM}`.
   */
  const view = shallowRef(null);
  /** Whether the last view came from a camera still moving (see setView). */
  const viewMoving = ref(false);
  const inspector = shallowRef({ shown: false, mountId: null });
  let readInspectorVisibility;
  const inspectorRows = shallowRef([]);
  const inspectorPulse = ref(0);
  const viewWeather = shallowRef(null);
  let timer = null;

  function setViewContextShown(shown, mountId, readVisibility) {
    readInspectorVisibility = mountId === null ? undefined : readVisibility;
    if (inspector.value.shown === shown && inspector.value.mountId === mountId)
      return;
    inspector.value = { shown, mountId };
  }

  function readViewContextShown() {
    return inspector.value.shown && (readInspectorVisibility?.() ?? true);
  }

  function publishInspectorRows(rows) {
    // A manager can reuse its array while updating the rows it contains.
    if (inspectorRows.value === rows) triggerRef(inspectorRows);
    else inspectorRows.value = rows;
  }

  function pulseInspector() {
    inspectorPulse.value++;
  }

  function publishViewWeather(weather) {
    viewWeather.value = weather;
  }

  /** Manager identity changes invalidate row readers without a feed update. */
  const managerVersion = ref(0);
  /** Notifications from the current manager. */
  const layerRevision = ref(0);
  let subscription = { manager: null };

  function onLayerChange(change) {
    if (
      change?.type === 'params' ||
      (change?.type === 'refresh' && !entityKind(change.layerId).moving) ||
      (change?.type === 'visibility' && change.enabled === false)
    ) {
      inViewLayers.delete(change.layerId);
      inViewSearchLayers.delete(change.layerId);
      nearbyMemo.delete(change.layerId);
    }
    layerRevision.value++;
  }

  function listen(manager) {
    if (subscription.manager === manager) return;
    const previous = subscription;
    const next = { manager };
    subscription = next;
    previous.off?.();
    inViewLayers.clear();
    inViewSearchLayers.clear();
    nearbyMemo.clear();
    inViewMemo = null;
    nearbyLast = null;
    try {
      next.off = manager?.subscribe?.((change) => {
        if (subscription === next) onLayerChange(change);
      });
    } catch {
      // Read the manager even if it cannot send notifications.
    }
    // The manager can first appear during a computed read.
    queueMicrotask(() => {
      if (subscription === next) managerVersion.value++;
    });
  }

  function connect(next) {
    listen(null);
    shell.value = next ? markRaw(next) : null;
    if (!next) clear();
    dataManager();
  }

  function dataManager() {
    const manager = shell.value?.dataManager?.() || null;
    listen(manager);
    return manager;
  }

  function syncDataManager() {
    dataManager();
  }

  function read(identity) {
    const next = describeEntity(dataManager(), identity);
    if (!next) return false;
    card.value = markRaw(next);
    lost.value = false;
    tick.value++;
    return true;
  }

  /**
   * Where a card's data comes from, for its footer: the item's own source,
   * else its layer's live feed (the name the layer list shows).
   */
  function sourceOf(current) {
    if (!current) return '';
    if (current.source) return current.source;
    const dm = shell.value?.dataManager?.();
    const layer = dm?.getAll?.().find((row) => row.id === current.layerId);
    const stats = layer?.stats || {};
    const raw =
      stats.sourceVerbatim === true && stats.source
        ? stats.source
        : sourceLabel(stats.source || layer?.source);
    return raw || '';
  }
  const canCockpit = () => Boolean(shell.value?.canCockpit?.(card.value));
  function cockpit() {
    if (card.value) shell.value?.cockpit?.(card.value);
  }

  /**
   * @param {?object} next The view, or null.
   * @param {{settled?: boolean}} [options] `settled: false` for a camera
   *   still moving; a costly layer then keeps its last rows a while (see
   *   readLayers) rather than being read again for each step.
   */
  function setView(next, { settled = true } = {}) {
    viewMoving.value = Boolean(next) && !settled;
    view.value = next ? markRaw(next) : null;
  }
  /** Ask a flight's layer for its route, so the card can draw it. */
  function requestRoute(identity) {
    if (!identity?.id || !['flights'].includes(identity.layerId)) return;
    const layer = shell.value?.dataManager?.()?.layers?.get?.(identity.layerId);
    try {
      layer?.module?.requestRoute?.(identity.id);
    } catch {
      // No route then; the card shows without one.
    }
  }

  /** A layer's items in an area that pass a test (see layerMatches). */
  function matchesIn(layerId, area) {
    const dm = shell.value?.dataManager?.();
    if (!dm || !dm.isEnabled?.(layerId)) return null;
    return layerMatches(dm, layerId, area);
  }

  const roundTo = (n, step) =>
    Number.isFinite(n) ? Math.round(n / step) : 'x';
  function viewKey(where) {
    const rect = where.rect
      ? [where.rect.west, where.rect.south, where.rect.east, where.rect.north]
          .map((n) => roundTo(n, 0.001))
          .join(',')
      : '';
    const eye = where.eye
      ? `${roundTo(where.eye.lat, 0.0001)},${roundTo(where.eye.lon, 0.0001)}`
      : '';
    return `${roundTo(where.center.lat, 0.0001)},${roundTo(where.center.lon, 0.0001)},${roundTo(where.heightM, 10)}|${rect}|${eye}`;
  }
  /** How long a moving layer's rows are kept, from what its last read cost. */
  const movingWait = (costMs) =>
    Math.min(
      MOVING_REFRESH_MAX_MS,
      Math.max(MOVING_REFRESH_MS, costMs / MOVING_REFRESH_COST_SHARE),
    );

  /**
   * Reads each layer that is on on its own, keeping each one's answer in
   * `cache` (per layer: `{place, options, revision, value, at, costMs}`)
   * while its key holds: `place` (where), `options` (what was asked) and
   * the layer's data revision (`lastUpdate:count`). Another layer's refresh
   * never reads it again. A layer of moving items (satellites, aircraft) is
   * also read again once its answer is movingWait(costMs) old, since
   * satellites stamp a revision only when new orbits arrive. While the
   * camera is still moving, a costly layer (its last read over
   * COSTLY_READ_MS) whose revision and options are unchanged keeps its
   * answer for movingWait(costMs) too; a settled view reads it at once.
   * @returns {boolean} Whether any layer's answer changed or went.
   */
  function readLayers(cache, dm, rows, place, options, readOne) {
    const now = Date.now();
    let changed = false;
    for (const id of cache.keys())
      if (!rows.some((row) => row.id === id)) {
        cache.delete(id);
        changed = true;
      }
    for (const row of rows) {
      const revision = `${row.stats?.lastUpdate ?? ''}:${row.stats?.count ?? ''}`;
      const kept = cache.get(row.id);
      const fresh = kept && now - kept.at < movingWait(kept.costMs);
      const same =
        kept && kept.options === options && kept.revision === revision;
      if (same && kept.place === place && (fresh || !entityKind(row.id).moving))
        continue;
      if (same && fresh && viewMoving.value && kept.costMs > COSTLY_READ_MS)
        continue;
      // One layer's read: the data manager narrowed to this row.
      const one = {
        layers: dm.layers,
        isEnabled: (id) => (dm.isEnabled ? dm.isEnabled(id) : true),
        getAll: () => [row],
      };
      const started = globalThis.performance?.now?.() ?? now;
      const value = readOne(one);
      const costMs = (globalThis.performance?.now?.() ?? now) - started;
      cache.set(row.id, { place, options, revision, value, at: now, costMs });
      changed = true;
    }
    return changed;
  }

  /** The layers that are on, as the data manager lists them. */
  const enabledRows = (dm) =>
    (dm.getAll?.() || []).filter((row) => row.enabled);

  const IN_VIEW_PER_LAYER = 3;
  /** Per layer, as readLayers keeps it. */
  const inViewLayers = new Map();
  const inViewSearchLayers = new Map();
  let inViewMemo = null;
  /**
   * What the loaded layers have in the current view, by layer, nearest the
   * centre first (`viewSummary`). Shared by Context's globe view and the
   * omnibar's in-view strip, so both show the same items and counts.
   *
   * Lazy and remembered per layer (readLayers): each layer's rows are worked
   * out when asked, at the widest size anyone asks for (IN_VIEW_PER_LAYER),
   * and reused while the view and that layer's data hold, and only while
   * something asks (Context's panel while it is open and the page visible,
   * the omnibar). Satellites' records are SGP4 positions worked out for the
   * whole catalogue, a long read, so the wait before reading them again
   * grows with what the last read cost: at least 100 times it (about 1% of
   * the main thread), up to MOVING_REFRESH_MAX_MS. A caller asking for fewer
   * rows gets a slice of the same answer. The active search keeps its
   * own per-layer rows and refreshes on a different query or limit.
   * @param {{perLayer?: number, query?: string}} [options]
   */
  function inView(options = {}) {
    void managerVersion.value;
    const dm = dataManager();
    const where = view.value;
    if (!dm || !where?.center) return [];
    const hemisphere = isGlobeView(where);
    const query = options.query || '';
    const limit = query
      ? (options.perLayer ?? IN_VIEW_PER_LAYER)
      : IN_VIEW_PER_LAYER;
    const cache = query ? inViewSearchLayers : inViewLayers;
    const rows = enabledRows(dm);
    const layers = rows.map((row) => row.id).join('|');
    const changed = readLayers(
      cache,
      dm,
      rows,
      viewKey(where),
      JSON.stringify([hemisphere, query, limit]),
      (one) =>
        viewSummary(one, where.rect, where.center, {
          perLayer: limit,
          query,
          hemisphere,
          heightM: where.heightM,
          eye: where.eye,
        })[0] ?? null,
    );
    // Layers with the most in view first; ties keep the layer order.
    const sorted = () =>
      rows
        .map((row) => cache.get(row.id)?.value)
        .filter(Boolean)
        .sort((a, b) => b.count - a.count);
    if (query) return sorted();
    if (changed || inViewMemo?.layers !== layers)
      inViewMemo = {
        layers,
        full: sorted(),
        sliced: new Map(),
      };
    const perLayer = Number.isFinite(options.perLayer)
      ? Math.min(options.perLayer, IN_VIEW_PER_LAYER)
      : IN_VIEW_PER_LAYER;
    if (perLayer >= IN_VIEW_PER_LAYER) return inViewMemo.full;
    if (!inViewMemo.sliced.has(perLayer))
      inViewMemo.sliced.set(
        perLayer,
        inViewMemo.full.map((group) => ({
          ...group,
          items: group.items.slice(0, perLayer),
        })),
      );
    return inViewMemo.sliced.get(perLayer);
  }
  /** Ask GEV about the view, with what is in it. */
  function askAboutView(summary) {
    const where = view.value;
    if (!where) return;
    const counts = summary
      .map((group) => `${group.count} ${group.layerName}`)
      .join(', ');
    shell.value?.askText?.(
      `What am I looking at? The view is centred on ${where.center.lat.toFixed(4)}, ${where.center.lon.toFixed(4)} from about ${Math.round(where.heightM)} m up${counts ? `, showing ${counts}` : ''}. What is here and what stands out?`,
    );
  }

  /** The layers that are on, as the data manager lists them. */
  function liveLayers() {
    return allLayers().filter((row) => row.enabled);
  }

  /** Every layer row, on or off (Context's suggested layers). */
  function allLayers() {
    try {
      return dataManager()?.getAll?.() || [];
    } catch {
      return [];
    }
  }

  /** What a layer's items are made of (see layerBreakdown). */
  function breakdown(layerId, options) {
    return layerBreakdown(shell.value?.dataManager?.(), layerId, options);
  }

  /** Loaded records near a point that broadcast a warning. */
  function alertsAt(lat, lon, options) {
    return alertsNear(shell.value?.dataManager?.(), { lat, lon }, options);
  }

  /**
   * What the loaded layers have within a radius of a point, grouped the way
   * every card lists it: `{flights, vessels, other}` (see nearbyByKind).
   */
  function nearbyGroups(lat, lon, options) {
    return nearbyByKind(shell.value?.dataManager?.(), { lat, lon }, options);
  }

  /**
   * A field layer's value at a point (wind, GNSS integrity, imagery, air
   * quality): `{value, detail?, at?}`, null where it has none, or undefined
   * for a layer that is not a field (it lists items instead).
   * @param {string} layerId
   * @param {number} lat
   * @param {number} lon
   */
  function valueAt(layerId, lat, lon) {
    const module = layerModule(layerId);
    if (typeof module?.getValueAt !== 'function') return undefined;
    try {
      return module.getValueAt(lat, lon) ?? null;
    } catch {
      return null;
    }
  }

  /** A layer's module, for a panel that works with that layer directly. */
  function layerModule(layerId) {
    try {
      return dataManager()?.layers?.get?.(layerId)?.module ?? null;
    } catch {
      return null;
    }
  }

  /** Per layer, as readLayers keeps it. */
  const nearbyMemo = new Map();
  let nearbyLast = null;
  /**
   * What each layer that is on has within a radius (see nearbyByLayer),
   * remembered per layer as the in-view answer is (readLayers): the centre,
   * the radius and what was asked are the key, with each layer's data
   * revision. The same answer comes back while nothing changed.
   * @param {number} lat
   * @param {number} lon
   * @param {{radiusKm?: number, limit?: number, query?: string, excludeKey?: string, excludeLayers?: string[]}} [options]
   */
  function nearbyLayers(lat, lon, options = {}) {
    void managerVersion.value;
    const dm = dataManager();
    if (!dm || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const { excludeLayers = [], ...asked } = options;
    const rows = enabledRows(dm).filter(
      (row) => !excludeLayers.includes(row.id),
    );
    const layers = rows.map((row) => row.id).join('|');
    const place = `${roundTo(lat, 0.0001)},${roundTo(lon, 0.0001)}`;
    const changed = readLayers(
      nearbyMemo,
      dm,
      rows,
      place,
      JSON.stringify([
        asked.radiusKm,
        asked.limit,
        asked.query || '',
        asked.excludeKey || '',
      ]),
      (one) => nearbyByLayer(one, { lat, lon }, asked)[0] ?? null,
    );
    if (changed || nearbyLast?.layers !== layers)
      nearbyLast = {
        layers,
        lists: rows.map((row) => nearbyMemo.get(row.id)?.value).filter(Boolean),
      };
    return nearbyLast.lists;
  }

  function nearbySelected() {
    return nearbyEntities(dataManager(), card.value);
  }

  /** Whether a card's layer is known to the layer manager and switched off. */
  function layerOff(layerId) {
    const dm = dataManager();
    const id = layerId;
    if (!dm?.isEnabled || !dm.layers?.has?.(id)) return false;
    return dm.isEnabled(id) === false;
  }

  function refresh() {
    const current = card.value;
    if (!current) return;
    // A card does not outlive its layer: turning the layer off (or clearing
    // all layers) closes it and lets go of the camera.
    if (layerOff(current.layerId)) return clear();
    // A closed panel shows nothing, so it reads nothing until it opens.
    if (shell.value?.isOpen && !shell.value.isOpen()) return;
    const next = describeEntity(dataManager(), current.identity);
    // Keep showing the last reading when the item drops out of its feed.
    if (!next || next.key !== current.key || next.basis !== 'record') {
      lost.value = current.basis === 'record';
      away.value = lost.value || !shown(current);
      tick.value++;
      return;
    }
    const wasLost = lost.value;
    card.value = markRaw(next);
    lost.value = false;
    // The camera follows it where it is drawn, which can be ahead of its last
    // reading; one being followed is always in view.
    away.value = !isFollowing() && !shown(next);
    tick.value++;
    if (wasLost) back(next);
  }

  /** Whether the camera shows the item; true when the shell cannot tell. */
  function shown(current) {
    const test = shell.value?.onScreen;
    return typeof test === 'function' ? test(current) !== false : true;
  }

  /**
   * The item is back in its feed: its layer selects it again, as the click
   * that picked it did, and an aircraft just found is followed.
   */
  function back(current) {
    const follows = followWhenBack;
    // A lookup still running is no longer needed: the feed has it.
    stopLocating();
    reference =
      layerOf(current.layerId)?.referenceOf?.(current.identity?.id) ??
      reference;
    shell.value?.reselect?.(current, { follow: follows });
  }

  const layerOf = (layerId) =>
    shell.value?.dataManager?.()?.layers?.get?.(layerId)?.module ?? null;

  /**
   * Take the camera back to the item. One the camera can see or one still in
   * its feed is flown to (an aircraft followed); one out of its feed is
   * looked up at the layer's time (the world clock's while it follows the
   * clock) on its own track, shown there and flown to, and its layer picks
   * it up again once its feed has it.
   * @returns {Promise<void>}
   */
  async function locate() {
    const current = card.value;
    if (!current) return;
    if (!lost.value) {
      if (canFollow()) follow();
      else flyTo();
      return;
    }
    const layer = layerOf(current.layerId);
    if (typeof layer?.locate !== 'function') {
      flyTo();
      return;
    }
    locating?.abort();
    const controller = new AbortController();
    locating = controller;
    finding.value = 'finding';
    let result;
    try {
      result = await layer.locate(current.identity?.id, {
        reference,
        signal: controller.signal,
      });
    } catch {
      result = { status: 'none' };
    }
    if (locating !== controller) return;
    locating = null;
    const now = card.value;
    if (!now || now.key !== current.key) return;
    if (result?.status !== 'found') {
      finding.value = 'none';
      return;
    }
    finding.value = 'idle';
    located.value = markRaw({ ...result });
    card.value = markRaw({
      ...now,
      lat: result.lat,
      lon: result.lon,
      altitudeM: Number.isFinite(result.altitudeM)
        ? result.altitudeM
        : now.altitudeM,
    });
    followWhenBack = canFollow();
    shell.value?.flyTo?.(card.value);
  }

  function stopLocating() {
    locating?.abort();
    locating = null;
    finding.value = 'idle';
    located.value = null;
    followWhenBack = false;
  }

  /**
   * Show an item on the card.
   * @param {object} identity `{layerId, id, label, lat, lon, record?}`
   * @param {object} [options]
   * @param {boolean} [options.fly] Also fly the camera to it.
   * @returns {boolean} Whether a card could be made.
   */
  /**
   * Counts card selections and clears, so a selection that was asked for
   * before a newer one can tell it came too late.
   */
  let generation = 0;
  const selectionGeneration = () => generation;

  /** Things that move are followed as soon as they are picked. */
  const AUTO_FOLLOW = new Set(['flights', 'military', 'satellites']);
  /**
   * The key of the item the camera follows, if any. The shell sets it from
   * the camera's own follow, so it is never claimed before the camera does.
   */
  const following = ref(null);
  /** The item a follow was last asked for, so it is asked once per item. */
  let asked = null;

  /**
   * @param {object} identity
   * @param {{fly?: boolean, follow?: boolean}} [options] `follow: false`
   *   keeps the camera where it is even for an aircraft.
   */
  function select(identity, { fly = false, follow: autoFollow = true } = {}) {
    if (!read(identity)) return false;
    generation++;
    stopLocating();
    away.value = false;
    reference =
      layerOf(identity.layerId)?.referenceOf?.(card.value?.identity?.id) ??
      null;
    clearInterval(timer);
    timer = setInterval(refresh, REFRESH_MS);
    shell.value?.openPanel?.();
    const current = card.value;
    const followNow =
      autoFollow &&
      AUTO_FOLLOW.has(current?.layerId) &&
      shell.value?.canFollow?.(current);
    if (followNow) {
      // Tracking can announce the craft again; following what is already
      // followed would loop, so it only starts once per item.
      if (following.value !== current.key && asked !== current.key) {
        asked = current.key;
        shell.value?.follow?.(current);
      }
    } else {
      asked = null;
      if (fly) shell.value?.flyTo?.(current);
    }
    requestRoute(current?.identity);
    return true;
  }

  function clear() {
    generation++;
    if (following.value) shell.value?.letGo?.(card.value);
    following.value = null;
    asked = null;
    clearInterval(timer);
    timer = null;
    card.value = null;
    lost.value = false;
    away.value = false;
    reference = null;
    stopLocating();
  }

  const flyTo = () => card.value && shell.value?.flyTo?.(card.value);
  const follow = () => {
    if (!card.value) return;
    asked = card.value.key;
    shell.value?.follow?.(card.value);
  };
  const isFollowing = () =>
    Boolean(card.value && following.value === card.value.key);
  const ask = () => card.value && shell.value?.ask?.(card.value);
  /** The regional brief (weather, local news) for a spot, from the shell. */
  const readBrief = (lat, lon, options) =>
    shell.value?.regionalBrief
      ? shell.value.regionalBrief(lat, lon, options)
      : Promise.resolve(null);
  /**
   * A spot's weather alone, `{weather}`, without the brief's place lookup
   * and news search; the brief stands in where the shell has no weather.
   */
  const readWeather = (lat, lon, options) =>
    shell.value?.spotWeather
      ? shell.value.spotWeather(lat, lon, options)
      : readBrief(lat, lon, options);
  const canFollow = () => Boolean(shell.value?.canFollow?.(card.value));
  /** The renderer's card previews (`CardPreviews`), or null without them. */
  const previews = () => shell.value?.previews?.() ?? null;
  /** Loaded items whose name or id matches typed text, for the omnibar. */
  const search = (query, options) =>
    shell.value
      ? searchEntities(dataManager(), query, {
          near: shell.value.here?.() || null,
          ...options,
        })
      : [];

  return {
    card,
    lost,
    tick,
    away,
    finding,
    located,
    locate,
    connect,
    syncDataManager,
    select,
    selectionGeneration,
    clear,
    refresh,
    flyTo,
    follow,
    ask,
    readBrief,
    previews,
    canFollow,
    isFollowing,
    following,
    search,
    nearbyGroups,
    nearbySelected,
    alertsAt,
    liveLayers,
    allLayers,
    managerVersion,
    layerRevision,
    layerModule,
    valueAt,
    nearbyLayers,
    readWeather,
    breakdown,
    view,
    viewMoving,
    setView,
    inspector,
    inspectorRows,
    inspectorPulse,
    viewWeather,
    setViewContextShown,
    readViewContextShown,
    publishInspectorRows,
    pulseInspector,
    publishViewWeather,
    matchesIn,
    sourceOf,
    canCockpit,
    cockpit,
    inView,
    askAboutView,
  };
});

/**
 * Opens what a voice or chat action selected in the Context panel, as a click
 * on it does (`src/ui/entityContextBridge.js` selects the same way): its card
 * opens, and the panel with it. The app hands it to voice, which reads
 * `generation()` when a selection is asked and passes it back as `since`.
 * The action has already selected or followed the item in its own layer, so
 * the card does not follow it again (a click on a flight does not either). A
 * card picked or cleared since the action was asked stays, and nothing opens
 * in Cockpit, where Context is hidden.
 * @param {import('pinia').Pinia} pinia
 * @returns {{generation: () => number, show: (identity: {layerId: string, id: string|number, label?: string, lat?: number, lon?: number}, options?: {since?: number|null, cockpitActive?: boolean}) => boolean}}
 */
export function createContextCardOpener(pinia) {
  const store = () => useEntityCardStore(pinia);
  return {
    generation: () => store().selectionGeneration(),
    show(identity, { since = null, cockpitActive = false } = {}) {
      if (!identity?.layerId || identity.id == null || identity.id === '')
        return false;
      if (cockpitActive) return false;
      if (since !== null && store().selectionGeneration() !== since)
        return false;
      return store().select(
        { ...identity, id: String(identity.id) },
        { follow: false },
      );
    },
  };
}
