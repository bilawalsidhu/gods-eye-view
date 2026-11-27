import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { t } from '../i18n/index.js';
import { useEntityCardStore } from './stores/entityCard.js';

/** The audio states in which a station is (or is about to be) heard. */
export const RADIO_SOUNDING = Object.freeze([
  'loading',
  'buffering',
  'playing',
]);

/**
 * One station's playback, as every Radio surface says it (the mini player,
 * Context's Now Playing, a pinned tile), read from the layer's one UI
 * state: 'live', 'loading', 'paused', 'lost' (the stream failed) or 'idle'
 * (not the station heard).
 * @param {object|null} ui The layer's UI state.
 * @param {string|null|undefined} id
 */
export function stationPlayback(ui, id) {
  if (!ui || !id || ui.playingStationId !== id) return 'idle';
  if (ui.audioState === 'playing') return 'live';
  if (ui.audioState === 'loading' || ui.audioState === 'buffering')
    return 'loading';
  if (ui.audioState === 'paused') return 'paused';
  if (ui.audioState === 'error') return 'lost';
  return 'idle';
}

export function stationFailureText(ui) {
  return ui?.audioError
    ? t(ui.audioError)
    : t('Broadcaster stream unavailable');
}

/**
 * Pause a station heard, or play it: the one toggle behind every Play and
 * Pause button, so each says and does the same. Playing works with the
 * layer off (playStation). Returns what playStation returned, or the pause.
 */
export function toggleStation(module, ui, id) {
  const state = stationPlayback(ui, id);
  if (state === 'live' || state === 'loading')
    return module?.pause?.({ origin: 'user' });
  return module?.playStation?.(id, { origin: 'user' });
}

/**
 * A station's category as the map's clusters and the tag chips have it
 * (the layer's own classifier, labels and colours): `{id, label, color}`,
 * or null for a station with no tags, so nothing says "Other" for want of
 * a tag.
 * @param {object|null} module The Radio layer module.
 * @param {object|null} ui The layer's UI state.
 * @param {object|null} station
 */
export function stationCategory(module, ui, station) {
  const tags = Array.isArray(station?.tags) ? station.tags.filter(Boolean) : [];
  if (!tags.length || typeof module?.radioStationCategoryId !== 'function')
    return null;
  const id = module.radioStationCategoryId(station);
  const known = (ui?.categories || []).find((category) => category.id === id);
  if (!known?.label) return null;
  return {
    id,
    label: known.label,
    color: known.color || module.radioCategoryColor?.(id) || null,
  };
}

/**
 * The volume, in percent, that unmuting Radio goes back to: the last one
 * heard above zero, shared by every mute button so they agree.
 */
export const radioUnmutePercent = ref(80);

/** The pin key of a radio station. */
export const stationPinKey = (id) => `radio:${id}`;

export function stationPin({ id, name, lat, lon }) {
  return {
    key: stationPinKey(id),
    kind: 'station',
    title: name,
    icon: 'radio',
    identity: { layerId: 'radio', id, label: name, lat, lon },
  };
}

/**
 * The Radio layer, for Context's station list and the mini player: the layer
 * module (the same one the shell drives) and its UI state, kept current by
 * the layer's own subscription. It attaches once the shell connects the
 * layer manager (which happens after the views mount), and again whenever
 * the manager reports a change and the Radio module is not the one attached
 * (a replaced layer). Nothing polls.
 * @returns {{module: import('vue').ShallowRef<object|null>, ui: import('vue').ShallowRef<object|null>}}
 */
export function useRadioLayer() {
  const cards = useEntityCardStore();
  const module = shallowRef(null);
  const ui = shallowRef(null);
  let unsubscribe = null;
  function attach(next) {
    if (next === module.value) return;
    unsubscribe?.();
    unsubscribe = null;
    module.value = next;
    ui.value = null;
    if (typeof next?.subscribe === 'function')
      unsubscribe = next.subscribe((state) => (ui.value = state));
  }
  // Reattach when the manager or its Radio layer is replaced.
  watch(
    () => {
      void cards.managerVersion;
      void cards.layerRevision;
      return cards.layerModule('radio');
    },
    attach,
    { immediate: true },
  );
  onBeforeUnmount(() => {
    unsubscribe?.();
    unsubscribe = null;
  });
  return { module, ui };
}
