import { computed, reactive, ref } from 'vue';
import { msg } from '../i18n/index.js';

// The providers of Lists in Context. With two or more on, Lists has a
// sub-tab for each. The readouts stay in Context between tab changes.

/** The lists, in tab order. `label` is the tab's name. */
export const CONTEXT_LISTS = Object.freeze([
  Object.freeze({ id: 'weather', label: msg('Weather') }),
  Object.freeze({ id: 'news', label: msg('News') }),
  Object.freeze({ id: 'recent-imagery', label: msg('Imagery') }),
]);
const LIST_IDS = new Set(CONTEXT_LISTS.map((list) => list.id));

/** Weather readout products in display order. */
export const WEATHER_LIST_LAYERS = Object.freeze([
  'weather-cyclones',
  'wind',
  'weather-radar',
  'weather-satellite',
  'weather-lightning',
  'air-quality',
]);

/** The layers behind each list. */
const LIST_LAYERS = Object.freeze({
  weather: WEATHER_LIST_LAYERS,
  news: ['news'],
  'recent-imagery': ['recent-imagery'],
});

/**
 * The list a layer feeds, or null.
 * @param {string} layerId
 * @returns {?string}
 */
export function listForLayer(layerId) {
  for (const [list, layers] of Object.entries(LIST_LAYERS))
    if (layers.includes(layerId)) return list;
  return null;
}

/**
 * The lists whose layer is on, by id: `{count}` (a number, or null for no
 * count). Their readouts report here as they show and hide.
 */
export const contextListPresence = reactive({});

/**
 * Report whether a list's layer is on.
 * @param {string} id A CONTEXT_LISTS id.
 * @param {?{count?: ?number}} state Null while the layer is off.
 */
export function setContextListPresence(id, state) {
  if (!LIST_IDS.has(id)) return;
  if (!state) {
    const removed = id in contextListPresence;
    if (removed) delete contextListPresence[id];
    const remaining = listsOn(contextListPresence);
    if (!remaining.length) return leaveContextLists();
    if (!removed || !contextListsActive.value || contextListChoice.value !== id)
      return;
    // The shown list went: Lists moves to the next of its sub-tabs, kept
    // selected if the old list comes back quietly.
    contextListChoice.value = remaining[0].id;
    return;
  }
  const count = Number.isFinite(state.count) ? state.count : null;
  // With nothing to count, a short reason says why ("no area"), as a tile
  // says why it holds none.
  const reason = count === null && state.reason ? String(state.reason) : '';
  const known = contextListPresence[id];
  if (known?.count !== count || (known?.reason || '') !== reason)
    contextListPresence[id] = reason ? { count, reason } : { count };
}

/** Whether Context shows its list tab rather than Inspect or Pinned. */
export const contextListsActive = ref(false);
/** The list last asked for; the first list that is on stands in for it. */
export const contextListChoice = ref('');

/**
 * Show a list in Context (once its layer is on, if it is still starting).
 * @param {string} id A CONTEXT_LISTS id.
 */
export function showContextList(id) {
  if (!LIST_IDS.has(id)) return;
  contextListChoice.value = id;
  contextListsActive.value = true;
}

/** Leave the list tab for Inspect or Pinned. */
export function leaveContextLists() {
  contextListsActive.value = false;
}

/**
 * The lists that are on, in tab order, with their counts.
 * @param {Record<string, {count: ?number}>} presence
 * @returns {{id: string, label: string, count: ?number}[]}
 */
export function listsOn(presence) {
  return CONTEXT_LISTS.filter((list) => presence[list.id]).map((list) => ({
    ...list,
    count: presence[list.id].count,
    reason: presence[list.id].reason || '',
  }));
}

/**
 * The list the list tab shows: the one asked for while it is on, else the
 * first that is on; '' with none on.
 * @param {{id: string}[]} lists From listsOn.
 * @param {string} choice
 */
export function shownList(lists, choice) {
  return lists.find((list) => list.id === choice)?.id ?? lists[0]?.id ?? '';
}

/** The list Context's list tab shows, '' while another tab shows. */
export const shownContextList = computed(() =>
  contextListsActive.value
    ? shownList(listsOn(contextListPresence), contextListChoice.value)
    : '',
);

/**
 * Whether Context's list tab shows list `id`; Context itself may be folded.
 * @param {string} id A CONTEXT_LISTS id.
 */
export function contextListShown(id) {
  return shownContextList.value === id;
}

/** For tests: forget every list and choice. */
export function resetContextLists() {
  for (const id of Object.keys(contextListPresence))
    delete contextListPresence[id];
  contextListsActive.value = false;
  contextListChoice.value = '';
}
