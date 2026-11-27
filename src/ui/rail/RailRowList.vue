<script setup>
import { isolate } from '../../i18n/index.js';
import { onMounted, onUpdated, ref } from 'vue';
import UiButton from '../kit/UiButton.vue';

// An ordered list whose rows keep their identity, so a focused row stays.
const props = defineProps({
  list: { type: Object, default: null },
  blockId: { type: String, default: undefined },
  onSelect: { type: Function, default: () => {} },
});
const root = ref(null);

// A row's colour dot, before its value; an unreadable colour draws none.
const swatchStyle = (item) =>
  /^#[0-9a-f]{6}$/i.test(item.swatch || '')
    ? `background: ${item.swatch}`
    : undefined;

const rowClass = (item) =>
  `data-row-list-item${item.disabled ? ' note' : ''}${item.current ? ' current' : ''}${item.unranked ? ' unranked' : ''}`;

// Follow the flight, but never steal a scroll the reader is making
// themselves: only when the step actually changed.
function followCurrent() {
  const list = root.value;
  if (!list) return;
  const current = props.list?.items?.find((item) => item.current);
  if (!current) {
    delete list.dataset.currentId;
    return;
  }
  if (list.dataset.currentId === current.id) return;
  list.dataset.currentId = current.id;
  [...list.querySelectorAll('.data-row-list-item')]
    .find((button) => button.dataset.listItemId === current.id)
    ?.scrollIntoView?.({ block: 'nearest' });
}
onMounted(followCurrent);
onUpdated(followCurrent);
</script>

<template>
  <ol
    ref="root"
    class="data-row-list ui-scroll"
    :class="{ 'is-single-line': list?.singleLine === true }"
    :data-block-id="blockId"
    :hidden="!list?.items?.length"
    :aria-label="list?.ariaLabel || ''"
    ><li
      v-for="item in list?.items ?? []"
      :key="item.id"
      :data-list-item-id="item.id"
      ><UiButton
        :class="rowClass(item)"
        :data-list-item-id="item.id"
        :disabled="Boolean(item.disabled)"
        :aria-current="item.current ? 'step' : 'false'"
        :pressed="Boolean(item.active)"
        pressed-class="active"
        :title="String(item.title ?? item.text ?? '')"
        @click="onSelect(item)"
        ><span
          v-if="swatchStyle(item)"
          class="data-row-list-swatch"
          aria-hidden="true"
          :style="swatchStyle(item)"
        ></span
        ><span class="data-row-list-lead">{{
          isolate(String(item.lead ?? ''))
        }}</span
        ><span class="data-row-list-text">{{ String(item.text ?? '') }}</span
        ><span v-if="item.note" class="data-row-list-note">{{
          String(item.note)
        }}</span></UiButton
      ></li
    ></ol
  >
</template>
