import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowRef, triggerRef } from 'vue';
import { layerFeedState } from '../../data/feedState.js';
import { greatCircleKm } from '../../geoDistance.js';
import { isAircraftLayer } from '../../data/aircraftLayerIds.js';
import {
  createInspectorIndexCache,
  expandInspectorBounds,
  inspectorFootprintSpan,
  inspectorGroundDistance,
  inspectorPointBounds,
  inspectorPointRecord,
  inspectorViewScale,
  inspectorViewTier,
} from '../inspectorSpatialIndex.js';
import { STREET_LEVEL_LAYER } from '../streetLevelEvents.js';
import { shownLayerName, layerSourceText } from '../layerNames.js';
import {
  alertsNear,
  describeEntity,
  entityKind,
  formatFact,
  layerBreakdown,
  nearbyForLayer,
  layerRecordsNear,
  nearbyEntities,
  readInspectorSnapshot,
  layerMatches,
  searchEntities,
  viewSummaryForLayer,
} from '../../data/entityContext.js';
import { formatDate, formatNumber, getLocale, t } from '../../i18n/index.js';
import {
  BASES_LAYER,
  describePlace,
  PLACE_LAYER,
  placeIdentity,
  placeKey,
} from '../placeCard.js';

const LOCAL_SCOPE_LAYERS = new Set([
  'earthquakes',
  'weather-cyclones',
  'local-firms',
  'fire-perimeters',
  'air-quality',
  'bikeshare',
  'transit',
  'rail',
  'traffic',
  'wildlife-sightings',
  'shipwrecks',
  'bhote-koshi-2026',
  'bhote-koshi-locator',
  'osm-places',
]);
export const supportsLocalScopes = (id) => LOCAL_SCOPE_LAYERS.has(id);

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
  // Saved receiver coordinates may drive external reads only while the source is enabled.
  function privatePositionWithheld(layerId) {
    if (layerId !== 'local-adsb') return false;
    void managerVersion.value;
    void layerRevision.value;
    const manager = dataManager();
    return (
      !manager?.layers?.has(layerId) || manager.isEnabled?.(layerId) !== true
    );
  }

  /** Whether this card's position is safe to use for location-based reads. */
  const locationWithheld = computed(
    () =>
      Boolean(card.value) &&
      ((card.value.layerId === 'wildlife-sightings' &&
        (lost.value || layerOff('wildlife-sightings'))) ||
        privatePositionWithheld(card.value.layerId) ||
        card.value.positionUnconfirmed === true),
  );

  /** Whether the card was opened from the Pinned tab (it outlives its layer). */
  const fromPin = ref(false);
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
   * `{center: {lat, lon}, rect: {west, south, east, north}, heightM,
   * eye: {lat, lon}, corners: [{lat, lon, edge?: true}] | null, groundM, groundFootprint, pose}`.
   * The pose also records camera orientation.
   */
  const view = shallowRef(null);
  /** Explicit view changes that do not begin as a globe gesture. */
  const viewCommandRevision = ref(0);
  function noteViewCommand() {
    viewCommandRevision.value++;
  }
  /** Whether the last view came from a camera still moving (see setView). */
  const viewMoving = ref(false);
  const scopeTier = shallowRef(null);
  const indexedRevision = ref(0);
  const selectedScopeOwner = shallowRef(null);
  function setSelectedScopeOwner(owner) {
    selectedScopeOwner.value = owner;
    return () => {
      if (selectedScopeOwner.value !== owner) return;
      selectedScopeOwner.value = null;
      if (!readViewContextShown()) scopeIndex.suspend();
    };
  }
  function scopeIsShown() {
    return readViewContextShown() || selectedScopeOwner.value?.() === true;
  }
  const scopeIndex = createInspectorIndexCache({
    shown: () =>
      scopeIsShown() && globalThis.document?.visibilityState !== 'hidden',
    changed: () => indexedRevision.value++,
  });
  const scopedAnswers = new Map();
  const inspector = shallowRef({ shown: false, mountId: null });
  let readInspectorVisibility;
  const inspectorRows = shallowRef([]);
  const inspectorLastLoaded = shallowRef(new Map());
  const inspectorPulse = ref(0);
  const viewWeather = shallowRef(null);
  /**
   * The card an airport was opened from, for the airport card's Back: `{key,
   * identity, title, titleWords, fromNear, viaKey, fromPin}`, where `key` is the airport card's
   * own. One card only; it holds while that airport's card is the one shown.
   */
  const backTo = shallowRef(null);
  let timer = null;

  function setViewContextShown(shown, mountId, readVisibility) {
    readInspectorVisibility = mountId === null ? undefined : readVisibility;
    if (inspector.value.shown === shown && inspector.value.mountId === mountId)
      return;
    inspector.value = { shown, mountId };
    if (!scopeIsShown()) scopeIndex.suspend();
  }

  function readViewContextShown() {
    return inspector.value.shown && (readInspectorVisibility?.() ?? true);
  }

  function publishInspectorRows(rows) {
    if (inspectorRows.value === rows) triggerRef(inspectorRows);
    else inspectorRows.value = rows;

    // Disabled layers can clear their renderer counts. Use the last settled
    // layer row, without asking a provider or treating it as worldwide.
    let loaded = inspectorLastLoaded.value;
    for (const { id, name, enabled, stats } of rows) {
      if (
        !enabled ||
        stats?.loading ||
        stats?.sourceUnavailable ||
        stats?.status === 'unavailable'
      )
        continue;
      const { count, lastUpdate: at } = stats ?? {};
      if (
        !Number.isFinite(count) ||
        count < 0 ||
        !Number.isFinite(at) ||
        at <= 0
      )
        continue;
      if (
        count === 0 &&
        (stats.error || stats.lastError || stats.managerRefreshError)
      )
        continue;
      const known = loaded.get(id);
      if (
        known &&
        (at < known.at || (at === known.at && count === known.count))
      )
        continue;
      const module = layerModule(id);
      if (
        typeof module?.getAnalystRecords !== 'function' ||
        module.supportsAnalystRecords === false
      )
        continue;
      if (loaded === inspectorLastLoaded.value) loaded = new Map(loaded);
      loaded.set(id, { id, name, at, count });
    }
    if (loaded !== inspectorLastLoaded.value)
      inspectorLastLoaded.value = loaded;
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
  const baseCatalogRevision = ref(0);
  let subscription = { manager: null };
  let releaseContextRecord;

  function replaceContextRecordRelease(release) {
    releaseContextRecord?.();
    releaseContextRecord = release;
  }

  /**
   * The last layer a person turned on directly (Data Layers, voice, search),
   * `{layerId, at}`: a list layer's tab shows only for that, never for a
   * restore or a link.
   */
  const lastDirectOn = shallowRef(null);

  function onLayerChange(change) {
    if (
      change?.type === 'params' ||
      change?.type === 'registrations' ||
      (change?.type === 'refresh' && !entityKind(change.layerId).moving) ||
      (change?.type === 'visibility' && change.enabled === false)
    ) {
      inViewLayers.delete(change.layerId);
      viewportLayers.delete(change.layerId);
      inspectorLayers.delete(change.layerId);
      scopeIndex.invalidate(change.layerId);
      const previous = scopedAnswers.get(change.layerId);
      if (change.type === 'refresh' && previous) {
        previous.key = null;
      } else {
        scopedAnswers.delete(change.layerId);
      }
      inViewSearchLayers.delete(change.layerId);
      for (const scope of nearbyScopes) scope.cache.delete(change.layerId);
    }
    if (!change?.layerId || change.layerId === BASES_LAYER)
      baseCatalogRevision.value++;
    layerRevision.value++;
    if (
      change?.type === 'visibility' &&
      change.enabled &&
      (change.origin === 'user' || change.origin === 'voice')
    )
      lastDirectOn.value = { layerId: change.layerId, at: Date.now() };
    else if (
      change?.type === 'visibility' &&
      lastDirectOn.value?.layerId === change.layerId
    )
      lastDirectOn.value = null;
  }

  function listen(manager) {
    if (subscription.manager === manager) return;
    const previous = subscription;
    const next = { manager };
    subscription = next;
    previous.off?.();
    previous.offActivity?.();
    lastDirectOn.value = null;
    inspectorLastLoaded.value = new Map();
    const selected = card.value;
    replaceContextRecordRelease(
      selected &&
        manager?.layers
          ?.get(selected.layerId)
          ?.module?.retainContextRecord?.(selected.identity.id),
    );
    inViewLayers.clear();
    viewportLayers.clear();
    inspectorLayers.clear();
    scopeIndex.retain(new Set());
    scopedAnswers.clear();
    inViewSearchLayers.clear();
    for (const scope of nearbyScopes) {
      scope.cache.clear();
      scope.last = null;
    }
    inViewMemo.clear();
    try {
      next.off = manager?.subscribe?.((change) => {
        if (subscription === next) onLayerChange(change);
      });
      next.offActivity = manager?.subscribeActivity?.(({ type, layerId }) => {
        if (
          subscription !== next ||
          type !== 'registrations' ||
          manager.layers.has(layerId)
        )
          return;
        // Removal retires all answers for this registration, even while
        // Inspector is closed and before the id can be added again.
        onLayerChange({ type, layerId });
        // A disabled layer keeps its last loaded count until it is removed.
        if (!inspectorLastLoaded.value.has(layerId)) return;
        const loaded = new Map(inspectorLastLoaded.value);
        loaded.delete(layerId);
        inspectorLastLoaded.value = loaded;
      });
    } catch {
      // Read the manager even if it cannot send notifications.
    }
    // The manager can first appear during a computed read.
    queueMicrotask(() => {
      if (subscription === next) {
        managerVersion.value++;
        baseCatalogRevision.value++;
      }
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

  /**
   * An item's card model: a place's from the place card (it is no layer's
   * record), anything else's from its layer.
   */
  const describeAny = (identity) =>
    identity?.layerId === PLACE_LAYER
      ? describePlace(identity)
      : describeEntity(dataManager(), identity);

  /** A fresh description of an item, without making it the card (the dock). */
  function describe(identity) {
    try {
      return describeAny(identity) || null;
    } catch {
      return null;
    }
  }

  function read(identity) {
    const next = describeAny(identity);
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
    if (!next?.center) scopeTier.value = null;
    else if (settled || !scopeTier.value) {
      const tier = inspectorViewTier(next, scopeTier.value);
      if (
        scopeTier.value?.globe !== tier.globe ||
        scopeTier.value?.city !== tier.city
      )
        scopeTier.value = tier;
    }
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
  function viewKey(where, corners) {
    const rect = where.rect
      ? [where.rect.west, where.rect.south, where.rect.east, where.rect.north]
          .map(exactNumber)
          .join(',')
      : '';
    const eye = where.eye
      ? `${exactNumber(where.eye.lat)},${exactNumber(where.eye.lon)}`
      : '';
    const footprint =
      corners
        ?.map(
          ({ lat, lon, edge }) =>
            `${exactNumber(lat)},${exactNumber(lon)}${edge ? 'e' : ''}`,
        )
        .join('|') ?? '';
    return `${exactNumber(where.center.lat)},${exactNumber(where.center.lon)},${exactNumber(where.heightM)}|${rect}|${eye}|${footprint}`;
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
   * while its key holds: the exact place, the options
   * and the layer's update time, count and optional records revision. A refresh
   * from another layer never rereads it. Moving items (satellites, aircraft)
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
      const samePlace = kept?.place === place;
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
  const inspectorLayers = new Map();
  const inViewSearchLayers = new Map();
  const inViewMemo = new Map();
  function inspectorScope(where) {
    const rect = where.rect;
    // Whole-world bounds stand in when too few viewport corners hit Earth.
    const wholeGround =
      rect?.west === -180 &&
      rect.east === 180 &&
      rect.south === -90 &&
      rect.north === 90;
    return {
      noGround: where.groundFootprint === false,
      hemisphere: isGlobeView(where) || wholeGround,
    };
  }

  // These sources fetch a view-sized window, so points outside the view
  // cannot be interpreted as the nearest available results farther away.
  const viewLoaded = new Set([
    'ais-live-vessels',
    'transit',
    'rail',
    'bikeshare',
    'military-installations',
    'osm-places',
    'air-quality',
    'gnss-integrity',
    'traffic',
  ]);
  const worldBounds = { west: -180, east: 180, south: -90, north: 90 };

  function inspectorGroup(id, radius, options = {}) {
    void indexedRevision.value;
    void layerRevision.value;
    const version = managerVersion.value;
    if (
      !(options.anchor
        ? selectedScopeOwner.value?.()
        : readViewContextShown()) ||
      globalThis.document?.visibilityState === 'hidden'
    )
      return null;
    const where = options.where ?? view.value;
    const tier = options.tier ?? scopeTier.value;
    const row =
      options.row ??
      allLayers().find((layer) => layer.id === id && layer.enabled);
    if (!where?.center || !tier || !row) return null;
    const module = layerOf(id);
    const selected = options.anchor != null;
    const globe = !selected && tier.globe;
    const local =
      !globe && supportsLocalScopes(id) && !options.query && !options.page;
    // Only a selected item has a radius, around the item. With nothing
    // selected every layer reads In view (Satellites use nearbyLayers).
    const dual = local && selected;
    if (local && !row.stats?.count) {
      const tone = layerFeedState(row.stats);
      if (tone === 'unavailable' || row.stats?.sourceUnavailable)
        return { layerId: id, readFailed: true, count: null, items: [] };
      if (tone === 'loading')
        return { layerId: id, loading: true, count: null, items: [] };
    }
    const anchor = options.anchor ?? where.center;
    const sky = !globe && where.groundFootprint === false;
    const center = sky ? (where.eye ?? where.center) : where.center;
    const scale = inspectorViewScale(where);
    const rect = where.rect ?? worldBounds;
    const aircraft = isAircraftLayer(id);
    // Aircraft keep the unbounded Closest to view they had under the
    // overhead range; other layers look as far as before.
    const closestLimit = aircraft
      ? 20_000
      : Math.min(20_000, Math.max(radius, scale * 3));
    const closest =
      !globe &&
      (!sky || selected) &&
      !viewLoaded.has(id) &&
      typeof module?.getViewRecords !== 'function' &&
      where.rect != null &&
      inspectorFootprintSpan(rect) > 0;
    const nearestOnly =
      !sky && !globe && tier.city && inspectorFootprintSpan(rect) > 4 * scale;
    const revision = JSON.stringify([
      version,
      row.stats?.recordsRevision,
      row.stats?.lastUpdate,
      row.stats?.count,
      options.revision,
    ]);
    const optionsKey = JSON.stringify([
      radius,
      globe,
      sky,
      nearestOnly,
      options.anchor,
      options.excludeKey,
      options.limit,
      options.query,
      options.page,
      getLocale(),
    ]);
    const scopeKey = `${optionsKey}:${viewKey(where, where.corners)}`;
    const key = `${revision}:${scopeKey}`;
    const previous = scopedAnswers.get(id);
    if (previous?.key === key) return previous.value;
    const now = Date.now();
    if (
      viewMoving.value &&
      previous?.key &&
      previous.revision === revision &&
      previous.optionsKey === optionsKey &&
      now - previous.at <
        (previous.costMs > COSTLY_READ_MS ? movingWait(previous.costMs) : 1000)
    )
      return previous.value;
    const started = globalThis.performance?.now?.() ?? now;

    let value;
    const summarizePopulation =
      typeof module?.getContextPopulation === 'function';
    const read =
      options.read ||
      (() =>
        summarizePopulation && !module.getInspectorContextPoints
          ? { points: module.getContextPopulation() }
          : readInspectorSnapshot(dataManager(), id));
    const hasAreaReader =
      typeof module?.getViewRecords === 'function' &&
      typeof module?.getNearbyContextPoints !== 'function' &&
      !options.read &&
      !(globe && id === STREET_LEVEL_LAYER);
    const source = hasAreaReader
      ? null
      : scopeIndex.indexFor(id, revision, read);
    if (source?.failed) {
      scopedAnswers.delete(id);
      return { layerId: id, readFailed: true, count: null, items: [] };
    }
    if (source && !source.ready) {
      // A replacement index builds in slices. Preserve the last settled view
      // until it can publish rows for the same camera, range and query.
      if (
        previous?.scopeKey === scopeKey &&
        previous.value &&
        !previous.value.readFailed
      )
        return previous.value;
      return { layerId: id, loading: true, count: null, items: [] };
    }

    try {
      // A selected item's Nearby is read around the item only.
      const bounds = sky || dual ? [] : [rect];
      if (dual) bounds.push(inspectorPointBounds(anchor, radius));
      const closestKm = closest
        ? selected
          ? (at) => greatCircleKm(anchor, at)
          : inspectorGroundDistance(
              where,
              rect,
              inspectorScope(where).hemisphere,
            )
        : null;
      const scope = {
        radius,
        bounds,
        page: options.page,
        index: source?.index,
        localScopes:
          dual
            ? {
                anchor,
                selected,
                excludeKey: options.excludeKey,
                // Never count the view beside a selected item.
                noGround: true,
              }
            : null,
        collectPopulation: summarizePopulation && !globe,
        nearestOnly,
        isPoint: inspectorPointRecord,
        closestLimit,
        closest: closestKm,
        closestCells:
          closestKm && source
            ? source.index.cellsByDistance(
                [
                  selected
                    ? inspectorPointBounds(anchor, closestLimit)
                    : expandInspectorBounds(rect, closestLimit),
                ],
                closestKm,
              )
            : null,
        ...(source && {
          snapshot: {
            source: source.source,
            points: source.index.points(bounds),
          },
        }),
      };
      const summarize = (optionsForScope) =>
        viewSummaryForLayer(dataManager(), row, rect, center, {
          perLayer: globe ? 3 : (options.limit ?? 3),
          query: options.query,
          shownLayerName,
          breakdown: !globe,
          includeEmpty: true,
          includeDrawnCoverage: true,
          hemisphere: globe || inspectorScope(where).hemisphere,
          clipViewport: !globe,
          heightM: where.heightM,
          eye: where.eye,
          corners: where.corners,
          throwOnReadError: true,
          inspector: optionsForScope,
        });
      if (globe && source && !options.query && source.index.pointOnly) {
        for (const span of [10, 30, 100, 350, 1200]) {
          value = summarize({
            ...scope,
            page: null,
            sampleRadiusKm: span,
            snapshot: {
              source: source.source,
              points: source.index.points([inspectorPointBounds(center, span)]),
            },
          });
          if (
            value.items.length >= 3 ||
            value.items.length === source.index.count
          )
            break;
        }
        if (value.items.length < Math.min(3, source.index.count))
          value = summarize({ ...scope, page: null });
      } else {
        value = summarize(scope);
      }
      if (globe && value) {
        value = {
          ...value,
          count: source?.index.count ?? row.stats?.count ?? value.count,
          scope: 'loaded',
          breakdown:
            previous?.revision === revision && previous.globe
              ? previous.value?.breakdown
              : layerBreakdown(dataManager(), id, {
                  readRecords: source
                    ? () =>
                        Array.from(
                          source.index.points([worldBounds]),
                          (point) =>
                            source.source?.recordForPoint?.(point, false) ??
                            point,
                        )
                    : undefined,
                }),
        };
      }
      if (summarizePopulation && value) {
        const withSummary = (result) => {
          const { population, ...group } = result;
          return {
            ...group,
            summary: module.getContextSummary?.({
              population: globe ? module.getContextPopulation() : population,
            }),
          };
        };
        value = withSummary(value);
      }
    } catch {
      value = { layerId: id, readFailed: true, count: null, items: [] };
    }
    scopedAnswers.set(id, {
      key,
      scopeKey,
      optionsKey,
      value,
      at: now,
      revision,
      globe,
      costMs: (globalThis.performance?.now?.() ?? now) - started,
    });
    return value;
  }

  function inspectorGroups(ids, radius) {
    const enabled = new Map(liveLayers().map((row) => [row.id, row]));
    scopeIndex.retain(enabled);
    for (const id of scopedAnswers.keys())
      if (!enabled.has(id)) scopedAnswers.delete(id);
    return ids.flatMap((id) => {
      const row = enabled.get(id);
      const group = row && inspectorGroup(id, radius, { row });
      return group ? [group] : [];
    });
  }

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
    const inspectorViewport = options.viewport && options.breakdown;
    const scope = inspectorViewport ? inspectorScope(where) : null;
    const rows = liveLayers(dm).filter(
      (row) => !options.excludeLayers?.has(row.id),
    );
    if (scope?.noGround) {
      if (options.query) return [];
      return rows.map(({ id }) => ({
        layerId: id,
        count: null,
        items: [],
        readFailed: true,
      }));
    }
    const globe = isGlobeView(where);
    const hemisphere = inspectorViewport
      ? scope.hemisphere
      : globe && !options.viewport;
    const query = options.query || '';
    const limit = query
      ? (options.perLayer ?? IN_VIEW_PER_LAYER)
      : IN_VIEW_PER_LAYER;
    const visibleLayers =
      globe && options.viewport ? viewportLayers : inViewLayers;
    const cache = query
      ? inViewSearchLayers
      : options.breakdown
        ? inspectorLayers
        : visibleLayers;
    const layers = rows.map((row) => row.id).join('|');
    const corners = inspectorViewport ? where.corners : null;
    const changed = readLayers(
      cache,
      rows,
      viewKey(where, corners),
      JSON.stringify([
        hemisphere,
        query,
        limit,
        !!options.breakdown,
        !!options.includeEmpty,
        !!options.includeDrawnCoverage,
        getLocale(),
      ]),
      (row, onSnapshotFallback) =>
        viewSummaryForLayer(dm, row, where.rect, where.center, {
          perLayer: limit,
          breakdown: options.breakdown,
          includeEmpty: options.includeEmpty,
          includeDrawnCoverage: options.includeDrawnCoverage,
          query,
          shownLayerName,
          hemisphere,
          clipViewport: !!options.viewport,
          heightM: where.heightM,
          eye: where.eye,
          corners,
          throwOnReadError: true,
          onSnapshotFallback,
        }),
    );
    // Layers with the most in view first; ties keep the layer order.
    const sorted = () =>
      rows
        .map(({ id }) => {
          const cached = cache.get(id);
          return (options.includeEmpty || (query && hemisphere)) &&
            cached?.failed
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

  function readLayerItem(layerId, method, id) {
    try {
      return layerModule(layerId)?.[method]?.(id) ?? null;
    } catch {
      return null;
    }
  }

  const cameraFrame = (id) => readLayerItem('cctv', 'frameUrlForCamera', id);
  const cameraDetails = (id) => readLayerItem('cctv', 'cameraDetails', id);
  const satellite = (id) =>
    readLayerItem('satellites', 'describeSatellite', id);

  /** A layer's items within a radius of a point (see layerRecordsNear). */
  function recordsNear(layerId, lat, lon, radiusKm, options) {
    return layerRecordsNear(
      dataManager(),
      layerId,
      { lat, lon },
      radiusKm,
      options,
    );
  }

  // The Inspector reads satellites while an inline camera reads all nearby layers.
  // Each keeps one latest projection per layer, independent of the other reader.
  const nearbyCard = { cache: new Map(), last: null };
  const nearbyFiltered = { cache: new Map(), last: null };
  const nearbyScopes = [nearbyCard, nearbyFiltered];
  /**
   * What each layer that is on has within a radius (see nearbyForLayer),
   * remembered per layer as the in-view answer is (readLayers): the centre,
   * the radius and what was asked are the key, with each layer's data
   * revision. A failed radius read has no count and no selectable items.
   * @param {number} lat
   * @param {number} lon
   * @param {{radiusKm?: number, limit?: number, query?: string, excludeKey?: string, excludeLayers?: string[], onlyLayers?: string[], breakdown?: boolean, overheadRange?: boolean, closestLayers?: string[]}} [options]
   */
  function nearbyLayers(lat, lon, options = {}) {
    void managerVersion.value;
    const dm = dataManager();
    if (!dm || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const { onlyLayers = null, excludeLayers = [], ...asked } = options;
    const scope = onlyLayers ? nearbyFiltered : nearbyCard;
    const rows = liveLayers(dm).filter(
      (row) =>
        (!onlyLayers || onlyLayers.includes(row.id)) &&
        !excludeLayers.includes(row.id),
    );
    const layers = rows.map((row) => row.id).join('|');
    const place = `${lat},${lon}`;
    const changed = readLayers(
      scope.cache,
      rows,
      place,
      JSON.stringify([
        asked.radiusKm,
        asked.limit,
        asked.query || '',
        asked.excludeKey || '',
        asked.breakdown === true,
        asked.overheadRange === true,
        asked.closestLayers?.join('|') ?? '',
        getLocale(),
      ]),
      (row, onSnapshotFallback) =>
        nearbyForLayer(
          dm,
          row,
          { lat, lon },
          {
            ...asked,
            closestFallback: asked.closestLayers?.includes(row.id) === true,
            shownLayerName,
            throwOnReadError: true,
            onSnapshotFallback,
          },
        ),
      NEARBY_MOVING_MAX_MS,
    );
    if (changed || scope.last?.layers !== layers)
      scope.last = {
        layers,
        lists: rows
          .map(({ id }) => {
            const cached = scope.cache.get(id);
            return cached?.failed
              ? { layerId: id, count: null, items: [], readFailed: true }
              : cached?.value;
          })
          .filter(Boolean),
      };
    return scope.last.lists;
  }

  function nearbySelected() {
    return nearbyEntities(dataManager(), card.value);
  }

  /** Whether a card's layer is known to the layer manager and switched off. */
  function layerOff(layerId) {
    // Read in views: depend on the layers changing, not only on the pick.
    void managerVersion.value;
    void layerRevision.value;
    const dm = dataManager();
    const id = layerId;
    if (!dm?.isEnabled || !dm.layers?.has?.(id)) return false;
    return dm.isEnabled(id) === false;
  }

  let openedWhileOff = false;

  function refresh({ forAction = false } = {}) {
    const current = card.value;
    if (!current) return;
    // Ordinary selections end when their layer is switched off. A pin or
    // an explicitly reopened saved location keeps its last reading.
    if (layerOff(current.layerId)) {
      if (!openedWhileOff && !fromPin.value) return clear();
      if (following.value === current.key) {
        shell.value?.letGo?.(current);
        following.value = null;
        asked = null;
      }
      tick.value++;
      return;
    }
    openedWhileOff = false;
    // Places and selected coverage points keep their selected coordinates.
    // A drawn street line is not a photo-history entry to poll for loss.
    if (
      current.layerId === PLACE_LAYER ||
      (current.layerId === STREET_LEVEL_LAYER &&
        current.identity.id.startsWith('near:'))
    ) {
      tick.value++;
      return;
    }
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
    if (wasLost) backInFeed(next);
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
  function backInFeed(current) {
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
    // A Find it request supersedes a place pick still resolving.
    generation.value++;
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
    // A person's Locate, as Fly to: older pending navigation is retired.
    shell.value?.flyTo?.(card.value, { explicit: true });
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
  const AUTO_FOLLOW = new Set(['flights', 'military', 'satellites']);
  const generation = ref(0);
  const selectionGeneration = () => generation.value;

  // Starting a lookup takes priority without replacing the displayed card.
  let deferredPick = 0;
  function claimDeferredPick() {
    const mine = ++deferredPick;
    return () => mine === deferredPick;
  }

  /**
   * The key of the item the camera follows, if any. The shell sets it from
   * the camera's own follow, so it is never claimed before the camera does.
   */
  const following = ref(null);
  let asked = null;

  /**
   * Picking an item never follows it, whatever it is: the card's Follow
   * does (src/data/clickSelect.js).
   * @param {object} identity
   * @param {{fly?: boolean, follow?: boolean, explicit?: boolean, reveal?: boolean, fromPin?: boolean}} [options]
   *   `follow: false` keeps the camera where it is even for an aircraft.
   *   `explicit`: a person's click, so the flight retires older navigation
   *   (a late search cannot take the camera back), as Fly to does.
   *   `reveal: false` leaves Context as it is (open or collapsed).
   *   `fromPin`: opened from the Pinned tab, so the card stays even while
   *   its layer is off.
   */
  function select(
    identity,
    {
      fly = false,
      follow: autoFollow = false,
      explicit = false,
      reveal = true,
      fromPin: pinned = false,
    } = {},
  ) {
    const previous = card.value;
    if (!read(identity)) return false;
    openedWhileOff = layerOff(identity.layerId);
    dismissedKey = null;
    generation.value++;
    // Back belongs to the airport card it was made for.
    if (backTo.value && backTo.value.key !== card.value?.key)
      backTo.value = null;
    fromPin.value = Boolean(pinned);
    stopLocating();
    away.value = false;
    reference =
      layerOf(identity.layerId)?.referenceOf?.(card.value?.identity?.id) ??
      null;
    clearInterval(timer);
    timer = setInterval(refresh, REFRESH_MS);
    replaceContextRecordRelease(
      layerOf(identity.layerId)?.retainContextRecord?.(card.value.identity.id),
    );
    shell.value?.openPanel?.({ reveal });
    if (identity.layerId === STREET_LEVEL_LAYER && (fly || explicit)) {
      const street = layerOf(STREET_LEVEL_LAYER);
      if (street?.settledPhotoId?.() === identity.id)
        void street.openPhoto(identity.id);
    }
    const current = card.value;
    // With its layer off (a pin), nothing moves to follow: fly to where the
    // item was last seen instead.
    const picked = fly && shell.value?.pick?.(current);
    const followNow =
      !picked &&
      autoFollow &&
      AUTO_FOLLOW.has(current?.layerId) &&
      !layerOff(current.layerId) &&
      shell.value?.canFollow?.(current, { auto: true });
    if (followNow) {
      // Tracking can announce the craft again; following what is already
      // followed would loop, so it only starts once per item.
      if (following.value !== current.key && asked !== current.key) {
        asked = current.key;
        shell.value?.follow?.(current);
      }
    } else {
      asked = null;
      // Flying to something that is not followed (an airport opened from a
      // flight's card, say) lets go of what the camera followed first;
      // kept, the follow would pull the camera back on to the old craft, or
      // the one nearest where the flight lands.
      if (fly && following.value && following.value !== current?.key) {
        shell.value?.letGo?.(previous);
        following.value = null;
      }
      if (fly && !picked)
        shell.value?.flyTo?.(current, { explicit, fromSelection: true });
    }
    requestRoute(current?.identity);
    return true;
  }

  /**
   * Move a card on to the next item of the same layer (a street-level
   * photo's next image) without counting a new pick: the selection
   * generation, the refresh timer and Context stay as they are.
   * @param {object} identity
   * @returns {boolean} Whether the card moved.
   */
  function advance(identity) {
    if (!card.value || card.value.layerId !== identity?.layerId) return false;
    if (!read(identity)) return false;
    away.value = false;
    reference =
      layerOf(identity.layerId)?.referenceOf?.(card.value?.identity?.id) ??
      null;
    return true;
  }

  /**
   * Open an item from a list (nearby, pinned): its card, followed where it
   * can be, flown to otherwise. A camera is also made the active one, so its
   * feed shows on the card.
   * @param {object} identity
   * @param {{fromPin?: boolean, follow?: boolean}} [options] `fromPin`:
   *   opened from the Pinned tab, so the card stays even while its layer is
   *   off. `follow: false` keeps the camera where it is even for an aircraft.
   */
  function open(identity, { fromPin: pinned = false, follow = true } = {}) {
    if (identity?.layerId === STREET_LEVEL_LAYER) {
      const replacement = shell.value?.replaceDockedPhoto?.(identity, {
        fromPin: pinned,
      });
      // A dock can handle the request or decline it. Only an inapplicable
      // dock leaves the pick to the ordinary card route.
      if (replacement !== undefined) return replacement;
    }
    if (identity?.layerId === 'cctv' && identity.id) {
      // The card first, so the layer's notice of the pick finds it already
      // showing. The bridge then only brings Context forward. A
      // camera whose layer is off is not made active: that would wake the
      // layer's projection while it is off.
      const previous = card.value;
      if (!select(identity, { fromPin: pinned })) return false;
      const live = !layerOff('cctv');
      if (live && previous?.key && following.value === previous.key) {
        shell.value?.letGo?.(previous);
        following.value = null;
      }
      if (live)
        try {
          dataManager()
            ?.layers?.get?.('cctv')
            ?.module?.selectCamera?.(identity.id);
        } catch {
          // The card still opens; the feed shows once the camera is picked.
        }
      // An off-layer pin keeps its saved framing and never wakes the camera.
      if (live || pinned) shell.value?.flyTo?.(card.value, { explicit: true });
      return true;
    }
    return select(identity, {
      fly: true,
      follow,
      explicit: true,
      fromPin: pinned,
    });
  }

  /**
   * Open an airport's card (the bundled pack's airport), as a search for its
   * code does, flying there. The card it was opened from is kept for Back.
   * @param {object} airport
   * @returns {boolean} Whether the card opened.
   */
  function openAirport(airport, { fromNear = false, viaKey = null } = {}) {
    if (!airport) return false;
    const identity = placeIdentity({ airport });
    const key = placeKey(identity);
    const from = card.value;
    const wasFromPin = fromPin.value;
    if (!open(identity)) return false;
    // Its data is OurAirports': credited wherever its card opens from.
    shell.value?.creditAirports?.();
    // The same airport again keeps its Back.
    if (from?.key === key) return true;
    backTo.value = from
      ? markRaw({
          key,
          identity: from.identity,
          fromNear,
          viaKey,
          title: from.title || '',
          titleWords: from.titleWords || null,
          fromPin: wasFromPin,
        })
      : null;
    return true;
  }

  /** Reopen the card an airport was opened from (see openAirport). */
  function back() {
    const to = backTo.value;
    backTo.value = null;
    if (!to || card.value?.key !== to.key) return false;
    // Back shows the card again and flies to it; following an aircraft
    // again is the reader's Follow, not Back's.
    return open(to.identity, { fromPin: to.fromPin, follow: false });
  }

  /** The key of the card last closed with its × button, until a pick. */
  let dismissedKey = null;
  /** Whether `key` was the card last closed with its × button. */
  const wasDismissed = (key) => Boolean(key) && key === dismissedKey;

  /**
   * @param {{dismiss?: boolean}} [options] `dismiss`: the card's × button
   *   was activated.
   */
  function clear({ dismiss = false } = {}) {
    dismissedKey = dismiss ? (card.value?.key ?? null) : null;
    replaceContextRecordRelease();
    generation.value++;
    backTo.value = null;
    fromPin.value = false;
    if (card.value) shell.value?.letGo?.(card.value);
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

  function currentActionCard() {
    // A mount edit can land between the card's regular refreshes.
    if (card.value?.layerId === 'cctv') refresh({ forAction: true });
    return card.value;
  }
  function flyTo() {
    const current = card.value;
    const target =
      current?.layerId === 'cctv' && layerOff(current.layerId)
        ? current
        : currentActionCard();
    if (!target || !shell.value?.flyTo) return;
    noteViewCommand();
    return shell.value.flyTo(target, { explicit: true });
  }
  /** Fly back to a pinned view: the camera as it was (see setView's pose). */
  const flyToPose = (pose) => shell.value?.flyToPose?.(pose);
  const follow = () => {
    if (!card.value) return;
    shell.value?.follow?.(card.value);
  };
  const isFollowing = () =>
    Boolean(card.value && following.value === card.value.key);
  const ask = (title) =>
    currentActionCard() &&
    shell.value?.ask?.(card.value, title || card.value.title);
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
    locationWithheld,
    privatePositionWithheld,
    tick,
    away,
    finding,
    located,
    locate,
    cancelPendingLocate() {
      if (locating) stopLocating();
    },
    connect,
    syncDataManager,
    select,
    advance,
    wasDismissed,
    selectionGeneration,
    claimDeferredPick,
    open,
    openAirport,
    backTo,
    back,
    clear,
    refresh,
    flyTo,
    follow,
    ask,
    readBrief,
    readWeather,
    previews,
    canFollow,
    isFollowing,
    following,
    search,
    nearbyLayers,
    recordsNear,
    satellite,
    cameraFrame,
    cameraDetails,
    layerModule,
    nearbySelected,
    alertsAt,
    liveLayers,
    allLayers,
    managerVersion,
    layerRevision,
    baseCatalogRevision,
    lastDirectOn,
    valueAt,
    breakdown,
    view,
    viewMoving,
    scopeTier,
    inspectorGroup,
    inspectorGroups,
    viewCommandRevision,
    noteViewCommand,
    setView,
    inspector,
    inspectorRows,
    inspectorLastLoaded,
    inspectorPulse,
    viewWeather,
    setViewContextShown,
    readViewContextShown,
    setSelectedScopeOwner,
    pulseInspector,
    publishInspectorRows,
    publishViewWeather,
    flyToPose,
    matchesIn,
    sourceOf,
    describe,
    layerOff,
    fromPin,
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
