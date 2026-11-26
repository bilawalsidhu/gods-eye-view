import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowRef, triggerRef } from 'vue';
import { shownLayerName, layerSourceText } from '../layerNames.js';
import {
  alertsNear,
  describeEntity,
  entityKind,
  formatFact,
  layerBreakdown,
  nearbyByKind,
  nearbyForLayer,
  nearbyEntities,
  layerMatches,
  searchEntities,
  viewSummaryForLayer,
} from '../../data/entityContext.js';
import { formatDate, formatNumber, getLocale, t } from '../../i18n/index.js';

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

/** Minimum wait before refreshing cached moving rows in the in-view answer. */
export const MOVING_REFRESH_MS = 10_000;
/** How often a visible Inspector refreshes. */
export const INSPECTOR_PULSE_MS = 4_000;
// Allow time for the next Inspector pulse to observe an expired Nearby read.
const NEARBY_MOVING_MAX_MS = MOVING_REFRESH_MS - INSPECTOR_PULSE_MS;
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

/** Camera height at which the Inspector switches to its globe layout. */
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
  /** Withhold a sighting's position if the feed lost it or no longer confirms it. */
  const locationWithheld = computed(
    () =>
      Boolean(card.value) &&
      ((lost.value && card.value.layerId === 'wildlife-sightings') ||
        card.value.positionUnconfirmed === true),
  );
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
  const inspectorRows = shallowRef([]);
  const inspectorPulse = ref(0);
  const viewWeather = shallowRef(null);
  let timer = null;

  function setViewContextShown(shown, mountId) {
    if (inspector.value.shown === shown && inspector.value.mountId === mountId)
      return;
    inspector.value = { shown, mountId };
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
      viewportLayers.delete(change.layerId);
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
    viewportLayers.clear();
    inViewSearchLayers.clear();
    nearbyMemo.clear();
    inViewMemo.clear();
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
    if (current.source) {
      if (current.layerId === 'traffic') {
        const words = formatFact('source', current.source)?.words;
        if (typeof words?.text === 'string') return sayWords(words);
      }
      return current.source;
    }
    const dm = shell.value?.dataManager?.();
    const layer = dm?.getAll?.().find((row) => row.id === current.layerId);
    return layerSourceText(layer) || '';
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

  const exactNumber = (n) => (Number.isFinite(n) ? n : 'x');
  function viewKey(where) {
    const rect = where.rect
      ? [where.rect.west, where.rect.south, where.rect.east, where.rect.north]
          .map(exactNumber)
          .join(',')
      : '';
    const eye = where.eye
      ? `${exactNumber(where.eye.lat)},${exactNumber(where.eye.lon)}`
      : '';
    return `${exactNumber(where.center.lat)},${exactNumber(where.center.lon)},${exactNumber(where.heightM)}|${rect}|${eye}`;
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
   * while its key holds: the exact place, the options and the layer's
   * update time, count and optional records revision. A refresh from another
   * layer never rereads it. Moving items (satellites, aircraft)
   * are also read again once their answer expires, since satellites stamp a
   * revision only when new orbits arrive. Wildlife also ages out without a
   * feed revision. Nearby limits the adaptive wait for both cases.
   * While the camera is still moving, a costly layer (its last read over
   * COSTLY_READ_MS) whose revision and options are unchanged keeps its
   * answer for movingWait(costMs) too; a settled view reads it at once.
   * @returns {boolean} Whether any layer's answer changed or went.
   */
  function readLayers(
    cache,
    rows,
    place,
    options,
    readOne,
    maxMovingWait = Infinity,
  ) {
    const now = Date.now();
    const moving = viewMoving.value;
    let changed = false;
    for (const id of cache.keys())
      if (!rows.some((row) => row.id === id)) {
        cache.delete(id);
        changed = true;
      }
    for (const row of rows) {
      const revision = `${row.stats?.lastUpdate ?? ''}:${row.stats?.count ?? ''}:${row.stats?.recordsRevision ?? ''}`;
      const kept = cache.get(row.id);
      const refreshByAge =
        entityKind(row.id).moving || row.id === 'wildlife-sightings';
      const fresh =
        kept &&
        now - kept.at <
          Math.min(
            movingWait(kept.costMs),
            refreshByAge ? maxMovingWait : Infinity,
          );
      const same =
        kept && kept.options === options && kept.revision === revision;
      const samePlace = kept && kept.place === place;
      if (same && (kept.failed || kept.usedFallback)) {
        if (samePlace && now - kept.at < INSPECTOR_PULSE_MS) continue;
      } else if (same) {
        if (samePlace && (fresh || !refreshByAge)) continue;
        if (fresh && moving && kept.costMs > COSTLY_READ_MS) continue;
      }
      const started = globalThis.performance?.now?.() ?? now;
      let value = null;
      let failed = false;
      let usedFallback = false;
      try {
        value = readOne(row, () => {
          usedFallback = true;
        });
      } catch {
        // A host layer can recover without publishing a new data revision.
        // Retry its failed read on a later Inspector pulse.
        failed = true;
      }
      const costMs = (globalThis.performance?.now?.() ?? now) - started;
      cache.set(row.id, {
        place,
        options,
        revision,
        value,
        at: now,
        costMs,
        failed,
        usedFallback,
      });
      changed = true;
    }
    return changed;
  }

  const IN_VIEW_PER_LAYER = 3;
  /** Per layer, as readLayers keeps it. */
  const inViewLayers = new Map();
  const viewportLayers = new Map();
  const inViewSearchLayers = new Map();
  const inViewMemo = new Map();
  /**
   * What the loaded layers have in the current view, by layer, nearest the
   * centre first (`viewSummaryForLayer`). At globe height Context uses the visible
   * hemisphere while the omnibar keeps the viewport bounds.
   *
   * Callers asking for fewer rows get a slice of the shared answer. Search
   * keeps its own per-layer cache keyed by query and limit. Globe search
   * includes unavailable layer reads so Context can report partial results.
   * @param {{perLayer?: number, query?: string, viewport?: boolean}} [options]
   */
  function inView(options = {}) {
    void managerVersion.value;
    const dm = dataManager();
    const where = view.value;
    if (!dm || !where?.center) return [];
    const globe = isGlobeView(where);
    const hemisphere = globe && !options.viewport;
    const query = options.query || '';
    const limit = query
      ? (options.perLayer ?? IN_VIEW_PER_LAYER)
      : IN_VIEW_PER_LAYER;
    const visibleLayers =
      globe && options.viewport ? viewportLayers : inViewLayers;
    const cache = query ? inViewSearchLayers : visibleLayers;
    const rows = liveLayers(dm);
    const layers = rows.map((row) => row.id).join('|');
    const changed = readLayers(
      cache,
      rows,
      viewKey(where),
      JSON.stringify([hemisphere, query, limit, getLocale()]),
      (row, onSnapshotFallback) =>
        viewSummaryForLayer(dm, row, where.rect, where.center, {
          perLayer: limit,
          query,
          shownLayerName,
          hemisphere,
          heightM: where.heightM,
          eye: where.eye,
          throwOnReadError: true,
          onSnapshotFallback,
        }),
    );
    // Layers with the most in view first; ties keep the layer order.
    const sorted = () =>
      rows
        .map(({ id }) => {
          const cached = cache.get(id);
          return query && hemisphere && cached?.failed
            ? { layerId: id, count: null, items: [], readFailed: true }
            : cached?.value;
        })
        .filter(Boolean)
        .sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
    if (query) return sorted();
    let memo = inViewMemo.get(cache);
    if (changed || memo?.layers !== layers) {
      memo = {
        layers,
        full: sorted(),
        sliced: new Map(),
      };
      inViewMemo.set(cache, memo);
    }
    const perLayer = Number.isFinite(options.perLayer)
      ? Math.min(options.perLayer, IN_VIEW_PER_LAYER)
      : IN_VIEW_PER_LAYER;
    if (perLayer >= IN_VIEW_PER_LAYER) return memo.full;
    if (!memo.sliced.has(perLayer))
      memo.sliced.set(
        perLayer,
        memo.full.map((group) => ({
          ...group,
          items: group.items.slice(0, perLayer),
        })),
      );
    return memo.sliced.get(perLayer);
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
  function liveLayers(dm) {
    return allLayers(dm).filter((row) => row.enabled);
  }

  /** Every layer row, on or off (Context's suggested layers). */
  function allLayers(dm) {
    try {
      return (dm ?? dataManager())?.getAll?.() || [];
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
    return nearbyByKind(
      shell.value?.dataManager?.(),
      { lat, lon },
      {
        ...options,
        shownLayerName,
      },
    );
  }

  /**
   * A field layer's value at a point (wind, GNSS integrity, imagery, air
   * quality): `{value, detail?, at?}`, `{value: null, readFailed: true}` if
   * the read throws, null where it has none, or undefined for a non-field.
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
      return { value: null, readFailed: true };
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
   * What each layer that is on has within a radius (see nearbyForLayer),
   * remembered per layer as the in-view answer is (readLayers): the centre,
   * the radius and what was asked are the key, with each layer's data
   * revision. A failed radius read has no count and no selectable items.
   * @param {number} lat
   * @param {number} lon
   * @param {{radiusKm?: number, limit?: number, query?: string, excludeKey?: string, excludeLayers?: string[]}} [options]
   */
  function nearbyLayers(lat, lon, options = {}) {
    void managerVersion.value;
    const dm = dataManager();
    if (!dm || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const { excludeLayers = [], ...asked } = options;
    const rows = liveLayers(dm).filter(
      (row) => !excludeLayers.includes(row.id),
    );
    const layers = rows.map((row) => row.id).join('|');
    const place = `${lat},${lon}`;
    const changed = readLayers(
      nearbyMemo,
      rows,
      place,
      JSON.stringify([
        asked.radiusKm,
        asked.limit,
        asked.query || '',
        asked.excludeKey || '',
        getLocale(),
      ]),
      (row, onSnapshotFallback) =>
        nearbyForLayer(
          dm,
          row,
          { lat, lon },
          {
            ...asked,
            shownLayerName,
            throwOnReadError: true,
            onSnapshotFallback,
          },
        ),
      NEARBY_MOVING_MAX_MS,
    );
    if (changed || nearbyLast?.layers !== layers)
      nearbyLast = {
        layers,
        lists: rows
          .map(({ id }) => {
            const cached = nearbyMemo.get(id);
            return cached?.failed
              ? { layerId: id, count: null, items: [], readFailed: true }
              : cached?.value;
          })
          .filter(Boolean),
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

  function refresh({ forAction = false } = {}) {
    const current = card.value;
    if (!current) return;
    // A card does not outlive its layer: turning the layer off (or clearing
    // all layers) closes it and lets go of the camera.
    if (layerOff(current.layerId)) return clear();
    // Stop polling a closed panel. Omnibar actions still need its current position.
    if (!forAction && shell.value?.isOpen && !shell.value.isOpen()) return;
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

  /**
   * The key of the item the camera follows, if any. The shell sets it from
   * the camera's own follow, so it is never claimed before the camera does.
   */
  const following = ref(null);

  /**
   * Picking an item never follows it, whatever it is: the card's Follow
   * does (src/data/clickSelect.js).
   * @param {object} identity
   * @param {{fly?: boolean}} [options]
   */
  function select(identity, { fly = false } = {}) {
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
    // An explicit pick (a row, a search) is a click on the item: its layer
    // selects and centres it when it can, else the camera flies to it.
    if (fly && !shell.value?.pick?.(current))
      shell.value?.flyTo?.(current, { fromSelection: true });
    requestRoute(current?.identity);
    return true;
  }

  function clear() {
    generation++;
    // Closing the card deselects its item in its layer (the shell checks
    // the item is still the one selected or followed).
    if (card.value) shell.value?.letGo?.(card.value);
    following.value = null;
    clearInterval(timer);
    timer = null;
    card.value = null;
    lost.value = false;
    away.value = false;
    reference = null;
    stopLocating();
  }

  function currentActionCard() {
    // A mount edit can land between the card's regular refreshes.
    if (card.value?.layerId === 'cctv') refresh({ forAction: true });
    return card.value;
  }
  const flyTo = () => currentActionCard() && shell.value?.flyTo?.(card.value);
  const follow = () => {
    if (!card.value) return;
    shell.value?.follow?.(card.value);
  };
  const isFollowing = () =>
    Boolean(card.value && following.value === card.value.key);
  const ask = () => currentActionCard() && shell.value?.ask?.(card.value);
  /** Reads the shell's regional brief for the selected card's weather. */
  const readBrief = (lat, lon, options) =>
    shell.value?.regionalBrief
      ? shell.value.regionalBrief(lat, lon, options)
      : Promise.resolve(null);
  /**
   * The spot-weather payload ({status, retrievedAt, coordinates, weather}).
   * The regional brief stands in when the shell has no weather service.
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
    locationWithheld,
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
 * The action has already selected or followed the item in its own layer;
 * opening the card does not move the camera. A card picked or cleared since
 * the action was asked stays, and nothing opens in Cockpit, where Context is
 * hidden.
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
      return store().select({ ...identity, id: String(identity.id) });
    },
  };
}
