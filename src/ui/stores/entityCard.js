import { defineStore } from 'pinia';
import { markRaw, ref, shallowRef } from 'vue';
import { sourceLabel } from '../layerNames.js';
import {
  alertsNear,
  describeEntity,
  layerBreakdown,
  nearbyByKind,
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
  let timer = null;

  function connect(next) {
    shell.value = next ? markRaw(next) : null;
    if (!next) clear();
  }

  const dataManager = () => shell.value?.dataManager?.() || null;

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

  function setView(next) {
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

  /** What the loaded layers have in the current view, by layer. */
  function inView(options) {
    const dm = shell.value?.dataManager?.();
    if (!dm || !view.value) return [];
    return viewSummary(dm, view.value.rect, view.value.center, options);
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

  /** What is loaded around a ground point, as the card's nearby lists. */
  /** The layers that are on, as the data manager lists them. */
  function liveLayers() {
    const dm = shell.value?.dataManager?.();
    try {
      return (dm?.getAll?.() || []).filter((row) => row.enabled);
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

  function currentActionCard() {
    // A mount edit can land between the card's regular refreshes.
    if (card.value?.layerId === 'cctv') refresh({ forAction: true });
    return card.value;
  }
  const flyTo = () => currentActionCard() && shell.value?.flyTo?.(card.value);
  const follow = () => {
    if (!card.value) return;
    asked = card.value.key;
    shell.value?.follow?.(card.value);
  };
  const isFollowing = () =>
    Boolean(card.value && following.value === card.value.key);
  const ask = () => currentActionCard() && shell.value?.ask?.(card.value);
  /** The regional brief (weather, local news) for a spot, from the shell. */
  const readBrief = (lat, lon) =>
    shell.value?.regionalBrief
      ? shell.value.regionalBrief(lat, lon)
      : Promise.resolve(null);
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
    breakdown,
    view,
    setView,
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
