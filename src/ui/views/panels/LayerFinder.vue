<script>
import { ref as moduleRef } from 'vue';

/** Voice and other callers ask for this event to show every row again. */
export const LAYER_FINDER_CLEAR_EVENT = 'gev:layer-finder-clear';

// The header buttons and the bar under the header are two instances that
// share one finder.
const finder = {
  query: moduleRef(''),
  show: moduleRef('all'),
  searching: moduleRef(false),
  filtering: moduleRef(false),
  // A group's stable key (LayerRows' `data-group`), not its translated name,
  // so a language change keeps the choice.
  category: moduleRef(''),
  categories: moduleRef([]),
  shown: moduleRef(0),
};
</script>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch, computed } from 'vue';
import { msg, t } from '../../../i18n/index.js';

// Search and filter for the Data Layers list. The rows are rendered elsewhere
// (LayerRows), so this works on the list as it stands: it marks rows that
// don't match as filtered out, hides a group heading when none of its rows
// are left, and keeps doing so as rows update.
const props = defineProps({
  /** 'buttons' for the header, 'bar' for the row under it. */
  part: { type: String, default: 'buttons' },
});

const { query, show, searching, filtering, category, categories, shown } =
  finder;

const SHOWS = [
  { id: 'all', label: msg('All layers') },
  { id: 'on', label: msg('On') },
  { id: 'off', label: msg('Off') },
];

const narrowed = computed(
  () =>
    Boolean(query.value.trim()) || show.value !== 'all' || Boolean(category.value),
);
const categoryLabel = computed(
  () => categories.value.find((c) => c.key === category.value)?.label || '',
);

function apply() {
  const list = document.getElementById('data-toggles');
  if (!list) return;
  const q = query.value.trim().toLocaleLowerCase();
  let heading = null;
  let headingHasRows = false;
  let count = 0;
  let group = '';
  const groups = [];
  const close = () =>
    heading?.classList.toggle('is-filtered', !headingHasRows);
  for (const el of list.children) {
    if (el.classList.contains('data-layer-group-heading')) {
      close();
      heading = el;
      headingHasRows = false;
      group = el.dataset.group || el.textContent.trim();
      groups.push({ key: group, label: el.textContent.trim() });
      continue;
    }
    if (!el.classList.contains('data-toggle-row')) continue;
    // The name on screen, in the UI language, and the English name too.
    const name = [el.querySelector('.data-name')?.textContent, el.dataset.layerName]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();
    // On means the layer is enabled, whatever its feed is doing.
    const on = Boolean(
      el.querySelector('.data-toggle-btn')?.classList.contains('active'),
    );
    const match =
      (!q || name.includes(q)) &&
      (show.value === 'all' || (show.value === 'on') === on) &&
      (!category.value || group === category.value);
    el.classList.toggle('is-filtered', !match);
    if (match) {
      headingHasRows = true;
      count++;
    }
  }
  close();
  list.classList.toggle('is-filtering', narrowed.value);
  const same =
    groups.length === categories.value.length &&
    groups.every(
      (g, i) =>
        g.key === categories.value[i].key && g.label === categories.value[i].label,
    );
  if (!same) categories.value = groups;
  // A group that went away takes its filter with it.
  if (category.value && !groups.some((g) => g.key === category.value))
    category.value = '';
  shown.value = count;
}

function clearAll() {
  query.value = '';
  show.value = 'all';
  category.value = '';
  searching.value = false;
  filtering.value = false;
  apply();
}

let observer = null;
let frame = 0;
if (props.part === 'bar') {
  onMounted(() => {
    const list = document.getElementById('data-toggles');
    if (!list) return;
    // Rows repaint many times a second; filter once per frame at most.
    observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        apply();
      });
    });
    observer.observe(list, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-feed-state'],
    });
    apply();
    document.addEventListener(LAYER_FINDER_CLEAR_EVENT, clearAll);
  });
  onBeforeUnmount(() => {
    observer?.disconnect();
    cancelAnimationFrame(frame);
    document.removeEventListener(LAYER_FINDER_CLEAR_EVENT, clearAll);
  });
  watch([query, show, category], apply);
}

const searchBtn = () => document.getElementById('layer-finder-search-btn');
async function toggleSearch() {
  searching.value = !searching.value;
  if (!searching.value) query.value = '';
  await nextTick();
  if (searching.value) document.getElementById('layer-finder-input')?.focus();
}
// Escape in the field closes the search and stays there: it must not also
// fold the panel or leave the cockpit.
async function closeSearch() {
  searching.value = false;
  query.value = '';
  await nextTick();
  searchBtn()?.focus();
}

// The filter is a disclosure of two groups of toggle buttons. Opening it moves
// focus to the chosen option; Escape, or a press outside, closes it and gives
// focus back to its button.
const filterEl = ref(null);
const menuEl = ref(null);
const triggerEl = ref(null);
const options = () => [...(menuEl.value?.querySelectorAll('button') || [])];
async function toggleFilter() {
  filtering.value = !filtering.value;
  if (!filtering.value) return;
  await nextTick();
  const menu = menuEl.value;
  if (!menu) return;
  // Keep the menu inside the panel, which clips what leaves it.
  const panel = menu.closest('.ui-panel, [data-panel-id]');
  const room = panel
    ? panel.getBoundingClientRect().bottom - menu.getBoundingClientRect().top - 8
    : 0;
  menu.style.maxHeight = room > 80 ? `${Math.floor(room)}px` : '';
  (menu.querySelector('[aria-pressed="true"]') || options()[0])?.focus();
}
function closeFilter({ refocus = false } = {}) {
  filtering.value = false;
  if (refocus) triggerEl.value?.focus();
}
function onMenuKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeFilter({ refocus: true });
    return;
  }
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  const edge = { Home: 0, End: -1 }[event.key];
  if (step === undefined && edge === undefined) return;
  event.preventDefault();
  const all = options();
  const at = all.indexOf(document.activeElement);
  const next =
    step !== undefined
      ? all[(at + step + all.length) % all.length]
      : all.at(edge);
  next?.focus();
}
function onOutside(e) {
  if (filtering.value && filterEl.value && !filterEl.value.contains(e.target))
    closeFilter();
}
function pickCategory(key) {
  category.value = category.value === key ? '' : key;
}
if (props.part === 'buttons') {
  onMounted(() => document.addEventListener('pointerdown', onOutside, true));
  onBeforeUnmount(() =>
    document.removeEventListener('pointerdown', onOutside, true),
  );
}
</script>

<template>
  <template v-if="part === 'buttons'">
    <button id="layer-finder-search-btn" type="button" class="layer-finder__btn" :class="{ active: searching || query }" :aria-pressed="String(searching)" :aria-label="t('Search layers')" :title="t('Search layers')" @click="toggleSearch">
      <span class="material-symbols-outlined" aria-hidden="true">search</span>
    </button>
    <span ref="filterEl" class="layer-finder__filter">
      <button ref="triggerEl" type="button" class="layer-finder__btn" :class="{ active: show !== 'all' || category }" :aria-expanded="String(filtering)" aria-controls="layer-finder-menu" :aria-label="t('Filter layers')" :title="t('Filter layers')" @click="toggleFilter">
        <span class="material-symbols-outlined" aria-hidden="true">filter_list</span>
      </button>
      <span v-if="filtering" id="layer-finder-menu" ref="menuEl" class="layer-finder__menu" role="group" :aria-label="t('Filter layers')" @keydown="onMenuKey">
        <span role="group" :aria-label="t('Status')">
          <span class="layer-finder__menu-head" aria-hidden="true">{{ t('Status') }}</span>
          <button v-for="s in SHOWS" :key="s.id" type="button" :aria-pressed="String(show === s.id)" :class="{ active: show === s.id }" @click="show = s.id">
            <span class="material-symbols-outlined" aria-hidden="true">{{ show === s.id ? 'radio_button_checked' : 'radio_button_unchecked' }}</span>{{ t(s.label) }}
          </button>
        </span>
        <span v-if="categories.length" role="group" :aria-label="t('Category')">
          <span class="layer-finder__menu-head" aria-hidden="true">{{ t('Category') }}</span>
          <button v-for="c in categories" :key="c.key" type="button" :aria-pressed="String(category === c.key)" :class="{ active: category === c.key }" @click="pickCategory(c.key)">
            <span class="material-symbols-outlined" aria-hidden="true">{{ category === c.key ? 'radio_button_checked' : 'radio_button_unchecked' }}</span>{{ c.label }}
          </button>
        </span>
      </span>
    </span>
  </template>
  <div v-else-if="searching || narrowed" class="layer-finder__bar">
    <label v-if="searching" class="layer-finder__field">
      <span class="material-symbols-outlined" aria-hidden="true">search</span>
      <input id="layer-finder-input" v-model="query" type="search" :placeholder="t('Search layers…')" :aria-label="t('Search layers')" @keydown.esc.stop.prevent="closeSearch" />
    </label>
    <button v-if="show !== 'all'" type="button" class="layer-finder__chip" @click="show = 'all'">
      {{ show === 'on' ? t('On') : t('Off') }}<span class="material-symbols-outlined" aria-hidden="true">close</span>
    </button>
    <button v-if="category" type="button" class="layer-finder__chip" @click="category = ''">
      {{ categoryLabel }}<span class="material-symbols-outlined" aria-hidden="true">close</span>
    </button>
    <p v-if="narrowed && shown === 0" class="layer-finder__empty" role="status">{{ t('No layers match') }}</p>
  </div>
</template>
