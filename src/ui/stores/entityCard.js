import { defineStore } from 'pinia';
import { markRaw, ref, shallowRef } from 'vue';
import { sourceLabel } from '../layerNames.js';
import {
  alertsNear,
  describeEntity,
  layerBreakdown,
  nearbyByKind,
  layerMatches,
  searchEntities,
  viewSummary,
} from '../../data/entityContext.js';

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
    const raw = stats.sourceVerbatim === true && stats.source ? stats.source : sourceLabel(stats.source || layer?.source);
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
    const counts = summary.map((group) => `${group.count} ${group.layerName}`).join(', ');
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
  const AUTO_FOLLOW = new Set(['flights', 'military', 'local-adsb', 'satellites', 'ais-live-vessels']);
  /** The key of the item the camera is following, if any. */
  const following = ref(null);

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
    const followNow = autoFollow && AUTO_FOLLOW.has(current?.layerId) && shell.value?.canFollow?.(current);
    if (followNow) {
      // Tracking can announce the craft again; following what is already
      // followed would loop, so it only starts once per item.
      if (following.value !== current.key) {
        following.value = current.key;
        shell.value?.follow?.(current);
      }
    } else {
      if (following.value && following.value !== current?.key) following.value = null;
      if (fly) shell.value?.flyTo?.(current);
    }
    requestRoute(current?.identity);
    return true;
  }

  function clear() {
    following.value = null;
    clearInterval(timer);
    timer = null;
    card.value = null;
    lost.value = false;
  }

  const flyTo = () => card.value && shell.value?.flyTo?.(card.value);
  const follow = () => {
    if (!card.value) return;
    following.value = card.value.key;
    shell.value?.follow?.(card.value);
  };
  const isFollowing = () => Boolean(card.value && following.value === card.value.key);
  const ask = () => card.value && shell.value?.ask?.(card.value);
  const canFollow = () => Boolean(shell.value?.canFollow?.(card.value));
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
    canFollow,
    isFollowing,
    following,
    search,
    nearbyGroups,
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
