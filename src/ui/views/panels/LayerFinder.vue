<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t } from '../../../i18n/index.js';

// Search and filter for the Data Layers list. The rows are rendered elsewhere
// (LayerRows), so this works on the list as it stands: it marks rows that
// don't match as filtered out, hides a group heading when none of its rows
// are left, and keeps doing so as rows update.
const props = defineProps({
  /** 'buttons' for the header, 'bar' for the row under it. */
  part: { type: String, default: 'buttons' },
});

const state = globalThis.__gevLayerFinder ??= {
  query: ref(''),
  show: ref('all'),
  searching: ref(false),
  filtering: ref(false),
  category: ref(''),
  categories: ref([]),
};
const { query, show, searching, filtering, category, categories } = state;
const input = ref(null);

const SHOWS = [
  { id: 'all', label: 'All layers' },
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
];

function apply() {
  const list = document.getElementById('data-toggles');
  if (!list) return;
  const q = query.value.trim().toLowerCase();
  let heading = null;
  let headingHasRows = false;
  let shown = 0;
  let group = '';
  const groups = [];
  const close = () => heading?.classList.toggle('is-filtered', !headingHasRows);
  for (const el of list.children) {
    if (el.classList.contains('data-layer-group-heading')) {
      close();
      heading = el;
      headingHasRows = false;
      group = el.textContent.trim();
      groups.push(group);
      continue;
    }
    if (!el.classList.contains('data-toggle-row')) continue;
    const name = `${el.dataset.layerName || ''} ${el.querySelector('.data-toggle-meta')?.textContent || ''}`.toLowerCase();
    const on = (el.querySelector('.data-toggle-btn')?.dataset.feedState || 'off') !== 'off';
    const match =
      (!q || name.includes(q)) &&
      (show.value === 'all' || (show.value === 'on') === on) &&
      (!category.value || group === category.value);
    el.classList.toggle('is-filtered', !match);
    if (match) {
      headingHasRows = true;
      shown++;
    }
  }
  close();
  list.classList.toggle('is-filtering', Boolean(q) || show.value !== 'all' || Boolean(category.value));
  if (groups.join('|') !== categories.value.join('|')) categories.value = groups;
  list.dataset.shown = String(shown);
}

let observer = null;
onMounted(() => {
  if (props.part !== 'bar') return;
  const list = document.getElementById('data-toggles');
  if (!list) return;
  observer = new MutationObserver(() => apply());
  observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-feed-state'] });
  apply();
});
onBeforeUnmount(() => observer?.disconnect());
if (props.part === 'bar') watch([query, show, category], apply);

async function toggleSearch() {
  searching.value = !searching.value;
  if (!searching.value) query.value = '';
  await nextTick();
  if (searching.value) document.getElementById('layer-finder-input')?.focus();
}
function pick(id) {
  show.value = id;
}
function pickCategory(name) {
  category.value = category.value === name ? '' : name;
}
const active = () => show.value !== 'all' || Boolean(category.value);

// The menu stays open while choosing; a click outside it or Esc closes it.
const filterEl = ref(null);
function onOutside(e) {
  if (filtering.value && filterEl.value && !filterEl.value.contains(e.target)) filtering.value = false;
}
function onEsc(e) {
  if (e.key === 'Escape') filtering.value = false;
}
if (props.part === 'buttons') {
  onMounted(() => {
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onEsc);
  });
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onEsc);
  });
}
</script>

<template>
  <template v-if="part === 'buttons'">
    <button type="button" class="layer-finder__btn" :class="{ active: searching || query }" :aria-pressed="String(searching)" :aria-label="t('Search layers')" :title="t('Search layers')" @click="toggleSearch">
      <span class="material-symbols-outlined" aria-hidden="true">search</span>
    </button>
    <span ref="filterEl" class="layer-finder__filter">
      <button type="button" class="layer-finder__btn" :class="{ active: show !== 'all' || category }" :aria-expanded="String(filtering)" :aria-label="t('Filter layers')" :title="t('Filter layers')" @click="filtering = !filtering">
        <span class="material-symbols-outlined" aria-hidden="true">filter_list</span>
      </button>
      <span v-if="filtering" class="layer-finder__menu" role="menu">
        <span class="layer-finder__menu-head">{{ t('Status') }}</span>
        <button v-for="s in SHOWS" :key="s.id" type="button" role="menuitemradio" :aria-checked="String(show === s.id)" :class="{ active: show === s.id }" @click="pick(s.id)">
          <span class="material-symbols-outlined" aria-hidden="true">{{ show === s.id ? 'radio_button_checked' : 'radio_button_unchecked' }}</span>{{ t(s.label) }}
        </button>
        <span v-if="categories.length" class="layer-finder__menu-head">{{ t('Category') }}</span>
        <button v-for="c in categories" :key="c" type="button" role="menuitemradio" :aria-checked="String(category === c)" :class="{ active: category === c }" @click="pickCategory(c)">
          <span class="material-symbols-outlined" aria-hidden="true">{{ category === c ? 'radio_button_checked' : 'radio_button_unchecked' }}</span>{{ c }}
        </button>
      </span>
    </span>
  </template>
  <div v-else-if="searching || active()" class="layer-finder__bar">
    <label v-if="searching" class="layer-finder__field">
      <span class="material-symbols-outlined" aria-hidden="true">search</span>
      <input id="layer-finder-input" ref="input" v-model="query" type="search" :placeholder="t('Search layers…')" :aria-label="t('Search layers')" @keydown.esc="toggleSearch" />
    </label>
    <button v-if="show !== 'all'" type="button" class="layer-finder__chip" @click="show = 'all'">
      {{ show === 'on' ? t('On') : t('Off') }}<span class="material-symbols-outlined" aria-hidden="true">close</span>
    </button>
    <button v-if="category" type="button" class="layer-finder__chip" @click="category = ''">
      {{ category }}<span class="material-symbols-outlined" aria-hidden="true">close</span>
    </button>
  </div>
</template>
