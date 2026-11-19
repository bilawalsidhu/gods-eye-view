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
      tick.value++;
      return;
    }
    card.value = markRaw(next);
    lost.value = false;
    tick.value++;
  }

  /**
   * Show an item on the card.
   * @param {object} identity `{layerId, id, label, lat, lon, record?}`
   * @param {object} [options]
   * @param {boolean} [options.fly] Also fly the camera to it.
   * @returns {boolean} Whether a card could be made.
   */
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
    if (following.value) shell.value?.letGo?.(card.value);
    following.value = null;
    asked = null;
    clearInterval(timer);
    timer = null;
    card.value = null;
    lost.value = false;
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
    connect,
    select,
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
