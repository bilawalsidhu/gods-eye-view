<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, computed, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useLayerFinderStore } from '../../stores/layerFinder.js';
import { msg, t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import UiSearchField from '../../kit/UiSearchField.vue';

const props = defineProps({
  /** 'buttons' for the header, 'bar' for the row under it. */
  part: { type: String, default: 'buttons' },
});

const finder = useLayerFinderStore();
const { selection, searching, filtering, categories, shown, narrowed } = storeToRefs(finder);
const emit = defineEmits(['focus-search-field', 'focus-search-button', 'focus-filter-button']);
const searchTrigger = ref(null);
const searchField = ref(null);
const suggestionChip = ref(null);
const SHOWS = [
  { id: 'all', label: msg('All layers') },
  { id: 'on', label: msg('On') },
  { id: 'off', label: msg('Off') },
];

const categoryLabel = computed(
  () => categories.value.find((c) => c.key === selection.value.category)?.label || '',
);
async function toggleSearch() {
  finder.setSearching(!searching.value);
  if (!searching.value) finder.select({ query: '' });
  await nextTick();
  if (searching.value) emit('focus-search-field');
}
// Escape in the field closes the search and stays there: it must not also
// fold the panel or leave the cockpit.
async function closeSearch() {
  finder.setSearching(false);
  finder.select({ query: '' });
  await nextTick();
  emit('focus-search-button');
}

// The filter is a disclosure of two groups of toggle buttons. Opening it moves
// focus to the chosen option; Escape, or a press outside, closes it and gives
// focus back to its button.
const filterEl = ref(null);
const menuEl = ref(null);
const triggerEl = ref(null);
const options = () => [...(menuEl.value?.querySelectorAll('button') || [])];
async function toggleFilter() {
  finder.setFiltering(!filtering.value);
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
  finder.setFiltering(false);
  // The trigger is a UiButton; its root is the button.
  if (refocus) triggerEl.value?.$el?.focus();
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
  finder.select({ category: selection.value.category === key ? '' : key });
}
async function showAllLayers() {
  finder.clearAll();
  await nextTick();
  emit('focus-filter-button');
}
if (props.part === 'buttons') {
  onMounted(() => document.addEventListener('pointerdown', onOutside, true));
  onBeforeUnmount(() =>
    document.removeEventListener('pointerdown', onOutside, true),
  );
} else {
  watch(
    () => selection.value.picked,
    async (picked) => {
      if (!picked.length) return;
      await nextTick();
      if (selection.value.picked === picked) suggestionChip.value?.$el.focus();
    },
    { flush: 'post' },
  );
}
defineExpose({
  focusSearchField: () => searchField.value?.focus(),
  focusSearchButton: () => searchTrigger.value?.$el.focus(),
  focusFilterButton: () => triggerEl.value?.$el.focus(),
});
</script>

<template>
  <template v-if="part === 'buttons'">
    <UiButton ref="searchTrigger" id="layer-finder-search-btn" class="layer-finder__btn" :class="{ active: searching || selection.query }" :pressed="Boolean(searching)" :aria-label="t('Search layers')" :title="t('Search layers')" @click="toggleSearch">
      <UiIcon name="search" :size="null" />
    </UiButton>
    <span ref="filterEl" class="layer-finder__filter">
      <UiButton ref="triggerEl" class="layer-finder__btn" :class="{ active: selection.show !== 'all' || selection.category }" :aria-expanded="String(filtering)" aria-controls="layer-finder-menu" :aria-label="t('Filter layers')" :title="t('Filter layers')" @click="toggleFilter">
        <UiIcon name="filter_list" :size="null" />
      </UiButton>
      <span v-if="filtering" id="layer-finder-menu" ref="menuEl" class="layer-finder__menu" role="group" :aria-label="t('Filter layers')" @keydown="onMenuKey">
        <span role="group" :aria-label="t('Status')">
          <span class="layer-finder__menu-head" aria-hidden="true">{{ t('Status') }}</span>
          <UiButton v-for="s in SHOWS" :key="s.id" :pressed="selection.show === s.id" pressed-class="active" @click="finder.select({ show: s.id })">
            <UiIcon :name="selection.show === s.id ? 'radio_button_checked' : 'radio_button_unchecked'" :size="null" />{{ t(s.label) }}
          </UiButton>
        </span>
        <span v-if="categories.length" role="group" :aria-label="t('Category')">
          <span class="layer-finder__menu-head" aria-hidden="true">{{ t('Category') }}</span>
          <UiButton v-for="c in categories" :key="c.key" :pressed="selection.category === c.key" pressed-class="active" @click="pickCategory(c.key)">
            <UiIcon :name="selection.category === c.key ? 'radio_button_checked' : 'radio_button_unchecked'" :size="null" />{{ c.label }}
          </UiButton>
        </span>
      </span>
    </span>
  </template>
  <div v-else-if="searching || narrowed" class="layer-finder__bar">
    <UiSearchField v-if="searching" ref="searchField" :model-value="selection.query" @update:model-value="finder.select({ query: $event })" tag="label" class="layer-finder__field" input-id="layer-finder-input" :label="t('Search layers')" :placeholder="t('Search layers…')" @escape="(event) => { event.preventDefault(); closeSearch(); }" />
    <UiButton v-if="selection.show !== 'all'" class="layer-finder__chip" @click="finder.select({ show: 'all' })">
      {{ selection.show === 'on' ? t('On') : t('Off') }}<UiIcon name="close" :size="null" />
    </UiButton>
    <UiButton v-if="selection.picked.length" ref="suggestionChip" class="layer-finder__chip" :label="`${t('Suggested')} · ${t('Show all layers')}`" :title="t('Show all layers')" @click="showAllLayers">
      {{ t('Suggested') }}<UiIcon name="close" :size="null" />
    </UiButton>
    <UiButton v-if="selection.category" class="layer-finder__chip" @click="finder.select({ category: '' })">
      {{ categoryLabel }}<UiIcon name="close" :size="null" />
    </UiButton>
    <p v-if="narrowed && shown === 0" class="layer-finder__empty" role="status">{{ t('No layers match') }}</p>
  </div>
</template>
