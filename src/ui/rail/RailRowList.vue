<script setup>
import { onMounted, onUpdated, ref } from 'vue';

// An ordered list whose rows keep their identity, so a focused row stays.
const props = defineProps({
  list: { type: Object, default: null },
  blockId: { type: String, default: undefined },
  onSelect: { type: Function, default: () => {} },
});
const root = ref(null);

const rowClass = (item) =>
  `data-row-list-item${item.disabled ? ' note' : ''}${item.active ? ' active' : ''}${item.current ? ' current' : ''}`;

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
    :data-block-id="blockId"
    :hidden="!list?.items?.length"
    :aria-label="list?.ariaLabel || ''"
    ><li
      v-for="item in list?.items ?? []"
      :key="item.id"
      :data-list-item-id="item.id"
      ><button
        type="button"
        :class="rowClass(item)"
        :data-list-item-id="item.id"
        :disabled="Boolean(item.disabled)"
        :aria-current="item.current ? 'step' : 'false'"
        :aria-pressed="item.active ? 'true' : 'false'"
        :title="String(item.text ?? '')"
        @click="onSelect(item)"
        ><span class="data-row-list-lead">{{ String(item.lead ?? '') }}</span
        ><span class="data-row-list-text">{{
          String(item.text ?? '')
        }}</span></button
      ></li
    ></ol
  >
</template>
