<script setup>
import { onBeforeUpdate } from 'vue';
import { retainedRowPanelId } from './rowPanelPlacement.js';
import RailChips from '../rail/RailChips.vue';
import RailRowList from '../rail/RailRowList.vue';
import RowPanel from './RowPanel.vue';
import RowRange from './RowRange.vue';
import RowSlider from './RowSlider.vue';
import RowSwitch from './RowSwitch.vue';
import RowText from './RowText.vue';
import UiButton from '../kit/UiButton.vue';
import { vClassToggle } from '../rail/classToggle.js';

// The data layer rows under their group headings. LayerPanel presents every
// value; clicks reach it with the layer id, and it re-reads the live
// descriptor before acting.
const props = defineProps({
  items: { type: Array, required: true },
  filtered: Set,
  onToggle: { type: Function, default: () => {} },
  onChip: { type: Function, default: () => {} },
  onListItem: { type: Function, default: () => {} },
  onSlider: { type: Function, default: () => {} },
  onRange: { type: Function, default: () => {} },
});

function rowPanel(item) {
  return (
    retainedRowPanelId(item.id) ||
    (item.controls?.hidden ? null : item.controls?.panel)
  );
}

// Turning off a layer or losing a provider key can remove the focused control.
onBeforeUpdate(() => {
  const focused = globalThis.document?.activeElement;
  const row = focused?.closest('.data-toggle-controls')?.parentElement;
  if (!row) return;
  const item = props.items.find((entry) => entry.id === row.dataset.layerId);
  const sliderId = focused.dataset.sliderId;
  if (
    item &&
    !props.filtered?.has(item.key) &&
    (!item.controls ||
      item.controls.hidden ||
      (sliderId && sliderId !== item.controls.slider?.id))
  )
    row.querySelector('.data-toggle-btn')?.focus({ preventScroll: true });
});
</script>

<template>
  <template v-for="item in items" :key="item.key"
    ><h3
      v-if="item.heading"
      class="data-layer-group-heading"
      v-class-toggle="{ 'is-filtered': filtered?.has(item.key) }"
      :data-group="item.key"
      >{{ item.heading }}</h3
    ><div
      v-else
      class="data-toggle-row"
      v-class-toggle="{
        'data-toggle-row--count-line': item.count?.countLine,
        'is-filtered': filtered?.has(item.key),
      }"
      :data-layer-id="item.id"
      :data-layer-name="item.englishName"
      :data-library-entry="item.libraryEntry || undefined"
      ><div class="data-toggle-top"
        ><div class="data-toggle-left"
          ><span class="data-icon" aria-hidden="true">{{ item.icon }}</span
          ><RowText class="data-name" :text="item.name" /></div
        ><div class="data-toggle-right"
          ><RowText
            v-if="item.count"
            :class="['data-count', { 'data-count-empty': item.count.empty }]"
            :text="item.count.text"
          /><UiButton
            :class="['data-toggle-btn', item.toggle.classes]"
            :data-feed-state="item.toggle.feedState"
            :aria-disabled="String(item.toggle.ariaDisabled)"
            :aria-busy="String(item.toggle.ariaBusy)"
            :title="item.toggle.title"
            :aria-label="item.toggle.ariaLabel"
            @click="onToggle(item.id)"
            >{{ item.toggle.text }}</UiButton
          ></div
        ></div
      ><RowText tag="div" class="data-toggle-meta" :text="item.meta" /><template
        v-if="item.controls"
        ><div class="data-toggle-controls" :hidden="item.controls.hidden"
          ><RailChips
            :chips="item.controls.chips"
            :on-select="(chip) => onChip(item.id, chip.id)"
          /><RowSwitch
            v-if="item.controls.segmented"
            :segmented="item.controls.segmented"
            :on-select="(optionId) => onChip(item.id, optionId)"
          /><RowSlider
            v-if="item.controls.slider"
            :key="item.controls.slider.id"
            :slider="item.controls.slider"
            :on-input="
              (value) => onSlider(item.id, item.controls.slider.id, value)
            "
          /><RowRange
            v-if="item.controls.range"
            :range="item.controls.range"
            :on-select="
              (end, value) =>
                onRange(item.id, item.controls.range.id, end, value)
            "
          /><span
            v-for="(entry, index) in item.controls.legend"
            :key="index"
            class="data-toggle-legend-item"
            :title="entry.blurb || undefined"
            ><span
              class="data-toggle-legend-swatch"
              :style="{ background: entry.color }"
            ></span
            ><span>{{ entry.text }}</span></span
          ><div
            v-if="item.controls.info"
            class="data-toggle-controls-info"
            :title="item.controls.info.title"
            :hidden="!item.controls.info.text"
            >{{ item.controls.info.text }}</div
          ><div
            v-if="item.controls.alert != null"
            class="data-toggle-controls-info data-toggle-controls-alert"
            role="status"
            >{{ item.controls.alert }}</div
          ></div
        ></template
      ><RowPanel
        v-if="rowPanel(item)"
        :key="`${item.id}:${rowPanel(item)}`"
        :element-id="rowPanel(item)" /><RailRowList
        v-if="item.controls"
        :list="item.controls.list"
        :on-select="(entry) => onListItem(item.id, entry.id)" /></div
  ></template>
</template>
