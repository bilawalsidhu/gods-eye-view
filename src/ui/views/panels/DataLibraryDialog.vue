<script setup>
import { storeToRefs } from 'pinia';
import { computed, nextTick, useTemplateRef, watch } from 'vue';
import { t, tn } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import UiSelect from '../../kit/UiSelect.js';
import {
  libraryStatTiles,
  libraryThemeOptions,
} from '../../libraryBrowser.js';
import { useDataLibraryStore } from '../../stores/dataLibrary.js';
import DataLibraryCard from './DataLibraryCard.vue';

// DATA LAYERS ▸ Browse data library, as src/ui/libraryBrowser.js presents it.
// A modal `dialog[data-panel-surface]` (docs/panel-surfaces.md): this view
// opens and closes it as the owner says, moves focus (search on open and
// after Remove all, Browse on close) and sends every click and keystroke to
// the owner. All text is translated here, so it follows the locale.
const props = defineProps({ view: { type: Object, required: true } });
const { controls } = storeToRefs(useDataLibraryStore());

const root = useTemplateRef('root');
const search = useTemplateRef('search');

watch(
  () => props.view.open,
  async (open, wasOpen) => {
    await nextTick();
    const dialog = root.value;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal?.();
      search.value?.focus();
      return;
    }
    if (dialog.open) dialog.close();
    // The browser may already have closed it (Escape is not always
    // cancelable); either way focus returns to Browse, unless the viewer
    // has moved it somewhere else meanwhile.
    const active = document.activeElement;
    if (wasOpen && (!active || active === document.body || dialog.contains(active)))
      document.getElementById('data-library-browse')?.focus();
  },
  { immediate: true },
);
watch(
  () => props.view.focusSearch,
  async () => {
    await nextTick();
    if (props.view.open) search.value?.focus();
  },
);

const tiles = computed(() => libraryStatTiles(props.view.summary));
const themes = computed(() => libraryThemeOptions());
const status = computed(() =>
  props.view.ready
    ? t('Showing {shown} of {total}', {
        shown: props.view.shown.length,
        total: props.view.total,
      })
    : t('Checking what this instance serves…'),
);
const resetText = computed(() => {
  const { reset, added } = props.view;
  if (reset.busy) return t('WORKING…');
  return reset.armed
    ? tn(added, 'CONFIRM · REMOVE {count}', 'CONFIRM · REMOVE ALL {count}')
    : t('REMOVE ALL');
});
const resetLabel = computed(() =>
  props.view.reset.armed
    ? t('Confirm: remove every added entry from Data Layers')
    : t('Remove every added entry from Data Layers'),
);
// A click on the backdrop (the dialog box itself, outside its content)
// dismisses, like Escape.
const onDialogClick = (event) => {
  if (event.target === event.currentTarget) controls.value?.close();
};
</script>

<template>
  <dialog
    id="data-library"
    ref="root"
    class="data-library-dialog"
    data-panel-surface
    aria-labelledby="data-library-title"
    aria-describedby="data-library-intro"
    @cancel.prevent="controls?.close()"
    @close="view.open && controls?.close()"
    @click="onDialogClick"
  >
    <header class="data-library-header" data-panel-header>
      <h2 id="data-library-title" class="panel-title panel-surface-title">
        {{ t('DATA LIBRARY') }}
      </h2>
      <UiButton
        class="panel-surface-control data-library-close"
        :label="t('Close data library')"
        :native-title="false"
        @click="controls?.close()"
        >×</UiButton
      >
    </header>
    <div class="data-library-body" data-panel-body>
      <dl class="data-library-stats" :aria-label="t('Data Library at a glance')">
        <div
          v-for="tile in tiles"
          :key="tile.id"
          class="data-library-stat"
          :data-stat="tile.id"
        >
          <dt class="data-library-stat-label">{{ tile.label }}</dt>
          <dd class="data-library-stat-value">{{ tile.value }}</dd>
          <dd class="data-library-stat-detail" :hidden="!tile.detail">
            {{ tile.detail }}
          </dd>
        </div>
      </dl>
      <p id="data-library-intro" class="data-library-intro">
        {{
          t(
            'Live sources beyond the core layers. Each one is fetched from its provider while it is on; nothing is stored in this app. Add one and it appears in Data Layers under Library.',
          )
        }}
      </p>
      <div class="data-library-filters">
        <label class="data-library-field">
          <span>{{ t('Search') }}</span>
          <input
            ref="search"
            class="panel-surface-control"
            type="search"
            autocomplete="off"
            :placeholder="t('Name, provider or country')"
            :value="view.filter.query"
            @input="controls?.setQuery($event.target.value)"
          />
        </label>
        <label class="data-library-field">
          <span>{{ t('Theme') }}</span>
          <UiSelect
            class="panel-surface-control"
            :options="themes"
            :model-value="view.filter.family"
            @update:model-value="controls?.setFamily($event)"
          />
        </label>
        <label class="data-library-check">
          <input
            type="checkbox"
            :checked="view.filter.availableOnly"
            @change="controls?.setAvailableOnly($event.target.checked)"
          />
          <span>{{ t('Only what this instance serves') }}</span>
        </label>
      </div>
      <div class="data-library-toolbar">
        <p class="data-library-status" role="status" aria-live="polite">
          {{ status }}
        </p>
        <UiButton
          class="panel-surface-control data-library-reset"
          :class="{ 'is-armed': view.reset.armed }"
          :hidden="!view.reset.visible"
          :disabled="view.reset.busy"
          :label="resetLabel"
          :native-title="false"
          @click="controls?.reset()"
          >{{ resetText }}</UiButton
        >
      </div>
      <ul class="data-library-list">
        <DataLibraryCard
          v-for="row in view.shown"
          :key="row.entry.id"
          :row="row"
          @add="controls?.add($event)"
          @remove="controls?.remove($event)"
          @zoom="controls?.zoom($event)"
        />
      </ul>
    </div>
  </dialog>
</template>
